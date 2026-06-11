// ============================================================
//  MEMORY
// ============================================================

async function loadMemoryInjection(context) {
  try {
    let r;
    if (context) {
      r = await fetch(CHAT_API + '/memory/v2/inject', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ context })
      });
    } else {
      r = await fetch(CHAT_API + '/memory/v2/inject');
    }
    const d = await r.json();
    cachedInjection = d.injection || '';
    cachedInjectionStatic = d.static || '';
    cachedInjectionDynamic = d.dynamic || '';
    const hits = d.semantic_hits || 0;
    console.log('[memory] injection loaded:', estimateTokens(cachedInjection), 'tok', hits ? `(+${hits} semantic)` : '');
  } catch(e) { console.warn('[memory] inject load failed:', e.message); cachedInjection = ''; cachedInjectionStatic = ''; cachedInjectionDynamic = ''; }
}

function estimateTokens(text) {
  let t = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    t += (c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3000 && c <= 0x30FF) ? 1.5 : 0.28;
  }
  return Math.round(t);
}
function getSystemWithMemory() {
  const base = getFullSystemPrompt();
  if (!globalMemoryEnabled || !cachedInjection) return base;
  return base ? base + '\n\n' + cachedInjection : cachedInjection;
}

function openMemory() {
  document.getElementById('memoryOverlay').classList.add('open');
  renderMemoryPanel();
  loadMemPanelData().then(() => renderMemoryPanel());
}
function closeMemory() { document.getElementById('memoryOverlay').classList.remove('open'); }


// ============================================================
//  MEMORY PANEL
// ============================================================
let memPanelData = { profile: {}, facts: [], memories: [], stats: {} };
let memPanelSection = 'main';
let editingFact = null;

async function loadMemPanelData() {
  try {
    const [pRes, fRes, mRes, sRes] = await Promise.all([
      fetch(CHAT_API + '/memory/v2/profile'),
      fetch(CHAT_API + '/memory/v2/facts'),
      fetch(CHAT_API + '/memory/v2/memories'),
      fetch(CHAT_API + '/memory/v2/stats')
    ]);
    memPanelData.profile = await pRes.json();
    memPanelData.facts = await fRes.json();
    memPanelData.memories = await mRes.json();
    memPanelData.stats = await sRes.json();
  } catch(e) { console.warn('[memory panel] load failed:', e.message); }
}

