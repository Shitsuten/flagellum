// === Markdown Setup ===
marked.setOptions({
  highlight: (code, lang) => {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
    return hljs.highlightAuto(code).value;
  },
  breaks: true, gfm: true
});
const renderer = new marked.Renderer();
renderer.code = function(obj) {
  const code = typeof obj === 'object' ? obj.text : obj;
  const lang = typeof obj === 'object' ? (obj.lang || '') : (arguments[1] || '');
  let highlighted;
  if (lang && hljs.getLanguage(lang)) highlighted = hljs.highlight(code, { language: lang }).value;
  else highlighted = hljs.highlightAuto(code).value;
  const label = lang || 'code';
  return `<pre><div class="code-header"><span>${label}</span><button class="copy-btn" onclick="copyCode(this)">copy</button></div><code class="hljs">${highlighted}</code></pre>`;
};
marked.setOptions({ renderer });

function copyCode(btn) {
  const code = btn.closest('pre').querySelector('code').textContent;
  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = 'copied!';
    setTimeout(() => btn.textContent = 'copy', 1500);
  });
}
function renderMarkdown(text) {
  try {
    text = text.replace(/\[image\](https?:\/\/[^\s]+)/g, (_, url) => '![image](' + url + ')');
    text = text.replace(/\[file\](https?:\/\/[^\s]+)/g, (_, url) => '[📎 file](' + url + ')');
    return marked.parse(text);
  } catch(e) { return escapeHtml(text); }
}
function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const pad = n => String(n).padStart(2,'0');
  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
  const dStr = d.toDateString();
  if (dStr === now.toDateString()) return hm;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (dStr === y.toDateString()) return '昨天 ' + hm;
  const md = (d.getMonth()+1) + '/' + d.getDate();
  if (d.getFullYear() === now.getFullYear()) return md + ' ' + hm;
  return String(d.getFullYear()).slice(2) + '/' + md + ' ' + hm;
}
function fmtTok(n) {
  if (!n && n !== 0) return '';
  if (n < 1000) return String(n);
  return (n/1000).toFixed(n < 10000 ? 2 : 1) + 'k';
}
const CTX_WARN_THRESHOLD = 13000;
function estimateContextTokens() {
  for (let i = history.length - 1; i >= 0; i--) {
    const u = history[i].usage;
    if (u && u.input_tokens != null) {
      const totalInput = u.input_tokens + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0); return { tokens: totalInput, source: 'actual' };
    }
  }
  const sys = getSystemWithMemory();
  const conv = currentConv();
  const compressedUpTo = conv?.compressedUpTo || 0;
  const summary = conv?.compressionSummary;
  let msgText;
  if (summary && compressedUpTo > 0) {
    const kept = history.slice(compressedUpTo);
    msgText = summary + kept.map(m => (typeof m.content === 'string' ? m.content : '') + (m.thinking || '')).join('');
  } else {
    msgText = history.map(m => (typeof m.content === 'string' ? m.content : '') + (m.thinking || '')).join('');
  }
  return { tokens: estimateTokens(sys + msgText), source: 'estimate' };
}
function currentConv() {
  const id = localStorage.getItem('chat-last-conv');
  return conversations.find(c => c.id === id);
}
function updateContextBar() {
  const bar = document.getElementById('contextBar');
  if (!bar) return;
  const tokEl = document.getElementById('ctxTokens');
  const extraEl = document.getElementById('ctxExtra');
  if (!history.length) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  const { tokens, source } = estimateContextTokens();
  const kStr = tokens >= 1000 ? (tokens/1000).toFixed(tokens < 10000 ? 2 : 1) + 'k' : tokens;
  tokEl.textContent = source === 'estimate' ? '~' + kStr : kStr;
  tokEl.title = source === 'estimate' ? 'rough estimate (no usage data yet)' : 'from last response usage';
  bar.classList.remove('warn','compressed');
  const conv = currentConv();
  const compressed = conv && conv.compressionSummary;
  let extras = [];
  if (compressed) {
    bar.classList.add('compressed');
    extras.push(`<span class="ctx-sep">·</span>前 ${conv.compressedUpTo} 条已压缩`);
  }
  if (tokens > CTX_WARN_THRESHOLD) {
    bar.classList.add('warn');
    extras.push(`<span class="ctx-sep">·</span>建议压缩`);
    
    
  } else {
    
    
  }
  
  extraEl.innerHTML = extras.join('');
}

