# Architecture

Two services. **`:3800` owns the conversation, `:3900` owns memory.** The chat gateway assembles prompts, proxies the stream, and controls caching; the memory gateway stores, searches, and selects memories. The former asks the latter whenever it needs memory.

```
              client
                │  POST /gateway/send
                ▼
        ┌───────────────────────────────┐
        │ :3800  chat-api               │
        │  server.mjs  — HTTP routes,   │
        │      conversation storage     │
        │  gateway.mjs — prompt assembly,│
        │      BP cache layout, stream  │
        │      proxy, tool loop, cycle  │
        │      compression, builtin     │
        │      tools (exec, recall)     │
        └───────────────┬───────────────┘
                        │ POST /inject, /search, /raw-search
                        ▼
        ┌───────────────────────────────┐
        │ :3900  memory-gateway.py      │
        │  ChromaDB vectors + jieba BM25 │
        │  + SQLite metadata + FTS5 raw  │
        └───────────────────────────────┘
```

## Three-tier memory model (L0 → L2, increasingly distilled)

| Tier | Store | What it is | How it's used |
|------|-------|-----------|---------------|
| **L0 raw** | `raw-archive.db` (FTS5, trigram) | verbatim conversation + source text | `POST /raw-search` for exact recall ("what were the exact words") |
| **L1 distilled** | ChromaDB (`vectors/`) + SQLite (`meta.db`) | memory entries extracted from conversations | semantic recall at `/inject`; injected as an index |
| **L2 profile** | markdown files | hand-maintained stable facts about the user | injected into BP1 every message |

Background jobs settle data downward: an extractor distills conversations into L1; a sync job folds an external vault into L1; an FTS builder indexes everything into L0.

## How memory is spent — three price tiers

This is the core cost idea ("index the cue cards, fetch the contents yourself"):

- **Identity** (L2 profiles) → injected full-text into BP1, near-free after caching.
- **Episodic index** → `/inject` returns only a `<memory_index>`, one title line per hit (does **not** count as access).
- **Actual recall** → the gateway's built-in `recall` tool, executed in-process against `/search` and `/raw-search` (`exact=true` uses the raw FTS path). Only a real recall bumps `access_count` / `recall_log`. Each recall ≈ one cache-hit round trip.

## A message's journey

1. client → `POST :3800/gateway/send`
2. `gateway.mjs` takes the last few user messages as context → `POST :3900/inject`
3. `:3900` returns `static` (L2 profiles, stable) + `dynamic` (facts + L1 index, query-dependent)
4. assemble the prompt (cache layout below) → stream to Anthropic / OpenAI-compat
5. persist the assistant reply; if it contains `<mem>` tags, extract them into L1
6. `checkCycle`: if the window exceeds the token threshold, summarize and advance the `cycleStart` anchor (raw messages are not deleted)

## Prompt cache layout (the core of cost control)

```
[tools]                              ← leads the prefix; a flaky MCP server that
                                       shrinks this list busts the whole cache, so
                                       there's a last-known-good fallback
[BP1] persona + L2 profiles  cache 1h  changes: ~never
[BP2] recent context         cache 1h  changes: ~daily (day-anchored)
[BP3] session summary        cache 1h  changes: per compression cycle
[...history, from cycleStart...]
[BP4] rolling breakpoint     cache 1h  on the last history user message
[current message: volatile (time + dynamic memory) + body]   never cached
```

Design principle: **everything that changes is pushed past BP4.** Each message only re-bills the increment. A heartbeat keeps the prefix warm (only while the user is recently active) within the 1h TTL.

Inspect via `GET :3800/gateway/stats` (hit rate) and `GET :3800/gateway/context?conv=ID` (per-BP contents).

## L1 ranking formula

```
score = (0.70·vector + 0.30·BM25)
        × (0.7 + 0.3·e^(-age_days / 60))
        × (1 + 0.05·ln(1 + access_count))
        × validity_window
```

Semantic × recency × access boost, gated by a validity window. The distance filter is relative: keep hits within 0.15 of the best, hard junk line at 0.65. Heat / tier / energy signals exist as columns but are frozen out of ranking.

## Tools: built-in vs MCP

The gateway is a small agent runtime. For tools you own, it executes in-process:

- **`recall`** — direct fetch to `:3900` for memory (semantic or verbatim FTS).
- **`exec`** — `child_process` runs a shell command directly. Equivalent to a coding agent's Bash tool; the executor is local.

MCP is reserved for **external** capabilities — tools provided by someone else, or your own services that must also serve clients you don't control (a hosted assistant reaching your box, etc.). When you own both ends, the in-process path is faster and removes the "flaky server busts the cache" failure mode.

The model can't tell the difference: to it, both are just entries in the `tools` array. The only thing that changes between built-in and MCP is what the gateway does *after* receiving a `tool_use` block. The decision-loop round trip itself (model says "I want to search" → gateway executes → result fed back → model continues) is inherent to tool use and independent of MCP.

## File map

```
gateway.mjs            prompt assembly, cache layout, streaming proxy,
                       tool loop, cycle compression, built-in tools
server.mjs             HTTP routes (conversation CRUD, settings, memory proxy)
memory-gateway.py      :3900 memory service
  meta.db              L1 metadata (SQLite)     vectors/   L1 vectors (ChromaDB)
  raw-archive.db       L0 full-text index (FTS5)
  profile/  facts/     L2 profile tier
web/                   static SPA client
```