function renderMemoryPanel() {
  const { stats } = memPanelData;
  const tokenEst = cachedInjection ? estimateTokens(cachedInjection) : 0;
  document.getElementById('memoryCount').textContent = globalMemoryEnabled ? `~${tokenEst} tok` : 'off';

  const list = document.getElementById('memoryList');
  list.innerHTML = '';

  // --- Profile editor mode ---
  if (memPanelSection === 'profile-user' || memPanelSection === 'profile-rel') {
    const which = memPanelSection === 'profile-user' ? 'user' : 'relationship';
    const content = memPanelData.profile[which] || '';
    const wrap = document.createElement('div');
    wrap.className = 'mem-editor-wrap';
    wrap.innerHTML = `<div class="mem-editor-header"><span class="mem-editor-title">${which}</span></div>
      <textarea id="profileEditor" class="mem-editor-ta">${escapeHtml(content)}</textarea>
      <div class="mem-editor-btns">
        <button class="mem-btn-ghost" onclick="memPanelSection='main';renderMemoryPanel()">cancel</button>
        <button class="mem-btn-accent" onclick="saveProfile('${which}')">save</button>
      </div>`;
    list.appendChild(wrap);
    return;
  }

  // --- Injection status ---
  const status = document.createElement('div');
  status.className = 'mem-status-row';
  const staticTok = cachedInjectionStatic ? estimateTokens(cachedInjectionStatic) : 0;
  const dynamicTok = cachedInjectionDynamic ? estimateTokens(cachedInjectionDynamic) : 0;
  const totalTok = staticTok + dynamicTok;
  const tokStr = totalTok >= 1000 ? (totalTok/1000).toFixed(1)+'k' : totalTok;
  status.innerHTML = `<span class="mem-status-dot ${globalMemoryEnabled ? 'on' : ''}"></span>`
    + `<span class="mem-status-text">${globalMemoryEnabled ? 'injection active' : 'injection off'}</span>`
    + `<span class="mem-status-tok">~${tokStr} tok</span>`;
  list.appendChild(status);

  // --- Profiles ---
  const profSec = document.createElement('div');
  profSec.className = 'mem-sec';
  const profTok = cachedInjectionStatic ? estimateTokens(cachedInjectionStatic) : 0;
  const profTokStr = profTok >= 1000 ? (profTok/1000).toFixed(1)+'k' : profTok;
  profSec.innerHTML = `<div class="mem-sec-label">profiles <span class="mem-sec-count">~${profTokStr} tok</span></div>
    <div class="mem-profile-row">
      <button class="mem-chip ${memPanelData.profile.user ? 'active' : ''}" onclick="memPanelSection='profile-user';renderMemoryPanel()">
        <span class="mem-chip-dot"></span>user
      </button>
      <button class="mem-chip ${memPanelData.profile.relationship ? 'active' : ''}" onclick="memPanelSection='profile-rel';renderMemoryPanel()">
        <span class="mem-chip-dot"></span>relationship
      </button>
    </div>`;
  list.appendChild(profSec);

  // --- Facts ---
  const factSec = document.createElement('div');
  factSec.className = 'mem-sec';
  const activeFacts = memPanelData.facts.filter(f => !f.resolved);
  const resolvedFacts = memPanelData.facts.filter(f => f.resolved);
  const factsTok = cachedInjectionDynamic ? estimateTokens(cachedInjectionDynamic) : 0;
  const factsTokStr = factsTok >= 1000 ? (factsTok/1000).toFixed(1)+'k' : factsTok;
  factSec.innerHTML = `<div class="mem-sec-label">facts <span class="mem-sec-count">${activeFacts.length}</span> <span class="mem-sec-count">~${factsTokStr} tok</span></div>`;

  if (!activeFacts.length && !resolvedFacts.length) {
    const ph = document.createElement('div');
    ph.className = 'mem-empty';
    ph.textContent = 'no active facts';
    factSec.appendChild(ph);
  }

  activeFacts.forEach(f => factSec.appendChild(makeFactCard(f)));

  if (resolvedFacts.length) {
    const toggle = document.createElement('button');
    toggle.className = 'mem-resolved-toggle';
    toggle.textContent = `${resolvedFacts.length} resolved`;
    toggle.onclick = () => {
      const wrap = toggle.nextElementSibling;
      if (wrap) { wrap.style.display = wrap.style.display === 'none' ? 'block' : 'none'; }
    };
    factSec.appendChild(toggle);
    const resolvedWrap = document.createElement('div');
    resolvedWrap.style.display = 'none';
    resolvedFacts.forEach(f => resolvedWrap.appendChild(makeFactCard(f)));
    factSec.appendChild(resolvedWrap);
  }

  const addBtn = document.createElement('button');
  addBtn.className = 'mem-add-btn';
  addBtn.textContent = '+ add fact';
  addBtn.onclick = () => { const c = prompt('new fact:'); if (c) addFact(c); };
  factSec.appendChild(addBtn);
  list.appendChild(factSec);

  // --- Links ---
  const linkSec = document.createElement('div');
  linkSec.className = 'mem-links';
  linkSec.innerHTML = `<a href="/raffaello/memory-admin/" class="mem-link-btn">memory gateway</a>`
    + `<a href="/raffaello/vault" class="mem-link-btn">vault</a>`;
  list.appendChild(linkSec);

  // --- Refresh ---
  const refresh = document.createElement('button');
  refresh.className = 'mem-refresh-btn';
  refresh.textContent = '↻ refresh injection';
  refresh.onclick = async () => {
    refresh.textContent = 'checking…';
    refresh.disabled = true;
    try {
      const r = await fetch(CHAT_API + '/memory/v2/inject');
      const d = await r.json();
      const newStatic = d.static || '';
      const newDynamic = d.dynamic || '';
      const newTok = d.token_estimate || 0;
      const oldTok = cachedInjection ? estimateTokens(cachedInjection) : 0;
      const staticChanged = newStatic !== cachedInjectionStatic;
      const dynamicChanged = newDynamic !== cachedInjectionDynamic;
      if (!staticChanged && !dynamicChanged) {
        alert('no changes detected — cache is safe.');
        refresh.textContent = '↻ refresh injection';
        refresh.disabled = false;
        return;
      }
      const changes = [];
      if (staticChanged) changes.push('· profiles changed');
      if (dynamicChanged) {
        const oldFacts = (cachedInjectionDynamic.match(/<current_facts>/g) || []).length ? cachedInjectionDynamic.match(/\n/g)?.length || 0 : 0;
        changes.push('· facts / semantic hits changed');
      }
      changes.push('· tokens: ' + oldTok + ' → ' + newTok);
      if (!confirm('injection content has changed:\n\n' + changes.join('\n') + '\n\napplying will invalidate prompt cache.\ncontinue?')) {
        refresh.textContent = '↻ refresh injection';
        refresh.disabled = false;
        return;
      }
      cachedInjection = d.injection || '';
      cachedInjectionStatic = newStatic;
      cachedInjectionDynamic = newDynamic;
      await loadMemPanelData();
      renderMemoryPanel();
    } catch(e) {
      alert('refresh failed: ' + e.message);
      refresh.textContent = '↻ refresh injection';
      refresh.disabled = false;
    }
  };
  list.appendChild(refresh);
}