// ============================================================
//  CONFIG / SETTINGS
// ============================================================
async function loadConfig() {
  try { const r = await fetch(CHAT_API+'/settings'); if(r.ok){const s=await r.json(); if(s.provider) config={...config,...s};} }
  catch(e) { try{const s=localStorage.getItem('chat-config'); if(s) config={...config,...JSON.parse(s)};} catch(e2){} }
  document.getElementById('provider').value = config.provider;
  document.getElementById('endpoint').value = config.endpoint;
  document.getElementById('apiKey').value = config.apiKey;
  document.getElementById('modelInput').value = config.model;
  const gwEl = document.getElementById('useGateway'); if (gwEl) gwEl.checked = config.useGateway !== false;
  const spEl = document.getElementById('systemPrompt'); if (spEl) spEl.value = config.systemPrompt;
  loadStylesFromConfig();
  renderAccounts();
  renderMcpList(); onProviderChange();
}

function renderAccounts() {
  const bar = document.getElementById('accountsBar');
  if (!bar) return;
  const accts = config.accounts || [];
  bar.innerHTML = accts.map((a, i) => {
    const isActive = a.endpoint === config.endpoint && a.apiKey === config.apiKey;
    const keyHint = a.apiKey ? '·'+a.apiKey.slice(-4) : '';
    return '<button class="account-pill'+(isActive?' active':'')+'" onclick="switchAccount('+i+')">'+a.name+' <span style="opacity:.5">'+keyHint+'</span><span class="del" onclick="event.stopPropagation();removeAccount('+i+')">×</span></button>';
  }).join('') + '<button class="account-add" onclick="addCurrentAccount()">+ save</button>';
}
function switchAccount(idx) {
  const a = (config.accounts || [])[idx];
  if (!a) return;
  config.endpoint = a.endpoint; config.apiKey = a.apiKey;
  if (a.provider) config.provider = a.provider;
  if (a.model) config.model = a.model;
  document.getElementById('provider').value = config.provider;
  document.getElementById('endpoint').value = config.endpoint;
  document.getElementById('apiKey').value = config.apiKey;
  if (a.model) document.getElementById('modelInput').value = config.model;
  persistConfig();
  renderAccounts();
}
function addCurrentAccount() {
  const name = prompt('账号名称：');
  if (!name) return;
  if (!config.accounts) config.accounts = [];
  const ep = (document.getElementById('endpoint').value||'').trim();
  const ak = (document.getElementById('apiKey').value||'').trim();
  const pv = document.getElementById('provider').value;
  const md = (document.getElementById('modelInput').value||'').trim();
  const existing = config.accounts.findIndex(a => a.endpoint===ep && a.apiKey===ak);
  if (existing >= 0) config.accounts[existing].name = name;
  else config.accounts.push({name, endpoint:ep, apiKey:ak, provider:pv, model:md});
  saveSettings();
}
function removeAccount(idx) {
  if (!config.accounts || !confirm('删除这个账号？')) return;
  config.accounts.splice(idx, 1);
  saveSettings();
}
function persistConfig() {
  localStorage.setItem('chat-config', JSON.stringify(config));
  fetch(CHAT_API+'/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(config)}).catch(()=>{});
  updateHeader();
}
function saveSettings() {
  config.provider = document.getElementById('provider').value;
  config.endpoint = document.getElementById('endpoint').value.trim();
  config.apiKey = document.getElementById('apiKey').value.trim();
  config.model = document.getElementById('modelInput').value.trim();
  const gwEl = document.getElementById('useGateway'); if (gwEl) config.useGateway = gwEl.checked;
  const spEl2 = document.getElementById('systemPrompt'); config.systemPrompt = spEl2 ? spEl2.value : config.systemPrompt;
  config.mcpServers = getMcpUrlsFromList();
  persistConfig(); closeSettings(); initMcpServers();
}
function updateHeader() {
  const model = config.model || DEFAULTS[config.provider]?.model || '';
  const _hm = document.getElementById('hdModel'); if(_hm) _hm.textContent = config.apiKey ? model : '—';
  const _ht = document.getElementById('hdTools'); if(_ht) _ht.textContent = allMcpTools.length ? allMcpTools.length + ' connected' : 'none';
  document.getElementById('sendBtn').disabled = !config.apiKey;
  const memToggle = document.getElementById('hdMemToggle');
  if (memToggle) memToggle.checked = globalMemoryEnabled;
  renderAccounts();
}
function onProviderChange() {
  const p = document.getElementById('provider').value;
  document.getElementById('endpointHint').textContent = p === 'anthropic' ? '(leave blank for api.anthropic.com)' : '(e.g. openrouter.ai/api/v1)';
}
function openSettings() { renderMcpList(); document.getElementById('settingsOverlay').classList.add('open'); }
function closeSettings() { document.getElementById('settingsOverlay').classList.remove('open'); }


// ============================================================
//  SIDEBAR
// ============================================================
function toggleSidebar() { document.getElementById('sidebar').classList.toggle('open'); document.getElementById('sidebarOverlay').classList.toggle('open'); }
function closeSidebarMobile() { document.getElementById('sidebar').classList.remove('open'); document.getElementById('sidebarOverlay').classList.remove('open'); }

function renderConvList() {
  const el = document.getElementById('convList'); el.innerHTML = '';

  // Group conversations
  const projects = {};  // project name -> [convs]
  const starred = [];
  const recents = [];
  const byDate = [...conversations].sort((a,b) => new Date(b.created_at) - new Date(a.created_at));

  byDate.forEach(c => {
    if (c.project) {
      if (!projects[c.project]) projects[c.project] = [];
      projects[c.project].push(c);
    } else if (c.starred) {
      starred.push(c);
    } else {
      recents.push(c);
    }
  });

  const sectionCollapsed = JSON.parse(localStorage.getItem('chat-sections') || '{}');

  function toggleSection(key) {
    sectionCollapsed[key] = !sectionCollapsed[key];
    localStorage.setItem('chat-sections', JSON.stringify(sectionCollapsed));
    renderConvList();
  }

  function makeSection(key, icon, label, items) {
    if (!items.length) return;
    const sec = document.createElement('div');
    sec.className = 'conv-section' + (sectionCollapsed[key] ? ' collapsed' : '');
    const header = document.createElement('div');
    header.className = 'conv-section-header';
    header.onclick = () => toggleSection(key);
    header.innerHTML = '<span class="conv-section-arrow">▼</span><span class="section-icon">' + icon + '</span> ' + label + '<span class="conv-section-count">' + items.length + '</span>';
    sec.appendChild(header);
    const list = document.createElement('div');
    list.className = 'conv-section-items';
    items.forEach(c => list.appendChild(makeConvItem(c)));
    sec.appendChild(list);
    el.appendChild(sec);
  }

  function makeConvItem(c) {
    const item = document.createElement('div');
    item.className = 'conv-item' + (c.id === currentConvId ? ' active' : '');
    item.onclick = (e) => { if (!e.target.closest('.conv-more') && !e.target.closest('.conv-menu')) switchConversation(c.id); };
    if (c.starred) { const star = document.createElement('span'); star.className = 'conv-star'; star.textContent = '★'; item.appendChild(star); }
    const titleWrap = document.createElement('div'); titleWrap.className = 'conv-title-wrap';
    const title = document.createElement('span'); title.className = 'conv-title'; title.textContent = c.title || 'New chat';
    let lastMsgTs = null;
    if (c.messages && c.messages.length) { for (let i = c.messages.length - 1; i >= 0; i--) { if (c.messages[i].timestamp) { lastMsgTs = c.messages[i].timestamp; break; } } }
    const ts = document.createElement('span'); ts.className = 'conv-time'; ts.textContent = fmtTime(lastMsgTs || c.updated_at || c.created_at);
    titleWrap.appendChild(title); titleWrap.appendChild(ts);
    item.appendChild(titleWrap);
    const more = document.createElement('button'); more.className = 'conv-more'; more.textContent = '···';
    more.onclick = (e) => { e.stopPropagation(); toggleConvMenu(c.id, item); };
    const menu = document.createElement('div'); menu.className = 'conv-menu'; menu.dataset.id = c.id;
    menu.innerHTML = '<button class="conv-menu-item accent" onclick="event.stopPropagation();toggleStar(\'' + c.id + '\')">' + (c.starred ? '☆ Unstar' : '★ Star') + '</button><button class="conv-menu-item" onclick="event.stopPropagation();assignProject(\'' + c.id + '\')">' + (c.project ? '⊟ Change project' : '⊞ Project') + '</button><button class="conv-menu-item" onclick="event.stopPropagation();startRename(\'' + c.id + '\')">✎ Rename</button><button class="conv-menu-item danger" onclick="event.stopPropagation();confirmDelete(\'' + c.id + '\')">✕ Delete</button>';
    item.appendChild(more); item.appendChild(menu);
    return item;
  }

  // Render sections
  const projectNames = Object.keys(projects).sort();
  projectNames.forEach(name => makeSection('proj:' + name, '⊞', name, projects[name]));
  makeSection('starred', '★', 'Starred', starred);
  makeSection('recents', '◷', 'Recents', recents);
}
let openMenuId = null;
function toggleConvMenu(id, item) {
  document.querySelectorAll('.conv-menu.open').forEach(m=>m.classList.remove('open'));
  if (openMenuId===id) { openMenuId=null; return; }
  item.querySelector('.conv-menu').classList.add('open'); openMenuId=id;
  const close = e => { if(!e.target.closest('.conv-menu')){item.querySelector('.conv-menu').classList.remove('open');openMenuId=null;document.removeEventListener('click',close);} };
  setTimeout(()=>document.addEventListener('click',close),0);
}
function startRename(id) {
  document.querySelectorAll('.conv-menu.open').forEach(m=>m.classList.remove('open')); openMenuId=null;
  const conv = conversations.find(c=>c.id===id); if(!conv) return;
  const item = document.querySelector(`.conv-menu[data-id="${id}"]`)?.parentElement; if(!item) return;
  const span = item.querySelector('.conv-title');
  const inp = document.createElement('input');
  inp.value = conv.title;
  inp.style.cssText = 'width:100%;font-size:.82rem;border:none;background:transparent;outline:none;color:var(--text);';
  inp.onblur = async () => { conv.title = inp.value||'新对话'; await saveConvToServer(conv); renderConvList(); };
  inp.onclick = ev => ev.stopPropagation();
  inp.onkeydown = ev => { if(ev.key==='Enter') inp.blur(); };
  span.replaceWith(inp); inp.focus(); inp.select();
}
function confirmDelete(id) {
  document.querySelectorAll('.conv-menu.open').forEach(m=>m.classList.remove('open')); openMenuId=null;
  if (confirm('Delete this conversation?')) deleteConversation(id);
}

async function toggleStar(id) {
  document.querySelectorAll('.conv-menu.open').forEach(m=>m.classList.remove('open')); openMenuId=null;
  const listConv = conversations.find(c=>c.id===id); if(!listConv) return;
  try {
    const full = await (await fetch(CHAT_API+'/conversations/'+id)).json();
    full.starred = !full.starred;
    await fetch(CHAT_API+'/conversations/'+id, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(full) });
    listConv.starred = full.starred;
  } catch(e) { console.error('toggleStar failed:', e); }
  renderConvList();
}

