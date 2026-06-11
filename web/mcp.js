// ============================================================
//  MCP — Server List UI
// ============================================================
function renderMcpList() {
  const list = document.getElementById('mcpList'); if(!list) return; list.innerHTML='';
  const urls = (config.mcpServers||'').split('\n').filter(u=>u.trim());
  if (!urls.length) return;
  urls.forEach((url,i) => {
    const entry = document.createElement('div'); entry.className='mcp-entry';
    entry.innerHTML = `<div class="mcp-status" id="mcp-s-${i}"></div><input value="${escapeHtml(url.trim())}" placeholder="https://..."><button onclick="testMcpEntry(${i})">test</button><button onclick="removeMcpEntry(${i})">✕</button>`;
    list.appendChild(entry);
  });
}
function addMcpEntry() {
  const list = document.getElementById('mcpList');
  const i = list.children.length;
  const entry = document.createElement('div'); entry.className='mcp-entry';
  entry.innerHTML = `<div class="mcp-status" id="mcp-s-${i}"></div><input value="" placeholder="https://example.com/mcp/sse"><button onclick="testMcpEntry(${i})">test</button><button onclick="removeMcpEntry(${i})">✕</button>`;
  list.appendChild(entry); entry.querySelector('input').focus();
}
function removeMcpEntry(i) { const list=document.getElementById('mcpList'); if(list.children[i]) list.children[i].remove(); }
function getMcpUrlsFromList() {
  const list = document.getElementById('mcpList'); if(!list) return config.mcpServers||'';
  return Array.from(list.querySelectorAll('input')).map(inp=>inp.value.trim()).filter(Boolean).join('\n');
}
async function testMcpEntry(i) {
  const list = document.getElementById('mcpList');
  const input = list.children[i]?.querySelector('input'); if(!input) return;
  const status = document.getElementById('mcp-s-'+i); if(status) { status.className='mcp-status loading'; }
  try { const r = await connectMcp(input.value.trim()); if(status) status.className='mcp-status ok'; }
  catch(e) { if(status) status.className='mcp-status fail'; console.warn('MCP test fail:',e); }
}


// ============================================================
//  MCP — Connection & Tool Execution
// ============================================================
async function initMcpServers() {
  mcpConnections.forEach(es => es.close());
  mcpConnections = [];
  allMcpTools = [];
  const urls = (config.mcpServers||'').split('\n').filter(u=>u.trim());
  for (const url of urls) {
    try { const r = await connectMcp(url.trim()); allMcpTools.push(...r.tools); }
    catch(e) { console.warn('MCP connect failed:', url, e); }
  }
  updateHeader();
}

function connectMcp(sseUrl) {
  return new Promise((resolve, reject) => {
    let sessionUrl;
    const es = new EventSource(sseUrl);
    es.addEventListener('endpoint', async (e) => {
      const sseBase = sseUrl.replace(/\/[^/]*$/, '/');
      const endpointFile = e.data.split('/').pop();
      const messageUrl = sseBase + endpointFile;
      mcpConnections.push(es);
      mcpAttachListener(es);
      // Test: try direct POST to SSE URL (Streamable HTTP)
      let useDirectPost = false;
      try {
        const testRes = await fetch(sseUrl, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({jsonrpc:'2.0',id:0,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'raffaello-chat',version:'1.0'}}}) });
        if (testRes.ok) { const ct=testRes.headers.get('content-type')||''; if(ct.includes('application/json')) useDirectPost=true; }
      } catch(e2) {}
      sessionUrl = useDirectPost ? sseUrl : messageUrl;
      try {
        if (!useDirectPost) {
          await mcpRpc(sessionUrl, 'initialize', {protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'raffaello-chat',version:'1.0'}}, es);
        }
        await mcpRpc(sessionUrl, 'notifications/initialized', {}, es);
        const toolsRes = await mcpRpc(sessionUrl, 'tools/list', {}, es);
        const tools = (toolsRes.tools||[]).map(t => ({
          name:t.name, description:t.description||'',
          input_schema:t.inputSchema||{type:'object',properties:{}},
          _sessionUrl:sessionUrl, _es:es, _sseUrl:sseUrl
        }));
        resolve({url:sseUrl, sessionUrl, tools});
      } catch(e) { es.close(); reject(e); }
    });
    es.onerror = () => { es.close(); reject(new Error('SSE connection failed')); };
    setTimeout(() => { es.close(); reject(new Error('SSE timeout (15s)')); }, 15000);
  });
}

const mcpPending = new Map();
let mcpRpcId = 0;

function mcpAttachListener(es) {
  es.addEventListener('message', e => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.id && mcpPending.has(msg.id)) {
        const {resolve,reject} = mcpPending.get(msg.id); mcpPending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message||'RPC error'));
        else resolve(msg.result||{});
      }
    } catch(err) {}
  });
}

async function mcpRpc(sessionUrl, method, params, es) {
  const id = ++mcpRpcId;
  const body = {jsonrpc:'2.0', id, method, params};
  if (method.startsWith('notifications/')) {
    await fetch(sessionUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    return {};
  }
  const promise = new Promise((resolve,reject) => {
    mcpPending.set(id, {resolve,reject});
    setTimeout(()=>{ if(mcpPending.has(id)){mcpPending.delete(id);reject(new Error('RPC timeout'));} }, 30000);
  });
  const res = await fetch(sessionUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if (!res.ok) { const err=await res.text().catch(()=>''); mcpPending.delete(id); throw new Error('MCP RPC '+res.status+': '+err.slice(0,200)); }
  const ct = res.headers.get('content-type')||'';
  if (ct.includes('application/json')) { mcpPending.delete(id); const data=await res.json(); if(data.error) throw new Error(data.error.message); return data.result||{}; }
  return promise;
}

async function callMcpTool(toolName, toolInput) {
  const tool = allMcpTools.find(t => t.name === toolName);
  if (!tool) return {error:'Tool not found: '+toolName};
  // Reconnect if SSE dropped
  if (!tool._es || tool._es.readyState === 2) {
    try {
      if (tool._sseUrl) {
        const result = await connectMcp(tool._sseUrl);
        allMcpTools.forEach(t => { if(t._sseUrl===tool._sseUrl){t._sessionUrl=result.tools[0]?._sessionUrl;t._es=result.tools[0]?._es;} });
      }
    } catch(e) { return {error:'MCP reconnect failed: '+e.message}; }
  }
  try {
    const result = await mcpRpc(tool._sessionUrl, 'tools/call', {name:toolName,arguments:toolInput}, tool._es);
    return {result: (result.content||[]).map(c=>c.text||'').join('\n')};
  } catch(e) { return {error:e.message}; }
}


// ============================================================
//  MCP — Tool Use Loop (non-streaming, multi-turn)
// ============================================================