function makeFactCard(f) {
  const div = document.createElement('div');
  div.className = 'mem-fact-card' + (f.resolved ? ' resolved' : '');
  const tags = (f.tags || []).map(t => '#'+t).join(' ');
  const expiry = f.expires ? `exp ${f.expires}` : '';
  div.innerHTML = `<div class="mem-fact-head">
      <span class="mem-fact-id">${f.id}${expiry ? ' · '+expiry : ''}</span>
      <div class="mem-fact-acts">
        <button class="mem-fact-btn" onclick="event.stopPropagation();toggleFactResolved('${f.id}')" title="${f.resolved?'reopen':'resolve'}">${f.resolved?'↩':'✓'}</button>
        <button class="mem-fact-btn danger" onclick="event.stopPropagation();deleteFact('${f.id}')" title="delete">✕</button>
      </div>
    </div>
    ${tags ? '<div class="mem-fact-tags">'+tags+'</div>' : ''}
    <div class="mem-fact-body">${escapeHtml(f.body)}</div>`;
  div.addEventListener('click', () => div.classList.toggle('expanded'));
  return div;
}


async function saveProfile(which) {
  const content = document.getElementById('profileEditor').value;
  await fetch(CHAT_API + '/memory/v2/profile/' + which, {
    method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ content })
  });
  await loadMemoryInjection();
  await loadMemPanelData();
  memPanelSection = 'main';
  renderMemoryPanel();
}

async function addFact(content) {
  await fetch(CHAT_API + '/memory/v2/facts', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ content, tags: [] })
  });
  await loadMemoryInjection();
  await loadMemPanelData();
  renderMemoryPanel();
}

async function toggleFactResolved(id) {
  const fact = memPanelData.facts.find(f => f.id === id);
  if (!fact) return;
  await fetch(CHAT_API + '/memory/v2/facts/' + id, { method: 'DELETE' });
  await fetch(CHAT_API + '/memory/v2/facts', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      id, content: fact.body, tags: fact.tags || [],
      resolved: !fact.resolved, created: fact.created,
      expires: fact.expires || undefined
    })
  });
  await loadMemoryInjection();
  await loadMemPanelData();
  renderMemoryPanel();
}

async function deleteFact(id) {
  if (!confirm('delete this fact?')) return;
  await fetch(CHAT_API + '/memory/v2/facts/' + id.replace('.md',''), { method: 'DELETE' });
  await loadMemoryInjection();
  await loadMemPanelData();
  renderMemoryPanel();
}