async function assignProject(id) {
  document.querySelectorAll('.conv-menu.open').forEach(m=>m.classList.remove('open')); openMenuId=null;
  const listConv = conversations.find(c=>c.id===id); if(!listConv) return;
  const current = listConv.project || '';
  const name = prompt('Project name (empty to remove):', current);
  if (name === null) return;
  const proj = name.trim() || undefined;
  try {
    const full = await (await fetch(CHAT_API+'/conversations/'+id)).json();
    if (proj) full.project = proj; else delete full.project;
    await fetch(CHAT_API+'/conversations/'+id, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(full) });
    if (proj) listConv.project = proj; else delete listConv.project;
  } catch(e) { console.error('assignProject failed:', e); }
  renderConvList();
}



// ============================================================
//  IMAGE / FILE HANDLING
// ============================================================
// Resize image to max 1568px on longest side (Claude's recommended max), JPEG quality 0.85
async function processImageFile(file) {
  return new Promise((resolve, reject) => {
    // Non-image: pass through as-is
    if (!file.type.startsWith('image/')) {
      const r = new FileReader();
      r.onload = () => resolve({ base64: r.result.split(',')[1], media_type: file.type, dataUrl: r.result });
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
      return;
    }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const MAX = 1568;
      let { width: w, height: h } = img;
      const long = Math.max(w, h);
      if (long > MAX) { const scale = MAX / long; w = Math.round(w*scale); h = Math.round(h*scale); }
      // Small images or GIF (animation) or SVG: pass through
      if (long <= MAX || file.type === 'image/gif' || file.type === 'image/svg+xml') {
        const r = new FileReader();
        r.onload = () => resolve({ base64: r.result.split(',')[1], media_type: file.type, dataUrl: r.result });
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const isPngWithAlpha = file.type === 'image/png';
      const outType = isPngWithAlpha ? 'image/png' : 'image/jpeg';
      const quality = isPngWithAlpha ? undefined : 0.85;
      const dataUrl = canvas.toDataURL(outType, quality);
      resolve({ base64: dataUrl.split(',')[1], media_type: outType, dataUrl });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')); };
    img.src = url;
  });
}

function initChannelImgClick() {
  document.getElementById('messages').addEventListener('click', e => {
    const img = e.target.closest('img[alt="image"]');
    if (!img) return;
    e.stopPropagation();
    document.getElementById('lightboxImg').src = img.src;
    document.getElementById('lightboxOverlay').classList.add('open');
  });
}
function initImagePaste() {
  document.addEventListener('paste', e => {
    const items = e.clipboardData?.items; if(!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        processImageFile(file).then(res => {
          pendingImage = { base64: res.base64, media_type: res.media_type };
          document.getElementById('imgPreviewImg').src = res.dataUrl;
          document.getElementById('imgPreview').style.display = 'flex';
        }).catch(err => console.warn('image process failed:', err));
        break;
      }
    }
  });
}
function clearImage() { pendingImage=null; document.getElementById('imgPreview').style.display='none'; document.getElementById('fileInput').value=''; }
function handleFileUpload(input) {
  const file = input.files?.[0]; if(!file) return;
  if (file.type.startsWith('image/')) {
    processImageFile(file).then(res => {
      pendingImage = { base64: res.base64, media_type: res.media_type };
      document.getElementById('imgPreviewImg').src = res.dataUrl;
      document.getElementById('imgPreview').style.display = 'flex';
    }).catch(err => console.warn('image process failed:', err));
  } else {
    const reader = new FileReader();
    reader.onload = () => {
      const ta = document.getElementById('input');
      ta.value = ta.value + `[File: ${file.name}]\n` + reader.result;
      autoResize(ta);
    };
    reader.readAsText(file);
  }
}


