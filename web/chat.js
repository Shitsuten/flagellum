function getWelcomeText() {
  // Time-of-day greeting shown on an empty conversation. Customize freely —
  // this is the one place the assistant's "voice" leaks into the UI shell.
  const h = new Date().getHours();
  const pool =
    h < 6  ? ['still up?', 'late night', "i'm here"] :
    h < 12 ? ['morning', 'hey there', 'good to see you'] :
    h < 18 ? ['afternoon', "what's up", 'hi'] :
             ['evening', 'welcome back', 'hey'];
  return pool[Math.floor(Math.random() * pool.length)];
}

// ============================================================
//  INIT
// ============================================================
async function initApp() {
  await loadConfig();
  await loadBaseSystemPrompt();
  await loadMemoryInjection();
  await loadConversations();
  // Clean up empty conversations older than 5 min
  const cutoff = Date.now() - 5 * 60 * 1000;
  const empties = conversations.filter(c => !c.message_count && !c.messages?.length && new Date(c.created_at).getTime() < cutoff);
  for (const e of empties) await fetch(CHAT_API + '/conversations/' + e.id, { method: 'DELETE' }).catch(()=>{});
  conversations = conversations.filter(c => c.message_count || c.messages?.length || new Date(c.created_at).getTime() >= cutoff);
  const lastId = localStorage.getItem('chat-last-conv');
  const target = conversations.find(c => c.id === lastId) || conversations[0];
  if (target) await switchConversation(target.id);
  else await newConversation();
  updateHeader();
  initMcpServers();
  initImagePaste();
  initChannelImgClick();
  initDragDrop();
  updateContextBar();
  initStyles();
}

async function loadBaseSystemPrompt() {
  try { const r = await fetch('/raffaello/chat/system-prompt.txt'); if (r.ok) baseSystemPrompt = await r.text(); } catch(e) {}
}
function getFullSystemPrompt() {
  const parts = [baseSystemPrompt, config.systemPrompt].filter(Boolean);
  return parts.join('\n\n') || '';
}


// ============================================================
//  CONVERSATION MANAGEMENT — the core fix
// ============================================================
async function loadConversations() {
  try { conversations = await (await fetch(CHAT_API+'/conversations')).json(); } catch(e) { conversations = []; }
}

async function saveConvToServer(conv) {
  await fetch(CHAT_API+'/conversations/'+conv.id, {
    method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(conv)
  });
}

/** Save current conversation. Snapshots state at call time. Merges injected messages. */
function saveCurrentConv() {
  const id = currentConvId;
  const snapshot = history.map(m => {
    const copy = {...m};
    if (typeof copy.content === 'string') copy.content = copy.content.replace(/\uFFFD/g, '');
    if (copy.blocks) copy.blocks = copy.blocks.map(b => b.type === 'text' && b.text ? {...b, text: b.text.replace(/\uFFFD/g, '')} : b);
    return copy;
  });
  if (!id) return;
  _savingQueue = _savingQueue.then(async () => {
    const conv = conversations.find(c => c.id === id);
    if (!conv) return;
    // Merge: fetch server state, append any injected messages we don't have locally
    try {
      const res = await fetch(CHAT_API+'/conversations/'+id);
      const server = await res.json();
      const serverMsgs = server.messages || [];
      if (serverMsgs.length > snapshot.length) {
        const injected = serverMsgs.slice(snapshot.length);
        snapshot.push(...injected);
        history.push(...injected.map(m => ({...m})));
        rebuildMessages();
      }
    } catch(e) {}
    conv.messages = snapshot;
    conv.message_count = snapshot.length;
    if (snapshot.length > 0 && conv.title === '新对话') {
      conv.title = (typeof snapshot[0].content === 'string' ? snapshot[0].content : '图片消息').slice(0, 30);
    }
    try { await saveConvToServer(conv); } catch(e) { console.warn('Save failed:', e); }
  }).catch(e => console.warn('Save queue error:', e));
  return _savingQueue;
}

