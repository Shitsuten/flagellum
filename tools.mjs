// ============================================================
//  内置工具 — 进程内执行,不经过 MCP 协议。
//
//  注意:工具定义排在 prompt 前缀最前面,必须保持字节级稳定
//  (任何改动都会打破 prompt cache 前缀)。
// ============================================================

import { exec as execShell } from 'child_process';

// recall 代理到本地记忆服务(接口约定见 README),不存在时优雅降级
const MEMORY_URL = process.env.MEMORY_URL || 'http://127.0.0.1:3900';

export const BUILTIN_TOOLS = [{
  name: 'exec',
  description: 'Run a shell command on the host this gateway lives on. Returns stdout and stderr. 60s timeout; use nohup for long jobs. SECURITY: enables arbitrary command execution as the gateway process — only expose on a private, authenticated gateway.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'shell command' }
    },
    required: ['command']
  }
}, {
  name: 'recall',
  description: 'Search long-term memory and return full entries. <memory_index> in the prompt lists titles of memories related to the current topic — use this to pull the full text of an indexed entry, or to search beyond the index. exact=true does verbatim full-text search (good for an exact past quote; needs 3+ chars).',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'search terms, natural language or keywords' },
      exact: { type: 'boolean', description: 'true = verbatim full-text (FTS); omit for semantic search' }
    },
    required: ['query']
  }
}];

// 返回工具结果字符串;名字不认识时返回 null,由调用方 fall through 到 MCP
export async function callBuiltinTool(name, input) {
  if (name === 'exec') {
    const cmd = (input?.command || '').trim();
    if (!cmd) return '(empty command)';
    return new Promise(resolve => {
      execShell(cmd, { timeout: 60000, maxBuffer: 1024 * 1024, cwd: process.env.EXEC_CWD || process.cwd() }, (err, stdout, stderr) => {
        let out = (stdout || '') + (stderr ? '\n[stderr] ' + stderr : '');
        if (err && !out) out = 'error: ' + err.message;
        else if (err?.killed) out += '\n[killed: 60s timeout]';
        if (out.length > 8000) out = out.slice(0, 8000) + '\n…(truncated)';
        resolve(out.trim() || '(no output)');
      });
    });
  }
  if (name !== 'recall') return null;  // not ours — fall through to MCP
  try {
    const q = (input?.query || '').trim();
    if (!q) return '(empty query)';
    if (input?.exact) {
      const r = await fetch(MEMORY_URL + '/raw-search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, n: 6 }),
        signal: AbortSignal.timeout(10000)
      });
      const d = await r.json();
      if (!d.results?.length) return '原文检索无结果。提示:逐字匹配整个短语、至少3个字;可换更短的词组,或去掉exact用语义检索。';
      return d.results.map(x => `[${x.date || '?'} ${x.source || ''} ${x.role || ''}] ${x.content}`).join('\n---\n');
    }
    // 超时降级:记忆服务忙的时候(单线程实现/批量导入)别让一次 recall
    // 拖死整个 tool loop —— catch 里会变成一条报错字符串还给模型
    const r = await fetch(MEMORY_URL + '/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, n: 5 }),
      signal: AbortSignal.timeout(10000)
    });
    const d = await r.json();
    if (!d.results?.length) return '没有找到相关记忆';
    return d.results.map(x => `[${x.metadata?.date || '?'} ${x.metadata?.category || ''}] ${x.document}`).join('\n---\n');
  } catch (e) {
    return 'recall失败: ' + e.message;
  }
}