// ============================================================
//  THEME — auto-switch by time of day
// ============================================================
function applyTheme() {
  const hour = new Date().getHours();
  const saved = localStorage.getItem('chat-theme');
  const isLight = saved==='light' || (saved!=='dark' && hour>=7 && hour<19);
  document.body.classList.toggle('light', isLight);
  const btn = document.getElementById('themeBtn');
  if (btn) btn.textContent = isLight ? '🌙' : '☀️';
}
function toggleTheme() { localStorage.setItem('chat-theme', document.body.classList.contains('light') ? 'dark' : 'light'); applyTheme(); }
applyTheme();
setInterval(applyTheme, 30*60*1000);




// ============================================================
//  SIDEBAR SEARCH
// ============================================================
let _searchTimer = null;
function onSearchInput(val) {
  clearTimeout(_searchTimer);
  const clear = document.getElementById('searchClear');
  if (!val.trim()) { clearSearch(); return; }
  clear.style.display = 'block';
  _searchTimer = setTimeout(() => runSearch(val.trim()), 300);
}

async function runSearch(q) {
  const resultsEl = document.getElementById('searchResults');
  const convListEl = document.getElementById('convList');
  try {
    const r = await fetch(CHAT_API + '/conversations/search?q=' + encodeURIComponent(q));
    const data = await r.json();
    resultsEl.innerHTML = '';
    if (!data.length) {
      resultsEl.innerHTML = '<div class="search-empty">no results</div>';
      resultsEl.style.display = 'block';
      convListEl.style.display = 'none';
      return;
    }
    data.forEach(item => {
      const div = document.createElement('div');
      div.className = 'search-result-item';
      div.onclick = () => { clearSearch(); switchConversation(item.id); };
      const titleDiv = document.createElement('div');
      titleDiv.className = 'search-result-title';
      titleDiv.innerHTML = (item.starred ? '<span class="sr-star">★</span>' : '') + escapeHtml(item.title);
      div.appendChild(titleDiv);
      if (item.matches && item.matches.length) {
        item.matches.forEach(m => {
          const sn = document.createElement('div');
          sn.className = 'search-result-snippet';
          const esc = escapeHtml(m.snippet);
          const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
          sn.innerHTML = '<span class="search-result-role">' + m.role + '</span>' + esc.replace(re, '<mark>$1</mark>');
          div.appendChild(sn);
        });
      }
      resultsEl.appendChild(div);
    });
    resultsEl.style.display = 'block';
    convListEl.style.display = 'none';
  } catch(e) {
    console.warn('search failed:', e);
  }
}

