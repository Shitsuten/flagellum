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
// ============================================================
//  exec 安全层 (2026-06-14)
//
//  如果你用的是中转站(非直连 Anthropic),exec 的命令和输出都经过
//  第三方明文可见。以下措施分三层:
//
//  1. 用户隔离 — EXEC_USER 指定一个低权限沙箱用户,跑 sudo -u
//     这个用户读不了你的 ~/.ssh/、密钥、网关源码
//  2. 命令黑名单 — 拦截 rm -r、dd、shutdown 等破坏性命令
//  3. 输出脱敏 — IP/路径/密钥/SSH配置自动替换
//
//  最安全的做法是不用 exec,把服务拆成独立 MCP 工具。
//  次安全是用 exec + 以下三层防护。
//  不管哪种,网关层都应该加输出脱敏正则兜底。
// ============================================================

const EXEC_USER = process.env.EXEC_USER || '';  // 空 = 不降权(危险),建议设为沙箱用户名

const BLOCKED_CMD = /^\s*(rm\s+-r|dd\s+if=|mkfs|shutdown|reboot|passwd|chmod\s+777|iptables\s+-[FXD]|>\s*\/etc)/i;
const SSH_DANGER = /ssh\s+\S+\s+.*(rm\s+-r|dd\s+if|mkfs|shutdown|reboot|passwd|chmod\s+777|iptables\s+-[FXD]|>\s*\/etc)/i;
const SELF_PROTECT = /gateway\.mjs|server\.mjs|tools\.mjs|sanitize|callBuiltin/i;
const WRITE_CMD = /(sed|vim?|nano|echo.*>|tee|cp|mv|rm|cat.*>|truncate|dd)/i;

function sanitizeOutput(text) {
  return text
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[IP]')
    .replace(/\/home\/\w+/g, '/home/[USER]')
    .replace(/\/root/g, '/[ROOT]')
    .replace(/.ssh\/[^\s]+/g, '.ssh/[REDACTED]')
    .replace(/\b(sk|wrk|key|token|secret|password|passwd)[-_][A-Za-z0-9_-]{8,}\b/gi, '[KEY]')
    .replace(/[A-Z_]{3,}=["']?[^\s"']{8,}["']?/g, '[ENV_VAR]')
    .replace(/HostName\s+\S+/g, 'HostName [REDACTED]')
    .replace(/User\s+\w+/g, 'User [REDACTED]')
    .replace(/IdentityFile\s+\S+/g, 'IdentityFile [REDACTED]');
}

export async function callBuiltinTool(name, input) {
  if (name === 'exec') {
    const cmd = (input?.command || '').trim();
    if (!cmd) return '(empty command)';
    if (BLOCKED_CMD.test(cmd) || SSH_DANGER.test(cmd)) {
      console.warn('[exec-guard] BLOCKED:', cmd.slice(0, 200));
      return '[blocked] 危险命令被拦截。';
    }
    if (SELF_PROTECT.test(cmd) && WRITE_CMD.test(cmd)) {
      console.warn('[exec-guard] SELF-PROTECT:', cmd.slice(0, 200));
      return '[blocked] 不允许修改网关核心文件。';
    }
    const prefix = EXEC_USER ? `sudo -u ${EXEC_USER} ` : '';
    return new Promise(resolve => {
      execShell(prefix + cmd, { timeout: 60000, maxBuffer: 1024 * 1024, cwd: process.env.EXEC_CWD || '/tmp' }, (err, stdout, stderr) => {
        let out = (stdout || '') + (stderr ? '\n[stderr] ' + stderr : '');
        if (err && !out) out = 'error: ' + err.message;
        else if (err?.killed) out += '\n[killed: 60s timeout]';
        if (out.length > 8000) out = out.slice(0, 8000) + '\n…(truncated)';
        resolve(sanitizeOutput(out.trim() || '(no output)'));
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