async function newConversation() {
  if (_switchLock) return;
  _switchLock = true;
  try {
    // Save current conversation first
    if (currentConvId && history.length > 0) {
      await saveCurrentConv();
    }
    const conv = { id: Date.now().toString(36) + Math.random().toString(36).slice(2,6), title: '新对话', created_at: new Date().toISOString(), messages: [] };
    await fetch(CHAT_API+'/conversations', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(conv) });
    conversations.unshift(conv);
    currentConvId = conv.id;
    localStorage.setItem('chat-last-conv', conv.id);
    history = [];
    document.getElementById('messages').innerHTML = '<div class="welcome">' + getWelcomeText() + '</div>';
    updateContextBar();
    renderConvList();
    closeSidebarMobile();
  } finally {
    _switchLock = false;
  }
}

async function switchConversation(id) {
  if (_switchLock || id === currentConvId) return;
  _switchLock = true;
  closeSidebarMobile();
  try {
    // 1. Save current conversation — snapshot at this instant
    if (currentConvId && history.length > 0) {
      const prevConv = conversations.find(c => c.id === currentConvId);
      if (prevConv) {
        prevConv.messages = history.map(m => ({...m}));
        prevConv.message_count = prevConv.messages.length;
        if (prevConv.messages.length > 0 && prevConv.title === '新对话') {
          prevConv.title = (typeof prevConv.messages[0].content === 'string' ? prevConv.messages[0].content : '图片消息').slice(0, 30);
        }
        try { await saveConvToServer(prevConv); } catch(e) { console.warn('Save on switch failed:', e); }
      }
    }
    // 2. Fade out, load target conversation
    const msgContainer = document.getElementById('messages');
    msgContainer.classList.add('switching');
    await new Promise(r => setTimeout(r, 150));
    currentConvId = id;
    localStorage.setItem('chat-last-conv', id);
    try {
      const res = await fetch(CHAT_API+'/conversations/'+id);
      const conv = await res.json();
      const idx = conversations.findIndex(c => c.id === id);
      if (idx >= 0) conversations[idx] = conv;
      history = (conv.messages || []).map(m => ({...m})); // deep-ish clone
    } catch(e) { history = []; }
    rebuildMessages();
    renderConvList();
    requestAnimationFrame(() => msgContainer.classList.remove('switching'));
  } finally {
    _switchLock = false;
  }
}

async function deleteConversation(id) {
  await fetch(CHAT_API+'/conversations/'+id, { method:'DELETE' });
  conversations = conversations.filter(c => c.id !== id);
  if (currentConvId === id) {
    currentConvId = null; // clear before switching so switch doesn't try to save deleted conv
    if (conversations.length > 0) await switchConversation(conversations[0].id);
    else { history = []; document.getElementById('messages').innerHTML = '<div class="welcome">' + getWelcomeText() + '</div>'; }
  }
  renderConvList();
}



// ============================================================
//  MESSAGE DISPLAY
// ============================================================

function renderImageContent(contentArr) {
  const frag = document.createDocumentFragment();
  let textParts = [];
  let imgSrc = null;
  for (const block of contentArr) {
    if (block.type === 'text' && block.text) textParts.push(block.text);
    if (block.type === 'image' && block.source) {
      imgSrc = 'data:' + (block.source.media_type||'image/jpeg') + ';base64,' + block.source.data;
    }
  }
  if (textParts.length) {
    const span = document.createElement('span');
    span.innerHTML = renderMarkdown(textParts.join(' '));
    frag.appendChild(span);
  }
  if (imgSrc) {
    const img = document.createElement('img');
    img.className = 'msg-thumb';
    img.src = imgSrc;
    img.onclick = (e) => { e.stopPropagation(); document.getElementById('lightboxImg').src = imgSrc; document.getElementById('lightboxOverlay').classList.add('open'); };
    frag.appendChild(img);
  }
  return frag;
}