function clearSearch() {
  document.getElementById('searchInput').value = '';
  document.getElementById('searchClear').style.display = 'none';
  document.getElementById('searchResults').style.display = 'none';
  document.getElementById('searchResults').innerHTML = '';
  document.getElementById('convList').style.display = '';
}


// ============================================================
//  DRAG & DROP IMAGE UPLOAD
// ============================================================
function initDragDrop() {
  const main = document.querySelector('.main');
  if (!main) return;
  let dragCounter = 0;
  const overlay = document.getElementById('dropOverlay');

  main.addEventListener('dragenter', e => {
    e.preventDefault();
    if (!e.dataTransfer.types.includes('Files')) return;
    dragCounter++;
    overlay.classList.add('active');
  });
  main.addEventListener('dragleave', e => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; overlay.classList.remove('active'); }
  });
  main.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  main.addEventListener('drop', e => {
    e.preventDefault();
    dragCounter = 0;
    overlay.classList.remove('active');
    const files = e.dataTransfer.files;
    if (!files.length) return;
    const file = files[0];
    if (file.type.startsWith('image/')) {
      processImageFile(file).then(res => {
        pendingImage = { base64: res.base64, media_type: res.media_type };
        document.getElementById('imgPreviewImg').src = res.dataUrl;
        document.getElementById('imgPreview').style.display = 'flex';
      }).catch(err => console.warn('drop image failed:', err));
    }
  });
}

