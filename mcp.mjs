// ============================================================
//  最小 MCP 客户端 — 内置工具的 fall-through 路径。
//  模型调了一个内置工具不认识的名字时,才会走到这里。
// ============================================================

let mcpToolCache = null;
let mcpToolCacheTime = 0;

// MCP_SERVERS:每行一个 streamable-http 端点 URL
export async function getMcpTools() {
  if (mcpToolCache && Date.now() - mcpToolCacheTime < 300000) return mcpToolCache;
  const urls = (process.env.MCP_SERVERS || '').split('\n').filter(u => u.trim());
  if (!urls.length) { mcpToolCache = []; mcpToolCacheTime = Date.now(); return []; }

  const tools = [];
  for (const rawUrl of urls) {
    const url = rawUrl.trim();
    try {
      const initRes = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'flagellum', version: '1.0' } } })
      });
      if (!initRes.ok || !(initRes.headers.get('content-type') || '').includes('application/json')) continue;

      await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) });

      const toolsRes = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
      const toolsData = await toolsRes.json();
      for (const t of (toolsData.result?.tools || [])) {
        tools.push({ name: t.name, description: t.description || '', input_schema: t.inputSchema || { type: 'object', properties: {} }, _url: url });
      }
    } catch (e) { console.warn('[mcp] connect failed:', url, e.message); }
  }
  mcpToolCache = tools;
  mcpToolCacheTime = Date.now();
  return tools;
}

export async function callMcpTool(name, input, tools) {
  const tool = tools.find(t => t.name === name);
  if (!tool) return 'Tool not found: ' + name;
  try {
    const res = await fetch(tool._url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: input } })
    });
    const data = await res.json();
    if (data.error) return 'Error: ' + (data.error.message || JSON.stringify(data.error));
    return (data.result?.content || []).map(c => c.text || JSON.stringify(c)).join('\n') || 'OK';
  } catch (e) { return 'MCP error: ' + e.message; }
}