function addMessageToDOM(role, content, histIdx, imageContent) {
  const container = document.getElementById('messages');
  const welcome = container.querySelector('.welcome'); if (welcome) welcome.remove();
  const div = document.createElement('div');
  div.className = 'msg msg-' + role;
  if (histIdx !== undefined) div.dataset.idx = histIdx;
  const bubble = document.createElement('div'); bubble.className = 'msg-bubble';
  if (role === 'assistant') {
    if (typeof content === 'string' && content) bubble.innerHTML = renderMarkdown(content);
    else bubble.textContent = content || '';
  } else {
    const entry = histIdx !== undefined ? history[histIdx] : null;
    if (entry && entry.thinking) {
      const td = document.createElement('div');
      td.className = 'thinking-block';
      td.innerHTML = `<div class="thinking-label" onclick="this.parentElement.classList.toggle('expanded')">thinking...</div><div class="thinking-content">${escapeHtml(entry.thinking)}</div>`;
      bubble.appendChild(td);
      const textDiv = document.createElement('div');
      textDiv.innerHTML = renderMarkdown(content);
      bubble.appendChild(textDiv);
    } else {
      bubble.innerHTML = renderMarkdown(content);
    }
    // Render image thumbnail if present
    if (imageContent && Array.isArray(imageContent)) {
      const imgBlock = imageContent.find(b => b.type === 'image');
      if (imgBlock && imgBlock.source) {
        const src = 'data:' + (imgBlock.source.media_type||'image/jpeg') + ';base64,' + imgBlock.source.data;
        const img = document.createElement('img');
        img.className = 'msg-thumb';
        img.src = src;
        img.onclick = (e) => { e.stopPropagation(); document.getElementById('lightboxImg').src = src; document.getElementById('lightboxOverlay').classList.add('open'); };
        bubble.appendChild(img);
      }
    }
  }
  div.appendChild(bubble);
  if (histIdx !== undefined) {
    const entry = history[histIdx];
    if (entry) { const meta = renderMsgMeta(entry); if (meta) div.appendChild(meta); }
  }
  // Action bar — added only during rebuildMessages, not during streaming
  const actions = document.createElement('div'); actions.className = 'msg-actions';
  if (role === 'user' && histIdx !== undefined) {
    const entry = history[histIdx];
    if (entry && entry.timestamp) {
      const ts = document.createElement('span'); ts.className = 'action-time';
      ts.textContent = fmtTime(entry.timestamp); actions.appendChild(ts);
    }
    const btn = document.createElement('button'); btn.className = 'msg-action'; btn.textContent = 'edit';
    btn.onclick = () => editMessage(histIdx); actions.appendChild(btn);
  }
  if (role === 'assistant' && histIdx !== undefined) {
    const btn = document.createElement('button'); btn.className = 'msg-action'; btn.textContent = '↻ retry';
    btn.onclick = () => regenerateResponse(histIdx); actions.appendChild(btn);
    const entry = history[histIdx];
    if (entry?.versions?.length > 1) {
      const vi = entry.versionIndex || 0;
      const swipe = document.createElement('div'); swipe.className = 'swipe-bar';
      swipe.innerHTML = `<button onclick="swipeVersion(${histIdx},-1)"${vi<=0?' disabled':''}>‹</button><span>${vi+1}/${entry.versions.length}</span><button onclick="swipeVersion(${histIdx},1)"${vi>=entry.versions.length-1?' disabled':''}>›</button>`;
      actions.appendChild(swipe);
    }
  }
  div.appendChild(actions);
  container.appendChild(div);
  scrollToBottom();
  return div;
}