// ============================================================
//  STYLE PICKER & EDITOR
// ============================================================
function toggleStylePicker() {
  const picker = document.getElementById('hdStylePicker');
  const arrow = document.querySelector('.hd-style-arrow');
  const show = picker.style.display === 'none';
  picker.style.display = show ? 'block' : 'none';
  if (arrow) arrow.classList.toggle('open', show);
  if (show) renderStylePicker();
}

function renderStylePicker() {
  const list = document.getElementById('hdStyleList');
  list.innerHTML = '';
  styles.forEach(s => {
    const btn = document.createElement('button');
    btn.className = 'hd-style-opt' + (activeStyleId === s.id ? ' active' : '');
    btn.dataset.style = s.id;
    btn.innerHTML = escapeHtml(s.name) + '<span class="hd-style-edit" onclick="event.stopPropagation();openStyleEditor(\'' + s.id + '\')">✎</span>';
    btn.onclick = () => selectStyle(s.id);
    list.appendChild(btn);
  });
  document.querySelectorAll('.hd-style-opt').forEach(b => {
    b.classList.toggle('active', (b.dataset.style || '') === activeStyleId);
  });
}

function selectStyle(id) {
  setActiveStyle(id);
  const style = getActiveStyle();
  const label = style ? style.name : 'normal';
  const tok = style && style.content ? estimateTokens(style.content) : 0;
  const tokStr = tok ? ' ~' + (tok >= 1000 ? (tok/1000).toFixed(1) + 'k' : tok) + ' tok' : '';
  document.getElementById('hdStyleTok').textContent = tokStr;
  document.getElementById('hdStyle').textContent = label;
  document.querySelectorAll('.hd-style-opt').forEach(b => {
    b.classList.toggle('active', (b.dataset.style || '') === id);
  });
}

