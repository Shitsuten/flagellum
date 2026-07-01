// ============================================================
//  flagellum — 流式 tool loop
//
//  把 Anthropic 的 SSE 流原样转发给客户端,同时在本端攒出完整的
//  content blocks。模型停在 tool_use 时:内置工具(exec/recall)
//  直接进程内执行,不认识的名字 fall through 到 MCP,把结果塞回
//  对话再发起下一轮,直到模型正常收尾。
// ============================================================

import http from 'http';
import https from 'https';
import { BUILTIN_TOOLS, callBuiltinTool } from './tools.mjs';
import { getMcpTools, callMcpTool } from './mcp.mjs';

const API_ENDPOINT = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1/messages';
const MAX_LOOPS = 10;

function sseHeaders() {
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  };
}

function emit(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }

// ------------------------------------------------------------
//  单轮流式请求:SSE 透传给客户端,同时收集 blocks / stop_reason
// ------------------------------------------------------------

function handleChunk(evt, state, clientRes, line) {
  clientRes.write(line + '\n\n');

  switch (evt.type) {
    case 'message_start':
      state.model = evt.message?.model || '';
      if (evt.message?.usage) state.usage = evt.message.usage;
      break;
    case 'content_block_start':
      state.blockType = evt.content_block?.type || 'text';
      state.blockData = { type: state.blockType };
      if (state.blockType === 'tool_use') {
        state.blockData.id = evt.content_block.id;
        state.blockData.name = evt.content_block.name;
        state.blockData.inputJson = '';
      }
      break;
    case 'content_block_delta': {
      const d = evt.delta || {};
      if (d.type === 'text_delta') {
        state.fullText += d.text || '';
        state.blockData.text = (state.blockData.text || '') + (d.text || '');
      } else if (d.type === 'thinking_delta') {
        state.blockData.thinking = (state.blockData.thinking || '') + (d.thinking || '');
      } else if (d.type === 'signature_delta') {
        state.blockData.signature = (state.blockData.signature || '') + (d.signature || '');
      } else if (d.type === 'input_json_delta') {
        state.blockData.inputJson = (state.blockData.inputJson || '') + (d.partial_json || '');
      }
      break;
    }
    case 'content_block_stop':
      if (state.blockType === 'tool_use' && state.blockData.inputJson) {
        try { state.blockData.input = JSON.parse(state.blockData.inputJson); } catch {}
        delete state.blockData.inputJson;
      }
      state.blocks.push({ ...state.blockData });
      state.blockType = '';
      state.blockData = {};
      break;
    case 'message_delta':
      if (evt.delta) state.stopReason = evt.delta.stop_reason;
      if (evt.usage) state.usage = { ...(state.usage || {}), ...evt.usage };
      break;
  }
}

function streamOnce(body, apiKey, clientRes) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_ENDPOINT);
    const payload = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    };

    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      method: 'POST', hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search, headers
    }, (proxyRes) => {
      if (proxyRes.statusCode !== 200) {
        let errBody = '';
        proxyRes.on('data', c => errBody += c);
        proxyRes.on('end', () => {
          const errMsg = `${proxyRes.statusCode}: ${errBody.slice(0, 500)}`;
          emit(clientRes, { type: 'error', error: { message: errMsg } });
          resolve({ error: errMsg });
        });
        return;
      }

      const state = {
        fullText: '', model: '', usage: null,
        blocks: [], blockType: '', blockData: {}, stopReason: null
      };

      let buffer = '';
      proxyRes.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            handleChunk(JSON.parse(line.slice(6).trim()), state, clientRes, line);
          } catch {}
        }
      });

      proxyRes.on('end', () => {
        if (buffer.startsWith('data: ')) clientRes.write(buffer + '\n\n');
        resolve({ stopReason: state.stopReason, blocks: state.blocks, state });
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ------------------------------------------------------------
//  Tool loop
// ------------------------------------------------------------

export async function handleChat(reqBody, res) {
  const { messages, model, system, max_tokens } = reqBody;
  const apiKey = process.env.ANTHROPIC_API_KEY || '';

  if (!Array.isArray(messages) || !messages.length) {
    res.writeHead(400, sseHeaders());
    res.end('data: {"type":"error","error":{"message":"messages required"}}\n\n');
    return;
  }

  const mcpTools = await getMcpTools();
  const requestBody = {
    model: model || 'claude-sonnet-4-20250514',
    max_tokens: max_tokens || 8192,
    stream: true,
    // 内置工具在前、MCP 在后,顺序固定 —— 工具定义是缓存前缀的开头
    tools: [
      ...BUILTIN_TOOLS,
      ...mcpTools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }))
    ]
  };
  if (system) requestBody.system = system;

  res.writeHead(200, sseHeaders());

  // SSE 保活:工具执行期间(exec 最长 60 秒)流上一个字节都没有,
  // 反向代理的空闲超时会把连接掐掉(nginx 默认 60s、Cloudflare ~100s),
  // 客户端看到的就是 504。空闲守卫:只在静默超过 14 秒时发一帧注释,
  // 保证 ping 永远不会插进一个只透传了一半的 event 中间。
  const origWrite = res.write.bind(res);
  let lastWrite = Date.now();
  res.write = (...a) => { lastWrite = Date.now(); return origWrite(...a); };
  const pingTimer = setInterval(() => {
    if (!res.writableEnded && Date.now() - lastWrite > 14000) res.write(': ping\n\n');
  }, 5000);
  res.once('close', () => clearInterval(pingTimer));

  let loopMessages = [...messages];
  let maxLoops = MAX_LOOPS;

  try {
    while (maxLoops-- > 0) {
      const result = await streamOnce({ ...requestBody, messages: loopMessages }, apiKey, res);
      if (!result || result.error) break;
      if (result.stopReason !== 'tool_use') break;

      const toolUseBlocks = result.blocks.filter(b => b.type === 'tool_use');
      if (!toolUseBlocks.length) break;
      console.log('[tools] executing ' + toolUseBlocks.map(b => b.name).join(', '));

      // 上一轮的 assistant 回合(含 thinking/text/tool_use)原样进历史
      loopMessages.push({
        role: 'assistant',
        content: result.blocks.map(b => {
          if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
          if (b.type === 'thinking') { const d = { type: 'thinking', thinking: b.thinking || '' }; if (b.signature) d.signature = b.signature; return d; }
          return { type: 'text', text: b.text || '' };
        })
      });

      const toolResults = [];
      for (const tub of toolUseBlocks) {
        // 先试内置工具,返回 null 说明不是我们的名字 → MCP
        const builtinResult = await callBuiltinTool(tub.name, tub.input);
        const resultText = builtinResult !== null ? builtinResult : await callMcpTool(tub.name, tub.input, mcpTools);
        toolResults.push({ type: 'tool_result', tool_use_id: tub.id, content: resultText });
        // 自定义 SSE 事件,客户端可以实时渲染工具结果
        // (按 Anthropic 格式解析的客户端会忽略未知事件类型)
        emit(res, {
          type: 'gateway_tool_result',
          tool_use_id: tub.id,
          name: tub.name,
          input: tub.input || {},
          content: resultText.slice(0, 600)
        });
        console.log('[tools] ' + tub.name + ' -> ' + resultText.slice(0, 100));
      }
      loopMessages.push({ role: 'user', content: toolResults });
    }
  } catch (e) {
    console.error('[tools] loop error:', e.message);
    emit(res, { type: 'error', error: { message: e.message || 'tool loop error' } });
  }

  res.end();
}