function rebuildMessages() {
  const container = document.getElementById('messages'); container.innerHTML = '';
  if (!history.length) { container.innerHTML = '<div class="welcome">' + getWelcomeText() + '</div>'; return; }
  const conv = currentConv();
  const compressedUpTo = (conv?.compressionSummary && conv?.compressedUpTo) ? conv.compressedUpTo : 0;
  let lastTs = 0;
  history.forEach((entry, idx) => {
    // Time separator if gap > 5 minutes
    const ts = entry.timestamp || 0;
    if (ts && lastTs && (ts - lastTs) > 5 * 60 * 1000) {
      const sep = document.createElement('div'); sep.className = 'time-sep';
      const d = new Date(ts);
      const now = new Date();
      const isToday = d.toDateString() === now.toDateString();
      const yesterday = new Date(now); yesterday.setDate(now.getDate()-1);
      const isYesterday = d.toDateString() === yesterday.toDateString();
      const timeStr = d.toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'});
      if (isToday) sep.textContent = timeStr;
      else if (isYesterday) sep.textContent = 'yesterday ' + timeStr;
      else sep.textContent = d.toLocaleDateString('zh-CN',{month:'short',day:'numeric'}) + ' ' + timeStr;
      container.appendChild(sep);
    }
    if (ts) lastTs = ts;
    // Insert compression boundary line before the message at compressedUpTo
    if (idx === compressedUpTo && compressedUpTo > 0) {
      const line = document.createElement('div');
      line.className = 'compress-line';
      line.innerHTML = `<div class="compress-line-inner"><span class="sparkle">✦</span><span>前 ${compressedUpTo} 条已压缩</span><a onclick="openCompressDialog()">查看摘要</a></div>`;
      container.appendChild(line);
    }
    const content = typeof entry.content === 'string' ? entry.content : (Array.isArray(entry.content) ? entry.content.filter(b=>b.type==='text').map(b=>b.text||'').join(' ') : '');
    const hasImage = Array.isArray(entry.content) && entry.content.some(b => b.type === 'image');
    const div = document.createElement('div');
    div.className = 'msg msg-' + entry.role + (idx < compressedUpTo ? ' pre-compress' : '');
    div.dataset.idx = idx;
    const bubble = document.createElement('div'); bubble.className = 'msg-bubble';

    if (entry.role === 'assistant' && Array.isArray(entry.blocks) && entry.blocks.length) {
      // New schema: render each block in the order they were emitted.
      // This preserves the real thinking → text → tool → text interleaving.
      for (const blk of entry.blocks) {
        if (blk.type === 'thinking') {
          const td = document.createElement('div'); td.className='thinking-block';
          td.innerHTML = `<div class="thinking-label" onclick="this.parentElement.classList.toggle('expanded')">thinking...</div><div class="thinking-content">${escapeHtml(blk.thinking||'')}</div>`;
          bubble.appendChild(td);
        } else if (blk.type === 'text') {
          const textDiv = document.createElement('div'); textDiv.className='text-block';
          textDiv.innerHTML = renderMarkdown(blk.text || '');
          bubble.appendChild(textDiv);
        } else if (blk.type === 'tool_use') {
          const tb = document.createElement('div'); tb.className='tool-block';
          if (blk.id) tb.dataset.toolId = blk.id;
          const tlabel = document.createElement('div'); tlabel.className='tool-label';
          tlabel.innerHTML = `<span class="tool-name">${escapeHtml(blk.name||'')}</span>`;
          tlabel.onclick = () => tb.classList.toggle('expanded');
          tb.appendChild(tlabel);
          if (blk.result !== undefined) {
            const resultDiv = document.createElement('div'); resultDiv.className='tool-result';
            const txt = typeof blk.result === 'string' ? blk.result : JSON.stringify(blk.result);
            resultDiv.textContent = txt.slice(0, 500) + (txt.length > 500 ? '...' : '');
            tb.appendChild(resultDiv);
          }
          bubble.appendChild(tb);
        }
      }
    } else {
      // Legacy entries (pre-blocks schema): fall back to thinking-then-tools-then-text ordering.
      // Old conversations won't have correct interleaving, but they'll at least render.
      if (entry.role === 'assistant' && entry.thinking) {
        const td = document.createElement('div'); td.className = 'thinking-block';
        td.innerHTML = `<div class="thinking-label" onclick="this.parentElement.classList.toggle('expanded')">thinking...</div><div class="thinking-content">${escapeHtml(entry.thinking)}</div>`;
        bubble.appendChild(td);
      }
      if (entry.role === 'assistant' && entry.toolCalls?.length) {
        entry.toolCalls.forEach(tc => {
          const tb = document.createElement('div'); tb.className = 'tool-block';
          tb.innerHTML = `<div class="tool-label" onclick="this.parentElement.classList.toggle('expanded')"><span class="tool-name">${escapeHtml(tc.name)}</span></div><div class="tool-result">${escapeHtml(tc.result||'')}</div>`;
          bubble.appendChild(tb);
        });
      }
      const textDiv = document.createElement('div');
      textDiv.innerHTML = content ? renderMarkdown(content) : '';
      bubble.appendChild(textDiv);
    }
    // Render image thumbnail for messages with images
    if (hasImage && entry.role === 'user') {
      const imgBlock = entry.content.find(b => b.type === 'image');
      if (imgBlock && imgBlock.source) {
        const src = 'data:' + (imgBlock.source.media_type||'image/jpeg') + ';base64,' + imgBlock.source.data;
        const img = document.createElement('img');
        img.className = 'msg-thumb';
        img.src = src;
        img.onclick = (e) => { e.stopPropagation(); document.getElementById('lightboxImg').src = src; document.getElementById('lightboxOverlay').classList.add('open'); };
        bubble.appendChild(img);
      }
    }
    div.appendChild(bubble);
    const meta = renderMsgMeta(entry); if (meta) div.appendChild(meta);
    // Actions
    const actions = document.createElement('div'); actions.className = 'msg-actions';
    if (entry.role === 'user') {
      if (entry.timestamp) { const ts = document.createElement('span'); ts.className='action-time'; ts.textContent=fmtTime(entry.timestamp); actions.appendChild(ts); }
      const btn = document.createElement('button'); btn.className = 'msg-action'; btn.textContent = 'edit';
      btn.onclick = () => editMessage(idx); actions.appendChild(btn);
    }
    if (entry.role === 'assistant') {
      const btn = document.createElement('button'); btn.className = 'msg-action'; btn.textContent = '↻ retry';
      btn.onclick = () => regenerateResponse(idx); actions.appendChild(btn);
      if (entry.versions?.length > 1) {
        const vi = entry.versionIndex || 0;
        const swipe = document.createElement('div'); swipe.className = 'swipe-bar';
        swipe.innerHTML = `<button onclick="swipeVersion(${idx},-1)"${vi<=0?' disabled':''}>‹</button><span>${vi+1}/${entry.versions.length}</span><button onclick="swipeVersion(${idx},1)"${vi>=entry.versions.length-1?' disabled':''}>›</button>`;
        actions.appendChild(swipe);
      }
    }
    div.appendChild(actions);
    container.appendChild(div);
  });
  container.scrollTop = container.scrollHeight;
  updateContextBar();
}

