# hearth

A self-hosted streaming chat gateway for Anthropic / OpenAI-compatible LLMs, built around three ideas that most thin API wrappers skip:

1. **Prompt-cache-aware prompt layout** — the system/history is arranged into stable cache breakpoints so that across a back-and-forth chat, you mostly pay *cache reads* (0.1×) instead of re-billing the whole prefix every turn.
2. **Tiered memory with index-then-recall** — long-term memory is injected as a one-line-per-entry *index*, and the model pulls full text on demand via a built-in tool. Cheap by default, precise when it matters.
3. **Built-in agent tools without MCP** — when the gateway and the tools live on the same box you own, the model gets `exec` (shell) and `recall` (memory) executed in-process. MCP is for reaching tools you *don't* own; your own services don't need the socket.

It's the runtime behind a personal assistant. The persona/relationship content has been stripped — what's left is the plumbing.

> ⚠️ **Security**: the `exec` tool runs arbitrary shell commands as the gateway process. This gateway is meant to sit on a private host behind authentication, serving a single trusted user. Do **not** expose it publicly or to untrusted callers.

## Architecture at a glance

```
  client ──▶  server.mjs (HTTP routes, conversation storage)
                  │
                  ▼
              gateway.mjs ── assembles the cached prompt, streams the
                  │          provider response, runs the tool loop,
                  │          auto-compresses context
                  ▼
          memory-gateway.py (:3900) ── vector (ChromaDB) + BM25 (jieba)
                                        + SQLite metadata + FTS5 raw archive
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design: the breakpoint layout, the three-factor ranking formula, the recall flow, and the cost model.

## The cache layout

The prompt is split so that everything volatile sits *after* the last cache breakpoint:

```
[tools]                              ← stable, leads the prefix
[BP1] persona + profiles   cache 1h  ← changes ~never
[BP2] recent context       cache 1h  ← changes ~daily (day-anchored)
[BP3] session summary      cache 1h  ← changes per compression cycle
[...history...]
[BP4] rolling breakpoint   cache 1h  ← on the last history message
[current message + volatile]         ← never cached, re-billed every turn
```

A small heartbeat keeps the prefix warm within the cache TTL while the user is active.

## The three memory tiers

| Tier | Store | What | How it's used |
|------|-------|------|---------------|
| L0 raw | `raw-archive.db` (FTS5) | verbatim text | exact-quote recall (`recall` with `exact=true`) |
| L1 distilled | ChromaDB + SQLite | extracted memory entries | injected as a title-only index; full text via `recall` |
| L2 profile | markdown files | stable facts about the user | injected into BP1 every turn |

Ranking for L1 is semantic × recency × access, gated by a validity window — see the architecture doc.

## Built-in tools

- **`recall`** — searches memory (semantic or verbatim FTS) and returns full entries.
- **`exec`** — runs a shell command on the host. In-process, no MCP round trip.

External tools (things you don't own) can still be attached over MCP via the `mcpServers` setting.

## Running it

These services expect a few paths via environment variables (defaults are repo-relative so it boots out of the box for inspection):

```bash
# chat gateway + storage (Node 18+)
GATEWAY_DATA=./data \
VAULT_JSON=./data/vault.json \
GATEWAY_USER_ID=default-user \
EXEC_CWD=/home/youruser \
node server.mjs                  # listens on :3800

# memory gateway (Python 3.10+)
pip install chromadb jieba fastembed
MEMORY_DIR=./memory \
VAULT_JSON=./data/vault.json \
python3 memory-gateway.py        # listens on :3900
```

| Variable | Used by | Default | What |
|----------|---------|---------|------|
| `GATEWAY_DATA` | server, gateway | `./data` | conversation JSON + settings storage |
| `VAULT_JSON` | gateway, memory-gw | `./data/vault.json` | external vault file (optional) |
| `GATEWAY_USER_ID` | gateway | `default-user` | Anthropic `metadata.user_id` for abuse tracking |
| `EXEC_CWD` | gateway | `process.cwd()` | working directory for the `exec` tool |
| `MEMORY_DIR` | server, memory-gw | `./memory` | SQLite, vectors, profiles, facts |

Provider keys, model, and MCP servers are configured at runtime through `PUT /settings` (or the web UI's settings panel) and stored in `${GATEWAY_DATA}/settings.json` — **not** committed.

The `web/` directory is a static single-page client (vanilla JS, no build step). Serve it behind the same origin as the gateway API. The frontend assumes it's mounted at `/raffaello/chat/` with the API at `/raffaello/chat/api/` — to change this, update `CHAT_API` in `web/state.js` and the corresponding paths in `web/push.js` and `web/memory.js`.

## Layout

```
gateway.mjs          core: prompt assembly, cache layout, streaming proxy,
                     tool loop, cycle compression, built-in tools
server.mjs           HTTP routes: conversations, settings, memory proxy
memory-gateway.py    :3900 memory service (vector + BM25 + FTS + SQLite)
embedding.py         BGE-small-zh embedding function (used by memory-gateway)
web/                 static SPA client
docs/ARCHITECTURE.md full design notes
```

## Status

Extracted from a running personal deployment. It works, but it's opinionated and assumes a single trusted user. Treat it as a reference design and a starting point, not a turnkey product.

## License

MIT — see [LICENSE](LICENSE).