let _editingStyleId = null;

function openStyleEditor(id) {
  document.getElementById('headerDropdown').classList.remove('open');
  document.getElementById('hdStylePicker').style.display = 'none';
  const overlay = document.getElementById('styleOverlay');
  if (id) {
    const s = styles.find(x => x.id === id);
    if (!s) return;
    _editingStyleId = id;
    document.getElementById('styleEditorTitle').innerHTML = 'edit style<span class="memory-count" id="styleEditorTok" style="margin-left:auto;padding-left:12px"></span>';
    document.getElementById('styleName').value = s.name;
    document.getElementById('styleContent').value = s.content;
    document.getElementById('styleDeleteBtn').style.display = '';
    updateStyleEditorTok();
  } else {
    _editingStyleId = null;
    document.getElementById('styleEditorTitle').innerHTML = 'new style<span class="memory-count" id="styleEditorTok" style="margin-left:auto;padding-left:12px"></span>';
    document.getElementById('styleName').value = '';
    document.getElementById('styleContent').value = '';
    updateStyleEditorTok();
    document.getElementById('styleDeleteBtn').style.display = 'none';
  }
  overlay.classList.add('open');
}

function closeStyleEditor() {
  document.getElementById('styleOverlay').classList.remove('open');
  _editingStyleId = null;
}

function saveStyleFromEditor() {
  const name = document.getElementById('styleName').value.trim();
  const content = document.getElementById('styleContent').value.trim();
  if (!name) return;
  if (_editingStyleId) {
    const s = styles.find(x => x.id === _editingStyleId);
    if (s) { s.name = name; s.content = content; }
  } else {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2,5);
    styles.push({ id, name, content });
    setActiveStyle(id);
  }
  saveStyles();
  selectStyle(activeStyleId);
  closeStyleEditor();
}

function updateStyleEditorTok() {
  const el = document.getElementById('styleEditorTok');
  if (!el) return;
  const content = document.getElementById('styleContent')?.value || '';
  const tok = content ? estimateTokens(content) : 0;
  el.textContent = tok ? '~' + (tok >= 1000 ? (tok/1000).toFixed(1) + 'k' : tok) + ' tok' : '';
}

function deleteStyleFromEditor() {
  if (!_editingStyleId) return;
  if (!confirm('delete this style?')) return;
  styles = styles.filter(s => s.id !== _editingStyleId);
  if (activeStyleId === _editingStyleId) setActiveStyle('');
  saveStyles();
  selectStyle(activeStyleId);
  closeStyleEditor();
}

function initStyles() {
  const style = getActiveStyle();
  const label = style ? style.name : 'normal';
  const tok = style && style.content ? estimateTokens(style.content) : 0;
  const tokStr = tok ? ' ~' + (tok >= 1000 ? (tok/1000).toFixed(1) + 'k' : tok) + ' tok' : '';
  document.getElementById('hdStyleTok').textContent = tokStr;
  document.getElementById('hdStyle').textContent = label;
}