function swipeVersion(idx, dir) {
  const entry = history[idx]; if (!entry?.versions) return;
  const newVi = (entry.versionIndex || 0) + dir;
  if (newVi < 0 || newVi >= entry.versions.length) return;
  entry.versionIndex = newVi;
  entry.content = entry.versions[newVi];
  rebuildMessages();
  saveCurrentConv();
}


// ============================================================
//  EDITING
// ============================================================
function editMessage(idx) {
  const msgDiv = document.querySelector(`.msg[data-idx="${idx}"]`); if (!msgDiv) return;
  const entry = history[idx];
  const content = typeof entry.content === 'string' ? entry.content : '';
  msgDiv.classList.add('msg-editing');
  let editArea = msgDiv.querySelector('.edit-area');
  if (!editArea) {
    editArea = document.createElement('div'); editArea.className = 'edit-area';
    const ta = document.createElement('textarea'); ta.className = 'edit-textarea'; ta.value = content;
    const btns = document.createElement('div'); btns.className = 'edit-btns';
    btns.innerHTML = `<button onclick="cancelEdit(${idx})">cancel</button><button class="primary" onclick="submitEdit(${idx})">send</button>`;
    editArea.appendChild(ta); editArea.appendChild(btns);
    msgDiv.insertBefore(editArea, msgDiv.querySelector('.msg-actions'));
  } else { editArea.querySelector('textarea').value = content; }
  const ta = editArea.querySelector('textarea');
  ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; ta.focus();
}
function cancelEdit(idx) { const d = document.querySelector(`.msg[data-idx="${idx}"]`); if(d) d.classList.remove('msg-editing'); }

async function submitEdit(idx) {
  const msgDiv = document.querySelector(`.msg[data-idx="${idx}"]`); if(!msgDiv) return;
  const newText = msgDiv.querySelector('.edit-textarea').value.trim(); if(!newText) return;
  history = history.slice(0, idx);
  clampCompressionBoundary();
  history.push({ role: 'user', content: newText, timestamp: Date.now() });
  rebuildMessages();
  if (gatewayEnabled()) {
    await gatewayGenerate({ message: newText, editAt: idx });
    return;
  }
  await generateAndAppendResponse();
}

