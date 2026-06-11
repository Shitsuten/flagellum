// ============================================================
//  COMPRESSION
// ============================================================
const COMPRESS_KEEP_RECENT = 2; // 保留最后 N 条消息不压缩

function getCompressRange() {
  // Returns { upTo, keepCount } — upTo = 将要压缩到的 history 索引
  const conv = currentConv();
  const alreadyCompressed = conv?.compressedUpTo || 0;
  const total = history.length;
  const upTo = Math.max(alreadyCompressed, total - COMPRESS_KEEP_RECENT);
  return { upTo, keepCount: total - upTo, alreadyCompressed, total };
}

let _compressDialogUpTo = 0;  // current boundary selection in dialog

function renderCompressDialog() {
  const conv = currentConv();
  if (!conv) return;
  const upTo = _compressDialogUpTo;
  const total = history.length;
  const alreadyCompressed = conv.compressedUpTo || 0;
  const existing = conv.compressionSummary;

  const statsEl = document.getElementById('compressStats');
  const previewEl = document.getElementById('compressPreview');
  const upBtn = document.getElementById('compressUpBtn');
  const downBtn = document.getElementById('compressDownBtn');
  const saveBtn = document.getElementById('compressSaveBtn');
  const genBtn = document.getElementById('compressGenBtn');
  const clearBtn = document.getElementById('compressClearBtn');
  const summaryEl = document.getElementById('compressSummary');
  const hintEl = document.getElementById('compressHint');

  // Stats
  const compressCount = upTo;
  const keepCount = total - upTo;
  const summaryTok = existing ? estimateTokens(existing) : 0;
  const summaryTokStr = summaryTok ? ' ~' + fmtTok(summaryTok) + ' tok' : '';
  statsEl.innerHTML = `<span>压缩 <strong>${compressCount} 条</strong></span>
    <span>保留 <strong>${keepCount} 条</strong></span>
    ${existing ? `<span style="color:var(--accent);opacity:.85">· 已有摘要${summaryTokStr}</span>` : ''}`;

  // Nudge button limits: boundary must leave >=1 compressed and >=1 kept
  // Can't go below alreadyCompressed (would un-compress; user should clear first)
  const minUpTo = Math.max(1, alreadyCompressed);
  const maxUpTo = total - 1;
  upBtn.disabled = upTo <= minUpTo;
  downBtn.disabled = upTo >= maxUpTo;

  // Preview: last message above the line, first message below
  previewEl.innerHTML = '';
  const addRow = (kind, msg, idx) => {
    const row = document.createElement('div');
    row.className = 'compress-preview-row ' + kind;
    const cc = typeof msg.content === 'string' ? msg.content : '[media]';
    const preview = cc.replace(/\n/g, ' ').slice(0, 80);
    row.innerHTML = `<div class="compress-preview-label">${kind === 'above' ? '压缩尾' : '保留首'} · #${idx+1}</div>
      <div class="compress-preview-text"><span class="compress-preview-role">${msg.role === 'user' ? 'User' : 'Assistant'}:</span>${escapeHtml(preview)}${cc.length > 80 ? '…' : ''}</div>`;
    return row;
  };
  if (upTo > 0 && history[upTo-1]) previewEl.appendChild(addRow('above', history[upTo-1], upTo-1));
  const dash = document.createElement('div'); dash.className = 'compress-dashed-line'; previewEl.appendChild(dash);
  if (history[upTo]) previewEl.appendChild(addRow('below', history[upTo], upTo));

  // Buttons state
  if (existing) {
    clearBtn.style.display = '';
    saveBtn.textContent = (upTo === alreadyCompressed) ? '保存修改' : '更新压缩';
    saveBtn.disabled = !summaryEl.value.trim();
    genBtn.textContent = '重新生成';
  } else {
    clearBtn.style.display = 'none';
    saveBtn.textContent = '确认压缩';
    saveBtn.disabled = !summaryEl.value.trim();
    genBtn.textContent = '生成摘要';
  }
  genBtn.disabled = compressCount === 0;

  hintEl.textContent = existing
    ? '调整上下按钮可以移动分界线（不能回退到当前已压缩位置之前）。改变了范围记得重新生成摘要。'
    : '调整上下按钮移动分界线。调整后点「生成摘要」让 Claude 总结，之后可手动编辑再保存。';
}

function nudgeCompressBoundary(delta) {
  const conv = currentConv();
  if (!conv) return;
  const alreadyCompressed = conv.compressedUpTo || 0;
  const minUpTo = Math.max(1, alreadyCompressed);
  const maxUpTo = history.length - 1;
  _compressDialogUpTo = Math.max(minUpTo, Math.min(maxUpTo, _compressDialogUpTo + delta));
  renderCompressDialog();
}

function openCompressDialog() {
  const conv = currentConv();
  if (!conv) return;
  const { upTo } = getCompressRange();
  _compressDialogUpTo = upTo;
  const existing = conv.compressionSummary;
  document.getElementById('compressSummary').value = existing || '';
  document.getElementById('compressSummary').disabled = false;
  renderCompressDialog();
  document.getElementById('compressOverlay').classList.add('open');
  // Live-update save button as user types
  const sumEl = document.getElementById('compressSummary');
  sumEl.oninput = () => {
    document.getElementById('compressSaveBtn').disabled = !sumEl.value.trim();
  };
}

function closeCompressDialog() {
  document.getElementById('compressOverlay').classList.remove('open');
}

async function generateCompressionNow() {
  const conv = currentConv();
  if (!conv || !config.apiKey) { alert('需要 API key'); return; }
  const upTo = _compressDialogUpTo;
  const alreadyCompressed = conv.compressedUpTo || 0;
  const slice = history.slice(0, upTo);
  if (slice.length === 0) { alert('没有可压缩的消息'); return; }

  const summaryEl = document.getElementById('compressSummary');
  const saveBtn = document.getElementById('compressSaveBtn');
  const genBtn = document.getElementById('compressGenBtn');
  genBtn.disabled = true; genBtn.textContent = '生成中...';
  summaryEl.disabled = true;
  saveBtn.disabled = true;

  // Build transcript — if there's an earlier summary, prepend it so continuity is preserved
  const earlierSummary = conv.compressionSummary && alreadyCompressed > 0 ? conv.compressionSummary : '';
  const transcriptSlice = slice.slice(alreadyCompressed);
  const transcript = transcriptSlice.map(m => {
    const cc = typeof m.content === 'string' ? m.content : '[media]';
    return (m.role === 'user' ? 'User' : 'Assistant') + ': ' + cc;
  }).join('\n\n');

  const systemPrompt = 'Compress the following conversation into a dense summary. Preserve: concrete facts (names, numbers, technical details, file paths, config); open tasks and unresolved questions; emotional tone and rapport; technical context (project names, architecture, bugs discussed). Target 500-1500 characters. Output only the summary body — no JSON, no preamble. Use the same language as the conversation.';

  const userContent = earlierSummary
    ? `【此前已有的摘要】\n${earlierSummary}\n\n【新增需要压缩的对话】\n${transcript}\n\n请把上面两部分合并成一份新的完整摘要。`
    : transcript;

  try {
    const endpoint = (config.endpoint || DEFAULTS.anthropic.endpoint) + '/v1/messages';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {'Content-Type':'application/json','x-api-key':config.apiKey,'Authorization':'Bearer '+config.apiKey,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true','anthropic-beta':'prompt-caching-2024-07-31'},
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{role:'user', content: userContent}]
      })
    });
    if (!res.ok) throw new Error(res.status + ': ' + (await res.text()).slice(0,200));
    const data = await res.json();
    const text = (data.content || []).find(b => b.type === 'text')?.text || '';
    summaryEl.value = text.trim();
    saveBtn.disabled = !text.trim();
  } catch (e) {
    alert('生成失败: ' + e.message);
  } finally {
    summaryEl.disabled = false;
    genBtn.disabled = false;
    genBtn.textContent = conv.compressionSummary ? '重新生成' : '生成摘要';
  }
}

async function saveCompression() {
  const conv = currentConv();
  if (!conv) return;
  const summary = document.getElementById('compressSummary').value.trim();
  if (!summary) { alert('摘要不能为空'); return; }

  conv.compressedUpTo = _compressDialogUpTo;
  conv.compressionSummary = summary;

  // Invalidate all stale usage so context bar recalculates via estimate path
  for (let i = 0; i < history.length; i++) {
    delete history[i].usage;
  }

  try { await saveConvToServer(conv); } catch(e) { alert('保存失败: ' + e.message); return; }
  closeCompressDialog();
  rebuildMessages();
  updateContextBar();
}

async function clearCompression() {
  const conv = currentConv();
  if (!conv) return;
  if (!confirm('确定清除压缩？之后所有消息都会重新读入。')) return;
  delete conv.compressionSummary;
  delete conv.compressedUpTo;
  try { await saveConvToServer(conv); } catch(e) { alert('保存失败: ' + e.message); return; }
  closeCompressDialog();
  rebuildMessages();
  updateContextBar();
}

// Build messages for API call — injects synthetic summary pair if compressed
function buildApiMessages() {
  const conv = currentConv();
  const compressedUpTo = conv?.compressedUpTo || 0;
  const summary = conv?.compressionSummary;
  let slice;
  if (summary && compressedUpTo > 0) {
    slice = history.slice(compressedUpTo);
  } else {
    slice = history;
  }
  const filtered = slice.filter(m => m.role==='user' || (m.role==='assistant' && m.content)).map(m => {
    if (!m.timestamp) return m;
    const d = new Date(m.timestamp);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const mon = months[d.getMonth()];
    const day = d.getDate();
    const hh = String(d.getHours()).padStart(2,'0');
    const mm = String(d.getMinutes()).padStart(2,'0');
    const c = typeof m.content === 'string' ? '[' + mon + ' ' + day + ', ' + hh + ':' + mm + ']\n\n' + m.content : m.content;
    return { ...m, content: c };
  });
  if (summary && compressedUpTo > 0) {
    return [
      { role:'user', content: '[System: 以下是我与你此前对话的压缩摘要。请把它当作真实发生过的语境，自然地接续下去，不要在回复里提及这是摘要。]' },
      { role:'assistant', content: summary },
      ...filtered
    ];
  }
  return filtered;
}

function renderMsgMeta(entry) {
  if (!entry) return null;
  const parts = [];
  if (entry.timestamp) parts.push('<span class="meta-time">' + fmtTime(entry.timestamp) + '</span>');
  if (entry.role === 'assistant' && entry.usage) {
    const u = entry.usage;
    const seg = [];
    if (u.input_tokens != null) seg.push('in ' + fmtTok(u.input_tokens));
    if (u.output_tokens != null) seg.push('out ' + fmtTok(u.output_tokens));
    if (u.cache_read_input_tokens) seg.push('<span class="meta-cache">cache ' + fmtTok(u.cache_read_input_tokens) + '</span>');
    if (seg.length) parts.push(seg.join(' · '));
  }
  if (!parts.length) return null;
  const meta = document.createElement('div'); meta.className = 'msg-meta';
  meta.innerHTML = parts.join('<span class="meta-dot">·</span>');
  // edit按钮会在外部注入到meta里
  return meta;
}

// ============================================================
//  SENDING — unified response generation
// ============================================================
function autoResize(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 160) + 'px'; }

let isComposing = false;
let _abortCtrl = null;

function stopStreaming() {
  if (_abortCtrl) { _abortCtrl.abort(); _abortCtrl = null; }
}

function showToast(msg, ms) {
  let el = document.getElementById('chatToast');
  if (!el) { el = document.createElement('div'); el.id = 'chatToast'; el.className = 'chat-toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms || 2500);
}
document.getElementById('input').addEventListener('compositionstart', () => isComposing = true);
document.getElementById('input').addEventListener('compositionend', () => isComposing = false);
function handleKey(e) {
  const isMobile = window.innerWidth <= 768 || 'ontouchstart' in window;
  if (e.key === 'Enter' && !e.shiftKey && !isComposing && !isMobile) { e.preventDefault(); sendMessage(); }
}

async function sendMessage() {
  const input = document.getElementById('input');
  const text = input.value.trim();
  if (!text || streaming || !config.apiKey || _switchLock) return;
  input.value = ''; input.style.height = 'auto';

  const img = pendingImage;
  if (pendingImage) clearImage();
  let userContent;
  if (img) {
    userContent = [
      { type:'image', source:{ type:'base64', media_type:img.media_type, data:img.base64 } },
      { type:'text', text: text || '看看这张图' }
    ];
  } else {
    userContent = text;
  }
  history.push({ role: 'user', content: userContent, timestamp: Date.now() });
  addMessageToDOM('user', text, history.length - 1, userContent !== text ? userContent : null);

  if (gatewayEnabled()) {
    // Gateway owns the conversation file during the send — no client-side save
    await gatewayGenerate({
      message: text || (img ? '看看这张图' : ''),
      imageData: img?.base64, imageMediaType: img?.media_type
    });
    return;
  }

  // Force immediate save to prevent data loss (especially images)
  try { await saveCurrentConv(); } catch(e) { console.warn('Pre-send save failed:', e); }
  await generateAndAppendResponse();
}

async function regenerateResponse(idx) {
  if (streaming || _switchLock) return;
  const entry = history[idx];
  const versions = entry.versions || [entry.content];

  if (gatewayEnabled()) {
    // Replay the user message before idx via edit_at (server re-slices)
    let uIdx = idx - 1;
    while (uIdx >= 0 && history[uIdx].role !== 'user') uIdx--;
    if (uIdx < 0) return;
    const uEntry = history[uIdx];
    const uText = typeof uEntry.content === 'string' ? uEntry.content
      : uEntry.content.filter(b => b.type === 'text').map(b => b.text || '').join('\n');
    let img = null;
    if (Array.isArray(uEntry.content)) img = uEntry.content.find(b => b.type === 'image')?.source || null;
    history = history.slice(0, uIdx + 1);
    clampCompressionBoundary();
    rebuildMessages();
    await gatewayGenerate({
      message: uText, editAt: uIdx,
      imageData: img?.data, imageMediaType: img?.media_type
    }, versions);
    return;
  }

  history = history.slice(0, idx);
  clampCompressionBoundary();
  rebuildMessages();
  await generateAndAppendResponse(versions);
}

// Editing/regenerating past the compression boundary leaves the summary
// describing deleted messages — drop it so raw history flows back in.
function clampCompressionBoundary() {
  const conv = currentConv();
  if (conv && (conv.compressedUpTo || 0) > history.length) {
    delete conv.compressionSummary;
    delete conv.compressedUpTo;
  }
}

/**
 * Shared response generation — used by send, edit, and regenerate.
 * @param {Array} [existingVersions] — for regenerate, previous versions to append to
 */
async function generateAndAppendResponse(existingVersions) {
  streaming = true;
  const sendBtn = document.getElementById('sendBtn');
  sendBtn.textContent = '■';
  sendBtn.disabled = false;
  sendBtn.onclick = (e) => { e.preventDefault(); stopStreaming(); };
  const assistIdx = history.length;
  const msgDiv = addMessageToDOM('assistant', '', assistIdx);
  msgDiv.classList.add('streaming');
  const bubble = msgDiv.querySelector('.msg-bubble');
  bubble.innerHTML = '';
  let fullText = '', resultBlocks = null;

  try {
    if (config.provider === 'anthropic') {
      const r = await streamAnthropic(bubble);
      fullText = r.text; resultBlocks = r.blocks;
    } else {
      const r = await streamOpenAI(bubble);
      fullText = r.text; resultBlocks = r.blocks;
    }
  } catch(err) {
    if (err.name === 'AbortError') {
      if (!fullText && bubble) bubble.innerHTML += '<span style="color:var(--text-muted);font-size:.75rem"> (stopped)</span>';
    } else {
      fullText = 'Error: ' + err.message;
      bubble.innerHTML = `<span style="color:#e54">${escapeHtml(fullText)}</span>`;
    }
  }

  // Mid-stream save: persist assistant response immediately so tab close / crash won't lose it
  if (fullText || (resultBlocks && resultBlocks.length)) {
    history.push({
      role: 'assistant',
      content: fullText,
      thinking: lastThinking,
      blocks: resultBlocks,
      timestamp: Date.now(),
      usage: lastUsage,
      _partial: true
    });
    try { await saveCurrentConv(); } catch(e) { console.warn('Mid-stream save failed:', e); }
    history.pop();
  }

  msgDiv.classList.remove('streaming');

  // Build history entry — blocks preserves the true interleaved order (thinking/text/tool_use
  // each as its own item, tool_use carries its result). rebuildMessages uses this when present.
  const entry = {
    role:'assistant',
    content: fullText,
    thinking: lastThinking,
    toolCalls: [...lastToolCalls],
    blocks: resultBlocks,
    timestamp: Date.now(),
    usage: lastUsage
  };
  if (existingVersions) {
    existingVersions.push(fullText);
    entry.versions = existingVersions;
    entry.versionIndex = existingVersions.length - 1;
  }
  history.push(entry);
  lastToolCalls = [];
  streaming = false;
  _abortCtrl = null;
  const sendBtn2 = document.getElementById('sendBtn');
  sendBtn2.textContent = '↑';
  sendBtn2.disabled = !config.apiKey;
  sendBtn2.onclick = () => sendMessage();
  try { await saveCurrentConv(); } catch(e) { console.warn('Post-response save failed:', e); }
  // Ingest: send to gateway, strip only what was actually extracted
  if (fullText && fullText.includes('<mem')) {
    try {
      const igRes = await fetch(CHAT_API + '/ingest', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({text: fullText})
      });
      const igData = await igRes.json();
      if (igData.count) {
        console.log('[mem] ingested', igData.count, 'memories');
        showToast('mem saved · ' + igData.count + (igData.count === 1 ? ' memory' : ' memories'));
        // Only strip the exact content that was extracted
        let cleaned = fullText;
        for (const item of (igData.extracted || [])) {
          const tag = new RegExp('<mem(?:\\s+category="[^"]*")?\\s*>' + item.content.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '<\\/mem>', 's');
          cleaned = cleaned.replace(tag, '');
        }
        cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
        if (cleaned !== fullText) {
          entry.content = cleaned;
          // Update only text blocks in the bubble, preserve thinking/tool blocks
          const lastBubble = document.querySelector('.msg:last-child .msg-bubble');
          if (lastBubble) {
            const textBlocks = lastBubble.querySelectorAll('.text-block');
            if (textBlocks.length) {
              textBlocks.forEach(tb => { tb.innerHTML = renderMarkdown(cleaned); });
            } else if (!lastBubble.querySelector('.thinking-block, .tool-block')) {
              lastBubble.innerHTML = renderMarkdown(cleaned);
            }
          }
          saveCurrentConv().catch(()=>{});
        }
      }
    } catch(e) { console.warn('[mem] ingest failed:', e); }
  }
  addActionsToLastMessages();
  updateContextBar();
}

function addActionsToLastMessages() {
  document.querySelectorAll('.msg').forEach(div => {
    const old = div.querySelector('.msg-actions'); if(old) old.remove();
    const oldMeta = div.querySelector('.msg-meta'); if(oldMeta) oldMeta.remove();
    const idx = parseInt(div.dataset.idx); if(isNaN(idx)) return;
    const entry = history[idx]; if(!entry) return;
    const actions = document.createElement('div'); actions.className = 'msg-actions';
    if (entry.role === 'user') {
      if (entry.timestamp) { const ts = document.createElement('span'); ts.className='action-time'; ts.textContent=fmtTime(entry.timestamp); actions.appendChild(ts); }
      const btn = document.createElement('button'); btn.className='msg-action'; btn.textContent='edit';
      btn.onclick = ()=>editMessage(idx); actions.appendChild(btn);
    }
    if (entry.role === 'assistant') {
      const btn = document.createElement('button'); btn.className='msg-action'; btn.textContent='↻ retry';
      btn.onclick = ()=>regenerateResponse(idx); actions.appendChild(btn);
      if (entry.versions?.length > 1) {
        const vi = entry.versionIndex||0;
        const swipe = document.createElement('div'); swipe.className='swipe-bar';
        swipe.innerHTML = `<button onclick="swipeVersion(${idx},-1)"${vi<=0?' disabled':''}>‹</button><span>${vi+1}/${entry.versions.length}</span><button onclick="swipeVersion(${idx},1)"${vi>=entry.versions.length-1?' disabled':''}>›</button>`;
        actions.appendChild(swipe);
      }
    }
    div.appendChild(actions);
    const meta = renderMsgMeta(entry); if (meta) div.appendChild(meta);
  });
}

// ============================================================
//  GATEWAY MODE — server assembles the prompt (BP1-4 cache layout,
//  server-side MCP, auto cycle compression). Web becomes a thin client.
// ============================================================
function gatewayEnabled() {
  return config.provider === 'anthropic' && config.useGateway !== false;
}

async function reloadCurrentConv() {
  try {
    const res = await fetch(CHAT_API + '/conversations/' + currentConvId);
    if (!res.ok) return;
    const conv = await res.json();
    const idx = conversations.findIndex(c => c.id === currentConvId);
    if (idx >= 0) conversations[idx] = conv;
    history = (conv.messages || []).map(m => ({...m}));
    rebuildMessages();
  } catch(e) { console.warn('[gateway] conv reload failed:', e); }
}

const MEM_TAG_RE = /<mem(?:\s+category="[^"]*")?\s*>[\s\S]*?<\/mem>/g;

// Full send flow over the gateway: stream → reload conv → post-process
async function gatewayGenerate(params, versionsStash) {
  streaming = true;
  const sendBtn = document.getElementById('sendBtn');
  sendBtn.textContent = '■';
  sendBtn.disabled = false;
  sendBtn.onclick = (e) => { e.preventDefault(); stopStreaming(); };
  const msgDiv = addMessageToDOM('assistant', '', history.length);
  msgDiv.classList.add('streaming');
  const bubble = msgDiv.querySelector('.msg-bubble');
  bubble.innerHTML = '';

  let aborted = false;
  try {
    await streamGateway(bubble, params);
  } catch(err) {
    if (err.name === 'AbortError') {
      aborted = true;  // gateway keeps generating server-side; reload picks it up
    } else {
      bubble.innerHTML = `<span style="color:#e54">${escapeHtml('Error: ' + err.message)}</span>`;
    }
  }
  msgDiv.classList.remove('streaming');
  streaming = false;
  _abortCtrl = null;
  sendBtn.textContent = '↑';
  sendBtn.disabled = !config.apiKey;
  sendBtn.onclick = () => sendMessage();

  if (aborted) await new Promise(r => setTimeout(r, 800));
  await reloadCurrentConv();

  const last = history[history.length - 1];
  let needsSave = false;

  // Gateway already auto-ingested <mem> tags server-side — strip them from
  // display/storage here, do NOT re-ingest (would duplicate memories)
  if (last?.role === 'assistant' && typeof last.content === 'string' && last.content.includes('<mem')) {
    const cleaned = last.content.replace(MEM_TAG_RE, '').replace(/\n{3,}/g, '\n\n').trim();
    if (cleaned !== last.content) {
      last.content = cleaned;
      if (Array.isArray(last.blocks)) {
        last.blocks = last.blocks.map(b => b.type === 'text' && b.text
          ? {...b, text: b.text.replace(MEM_TAG_RE, '').replace(/\n{3,}/g, '\n\n').trim()} : b);
      }
      showToast('mem saved');
      needsSave = true;
    }
  }

  // Re-attach client-side version history after regenerate
  if (versionsStash && last?.role === 'assistant') {
    versionsStash.push(last.content);
    last.versions = versionsStash;
    last.versionIndex = versionsStash.length - 1;
    needsSave = true;
  }

  if (needsSave) {
    rebuildMessages();
    try { await saveCurrentConv(); } catch(e) {}
  }

  // Title for fresh conversations (gateway doesn't set titles)
  const conv = currentConv();
  if (conv && conv.title === '新对话' && history.length) {
    conv.title = (typeof history[0].content === 'string' ? history[0].content : '图片消息').slice(0, 30);
    fetch(CHAT_API + '/conversations/' + conv.id, {
      method: 'PATCH', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ title: conv.title })
    }).catch(()=>{});
    renderConvList();
  }
  updateContextBar();
}

// SSE consumer for /gateway/send — same Anthropic event format as the direct
// path, plus the custom gateway_tool_result event for live tool output
async function streamGateway(bubble, params) {
  _abortCtrl = new AbortController();
  const res = await fetch(CHAT_API + '/gateway/send', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      conversation_id: currentConvId,
      message: params.message,
      image_data: params.imageData || undefined,
      image_media_type: params.imageMediaType || undefined,
      edit_at: params.editAt
    }),
    signal: _abortCtrl.signal
  });
  if (!res.ok) throw new Error(res.status + ': ' + (await res.text()).slice(0, 200));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let thinkingDiv = null, currentThinkingContent = '';
  let currentTextBlock = null, currentTextContent = '';
  let currentBlockType = null;
  lastUsage = null; lastThinking = ''; lastToolCalls = [];
  let thinkingText = '';

  while (true) {
    const {done, value} = await reader.read(); if (done) break;
    buffer += decoder.decode(value, {stream: true});
    const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6); if (data === '[DONE]') continue;
      let evt = null;
      try { evt = JSON.parse(data); } catch(e) { continue; }
      {
        if (window.__debugSSE) console.log('[SSE/GW]', evt.type || '(no-type)', evt);

        if (evt.type === 'error') {
          throw new Error(evt.error?.message || 'gateway error');
        }
        if (evt.type === 'gateway_tool_result') {
          const matchDiv = bubble.querySelector('.tool-block[data-tool-id="' + CSS.escape(evt.tool_use_id) + '"]');
          if (matchDiv && !matchDiv.querySelector('.tool-result')) {
            const resultDiv = document.createElement('div'); resultDiv.className = 'tool-result';
            resultDiv.textContent = evt.content || '';
            matchDiv.appendChild(resultDiv);
          }
          continue;
        }
        if (evt.type === 'message_start' && evt.message?.usage) {
          if (!lastUsage) lastUsage = { ...evt.message.usage };
          else {
            lastUsage.input_tokens = evt.message.usage.input_tokens;
            lastUsage.output_tokens = (lastUsage.output_tokens || 0) + (evt.message.usage.output_tokens || 0);
            if (evt.message.usage.cache_read_input_tokens != null) lastUsage.cache_read_input_tokens = (lastUsage.cache_read_input_tokens || 0) + evt.message.usage.cache_read_input_tokens;
            if (evt.message.usage.cache_creation_input_tokens != null) lastUsage.cache_creation_input_tokens = (lastUsage.cache_creation_input_tokens || 0) + evt.message.usage.cache_creation_input_tokens;
          }
        } else if (evt.type === 'message_delta' && evt.usage) {
          lastUsage = lastUsage || {};
          lastUsage.output_tokens = (lastUsage.output_tokens || 0) + (evt.usage.output_tokens || 0);
        }

        if (evt.type === 'content_block_start') {
          currentBlockType = evt.content_block?.type || null;
          if (currentBlockType === 'thinking') {
            thinkingDiv = document.createElement('div'); thinkingDiv.className = 'thinking-block';
            thinkingDiv.innerHTML = '<div class="thinking-label" onclick="this.parentElement.classList.toggle(\'expanded\')">thinking...</div><div class="thinking-content"></div>';
            bubble.appendChild(thinkingDiv); currentThinkingContent = '';
          } else if (currentBlockType === 'text') {
            currentTextBlock = document.createElement('div'); currentTextBlock.className = 'text-block';
            bubble.appendChild(currentTextBlock); currentTextContent = '';
          } else if (currentBlockType === 'tool_use') {
            const toolDiv = document.createElement('div'); toolDiv.className = 'tool-block';
            toolDiv.dataset.toolId = evt.content_block.id;
            const toolLabel = document.createElement('div'); toolLabel.className = 'tool-label';
            toolLabel.innerHTML = '<span class="tool-name">' + escapeHtml(evt.content_block.name) + '</span>';
            toolLabel.onclick = () => toolDiv.classList.toggle('expanded');
            toolDiv.appendChild(toolLabel);
            bubble.appendChild(toolDiv);
            scrollToBottom();
          }
        } else if (evt.type === 'content_block_delta') {
          if (evt.delta?.type === 'thinking_delta') {
            currentThinkingContent += evt.delta.thinking || '';
            thinkingText += evt.delta.thinking || '';
            if (thinkingDiv) thinkingDiv.querySelector('.thinking-content').textContent = currentThinkingContent;
          } else if (evt.delta?.type === 'text_delta') {
            currentTextContent += evt.delta.text || '';
            if (currentTextBlock) { currentTextBlock.textContent = currentTextContent; scrollToBottom(); }
          }
        } else if (evt.type === 'content_block_stop') {
          if (currentBlockType === 'text' && currentTextBlock !== null) {
            currentTextBlock.innerHTML = renderMarkdown(currentTextContent.replace(MEM_TAG_RE, ''));
            currentTextBlock = null; currentTextContent = '';
          }
          currentBlockType = null;
        }
      }
    }
  }
  if (currentTextBlock !== null) {
    currentTextBlock.innerHTML = renderMarkdown(currentTextContent.replace(MEM_TAG_RE, ''));
  }
  lastThinking = thinkingText;
}

// ============================================================
//  ANTHROPIC STREAMING
// ============================================================
async function streamAnthropic(bubble) {
  const endpoint = (config.endpoint || DEFAULTS.anthropic.endpoint) + '/v1/messages';
  const model = config.model || DEFAULTS.anthropic.model;
  const hasTools = allMcpTools.length > 0;
  const apiTools = hasTools ? allMcpTools.map(t => ({name:t.name, description:t.description, input_schema:t.input_schema})) : null;

  let loopMessages = buildApiMessages();
  // Inject active style into last user message for stronger constraint
  const _style = getActiveStyle();
  if (_style && _style.content) {
    const _styleTag = '\n\n<userStyle>\n' + _style.content + '\n</userStyle>';
    for (let i = loopMessages.length - 1; i >= 0; i--) {
      if (loopMessages[i].role === 'user') {
        const m = loopMessages[i];
        if (typeof m.content === 'string') {
          loopMessages[i] = { ...m, content: m.content + _styleTag };
        } else if (Array.isArray(m.content)) {
          const last = [...m.content].reverse().find(b => b.type === 'text');
          if (last) last.text += _styleTag;
        }
        break;
      }
    }
  }
  // BP4: rolling cache breakpoint on second-to-last message (last stable history msg)
  // Current user message (last) changes every turn, so BP4 goes one before it.
  if (loopMessages.length >= 3) {
    const cIdx = loopMessages.length - 2;
    const cm = loopMessages[cIdx];
    if (typeof cm.content === 'string') {
      loopMessages[cIdx] = { ...cm, content: [{type:"text", text:cm.content, cache_control:{type:"ephemeral", ttl:"1h"}}] };
    } else if (Array.isArray(cm.content)) {
      const blocks = [...cm.content];
      const lb = blocks[blocks.length - 1];
      blocks[blocks.length - 1] = { ...lb, cache_control:{type:"ephemeral", ttl:"1h"} };
      loopMessages[cIdx] = { ...cm, content: blocks };
    }
  }
  // Refresh memory injection BEFORE building volatile context — it used to run
  // after, so dynamic memories were always one turn stale (2026-06-11 fix)
  if (globalMemoryEnabled) {
    const recent = history.filter(m => m.role === 'user').slice(-3).map(m => typeof m.content === 'string' ? m.content : '').join(' ');
    if (recent) await loadMemoryInjection(recent);
  }
  // Inject volatile context (dynamic memory, timestamp) into current user message — AFTER BP4
  if (cachedInjectionDynamic || true) {
    const now = new Date(Date.now() + 8*3600000);
    const timeStr = now.toISOString().replace('T',' ').slice(0,16) + ' CST+8';
    const volParts = ['当前时间: ' + timeStr];
    if (cachedInjectionDynamic) volParts.push(cachedInjectionDynamic);
    const volText = '<gateway_volatile_context>仅供参考，勿复述：\n' + volParts.join('\n\n') + '\n</gateway_volatile_context>';
    const lastIdx = loopMessages.length - 1;
    const lastMsg = loopMessages[lastIdx];
    if (typeof lastMsg.content === 'string') {
      loopMessages[lastIdx] = { ...lastMsg, content: [{ type:'text', text: volText }, { type:'text', text: lastMsg.content }] };
    } else if (Array.isArray(lastMsg.content)) {
      loopMessages[lastIdx] = { ...lastMsg, content: [{ type:'text', text: volText }, ...lastMsg.content] };
    }
  }
  let fullText = '', thinkingText = '';
  let finalBlocks = [];  // preserves the full interleaved sequence across all tool-use rounds
  let maxLoops = 10;
  lastUsage = null; lastThinking = ''; lastToolCalls = [];

  while (maxLoops-- > 0) {
    const body = { model, max_tokens:32000, stream:true, thinking:{type:'enabled',budget_tokens:16000}, messages: loopMessages, metadata:{user_id:'default-user'} };
    if (hasTools) body.tools = apiTools;
    const sp = getSystemWithMemory();
    if (sp) {
      const sysBlocks = [];
      // Static part (profiles) — cacheable
      const staticPart = [getFullSystemPrompt(), cachedInjectionStatic].filter(Boolean).join('\n\n');
      if (staticPart) sysBlocks.push({type:"text", text:staticPart, cache_control:{type:"ephemeral", ttl:"1h"}});
      // Dynamic part moved to user message (after BP4) — not cached here
      // cachedInjectionDynamic now in user message after BP4
      if (sysBlocks.length) body.system = sysBlocks;
    }

    _abortCtrl = new AbortController();
    const res = await fetch(endpoint, {
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':config.apiKey,'Authorization':'Bearer '+config.apiKey,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true','anthropic-beta':'prompt-caching-2024-07-31'},
      body: JSON.stringify(body),
      signal: _abortCtrl.signal
    });
    if (!res.ok) throw new Error(res.status + ': ' + (await res.text()).slice(0,200));

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer='';
    let thinkingDiv=null, currentThinkingContent='';
    let currentTextBlock=null, currentTextContent='';
    let currentToolDiv=null, currentToolBlock=null;
    let toolInputBuffer='';
    let currentBlockType=null;
    let stopReason=null;
    const roundBlocks = [];  // this round's blocks; used to build next assistant message when looping

    while (true) {
      const {done,value} = await reader.read(); if(done) break;
      buffer += decoder.decode(value, {stream:true});
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6); if (data==='[DONE]') continue;
        try {
          const evt = JSON.parse(data);

          // Usage tracking across rounds
          if (evt.type==='message_start' && evt.message?.usage) {
            if (!lastUsage) {
              lastUsage = { ...evt.message.usage };
            } else {
              lastUsage.input_tokens = evt.message.usage.input_tokens;
              lastUsage.output_tokens = (lastUsage.output_tokens || 0) + (evt.message.usage.output_tokens || 0);
              if (evt.message.usage.cache_read_input_tokens != null) lastUsage.cache_read_input_tokens = (lastUsage.cache_read_input_tokens || 0) + evt.message.usage.cache_read_input_tokens;
              if (evt.message.usage.cache_creation_input_tokens != null) lastUsage.cache_creation_input_tokens = (lastUsage.cache_creation_input_tokens || 0) + evt.message.usage.cache_creation_input_tokens;
            }
          } else if (evt.type==='message_delta') {
            if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
            if (evt.usage) {
              lastUsage = lastUsage || {};
              lastUsage.output_tokens = (lastUsage.output_tokens || 0) + (evt.usage.output_tokens || 0);
            }
          } else if (evt.type==='message_stop' && evt['amazon-bedrock-invocationMetrics']) {
            const m = evt['amazon-bedrock-invocationMetrics'];
            lastUsage = { input_tokens: m.inputTokenCount, output_tokens: m.outputTokenCount };
          } else if (evt.usage && !evt.type) {
            lastUsage = { ...(lastUsage||{}), ...evt.usage };
          }

          if (window.__debugSSE) console.log('[SSE]', evt.type || '(no-type)', evt);

          if (evt.type==='content_block_start') {
            currentBlockType = evt.content_block?.type || null;
            if (evt.content_block?.type === 'thinking') {
              thinkingDiv = document.createElement('div'); thinkingDiv.className='thinking-block';
              thinkingDiv.innerHTML='<div class="thinking-label" onclick="this.parentElement.classList.toggle(\'expanded\')">thinking...</div><div class="thinking-content"></div>';
              bubble.appendChild(thinkingDiv); currentThinkingContent='';
              roundBlocks.push({type:'thinking', thinking:'', signature:''});
            } else if (evt.content_block?.type === 'text') {
              currentTextBlock = document.createElement('div'); currentTextBlock.className='text-block';
              bubble.appendChild(currentTextBlock); currentTextContent='';
              roundBlocks.push({type:'text', text:''});
            } else if (evt.content_block?.type === 'tool_use') {
              currentToolDiv = document.createElement('div'); currentToolDiv.className='tool-block';
              currentToolDiv.dataset.toolId = evt.content_block.id;
              const toolLabel = document.createElement('div'); toolLabel.className='tool-label';
              toolLabel.innerHTML = '<span class="tool-name">' + escapeHtml(evt.content_block.name) + '</span>';
              const divRef = currentToolDiv;
              toolLabel.onclick = () => divRef.classList.toggle('expanded');
              currentToolDiv.appendChild(toolLabel);
              bubble.appendChild(currentToolDiv);
              currentToolBlock = { type:'tool_use', id: evt.content_block.id, name: evt.content_block.name, input: {} };
              toolInputBuffer = '';
              roundBlocks.push(currentToolBlock);
              scrollToBottom();
            }
          } else if (evt.type==='content_block_delta') {
            if (evt.delta?.type==='thinking_delta') {
              currentThinkingContent += evt.delta.thinking;
              thinkingText += evt.delta.thinking;
              if (thinkingDiv) thinkingDiv.querySelector('.thinking-content').textContent = currentThinkingContent;
              for (let i = roundBlocks.length - 1; i >= 0; i--) {
                if (roundBlocks[i].type === 'thinking') { roundBlocks[i].thinking = currentThinkingContent; break; }
              }
            } else if (evt.delta?.type==='signature_delta') {
              for (let i = roundBlocks.length - 1; i >= 0; i--) {
                if (roundBlocks[i].type === 'thinking') { roundBlocks[i].signature = (roundBlocks[i].signature || '') + (evt.delta.signature || ''); break; }
              }
            } else if (evt.delta?.type==='text_delta' || evt.delta?.text) {
              const td = evt.delta.text || '';
              fullText += td; currentTextContent += td;
              if (currentTextBlock) {
                currentTextBlock.textContent = currentTextContent;
                scrollToBottom();
              }
              for (let i = roundBlocks.length - 1; i >= 0; i--) {
                if (roundBlocks[i].type === 'text') { roundBlocks[i].text = currentTextContent; break; }
              }
            } else if (evt.delta?.type==='input_json_delta') {
              toolInputBuffer += evt.delta.partial_json || '';
            }
          } else if (evt.type==='content_block_stop') {
            if (currentBlockType === 'text' && currentTextBlock !== null) {
              currentTextBlock.innerHTML = renderMarkdown(currentTextContent);
              currentTextBlock = null; currentTextContent = '';
            } else if (currentBlockType === 'tool_use' && currentToolBlock) {
              try { currentToolBlock.input = toolInputBuffer ? JSON.parse(toolInputBuffer) : {}; }
              catch(e) { currentToolBlock.input = { _raw: toolInputBuffer }; }
              currentToolBlock = null; currentToolDiv = null; toolInputBuffer = '';
            }
            currentBlockType = null;
          }
        } catch(e) {}
      }
    }
    // Safety render for any unclosed text block
    if (currentTextBlock !== null) {
      currentTextBlock.innerHTML = renderMarkdown(currentTextContent);
      currentTextBlock = null;
    }

    // Tool-use loop: if model wants to call tools, invoke them and continue with another stream round
    if (stopReason === 'tool_use' && hasTools) {
      const toolUseBlocks = roundBlocks.filter(b => b.type === 'tool_use');
      if (toolUseBlocks.length === 0) break;

      // Append this round's full assistant message (thinking + text + tool_use blocks) to the conversation
      const assistantContent = roundBlocks.map(b => {
        if (b.type === 'tool_use') return { type:'tool_use', id:b.id, name:b.name, input:b.input };
        if (b.type === 'thinking') {
          const out = { type:'thinking', thinking: b.thinking };
          if (b.signature) out.signature = b.signature;
          return out;
        }
        return { type:'text', text: b.text };
      });
      loopMessages.push({ role:'assistant', content: assistantContent });

      // Execute each tool, append its result to the corresponding DOM block and to the message history
      const toolResults = [];
      for (const tub of toolUseBlocks) {
        const tr = await callMcpTool(tub.name, tub.input);
        const resultText = tr.result || tr.error || 'No result';
        lastToolCalls.push({ name: tub.name, result: resultText.slice(0, 500) });
        tub.result = resultText;  // attach back to the block for rebuild later
        const matchDiv = bubble.querySelector('.tool-block[data-tool-id="' + CSS.escape(tub.id) + '"]');
        if (matchDiv && !matchDiv.querySelector('.tool-result')) {
          const resultDiv = document.createElement('div'); resultDiv.className='tool-result';
          resultDiv.textContent = resultText.slice(0, 500) + (resultText.length > 500 ? '...' : '');
          matchDiv.appendChild(resultDiv);
        }
        toolResults.push({ type:'tool_result', tool_use_id: tub.id, content: resultText });
      }
      // Commit this round's blocks to the final sequence before looping
      finalBlocks.push(...roundBlocks);
      loopMessages.push({ role:'user', content: toolResults });
      scrollToBottom();
      continue;
    }
    // This round ended without tool_use — commit its blocks and exit
    finalBlocks.push(...roundBlocks);
    break;
  }

  lastThinking = thinkingText;
  // Clean up: some proxies leak signature bytes into text blocks as U+FFFD
  for (const b of finalBlocks) { if (b.type === 'text' && b.text) b.text = b.text.replace(/\uFFFD/g, ''); }
  fullText = fullText.replace(/\uFFFD/g, '');
  return { text: fullText, blocks: finalBlocks, thinking: thinkingText };
}
// ============================================================
//  OPENAI-COMPAT STREAMING (via proxy to avoid CORS)
// ============================================================
async function streamOpenAI(bubble) {
  const endpoint = (config.endpoint || DEFAULTS['openai-compat'].endpoint) + '/chat/completions';
  const model = config.model || DEFAULTS['openai-compat'].model;
  const apiMessages = buildApiMessages();
  // Inject active style into last user message for stronger constraint
  const _oaiStyle = getActiveStyle();
  if (_oaiStyle && _oaiStyle.content) {
    const _oaiTag = '\n\n<userStyle>\n' + _oaiStyle.content + '\n</userStyle>';
    for (let i = apiMessages.length - 1; i >= 0; i--) {
      if (apiMessages[i].role === 'user') {
        const m = apiMessages[i];
        if (typeof m.content === 'string') {
          apiMessages[i] = { ...m, content: m.content + _oaiTag };
        } else if (Array.isArray(m.content)) {
          const last = [...m.content].reverse().find(b => b.type === 'text');
          if (last) last.text += _oaiTag;
        }
        break;
      }
    }
  }
  if (globalMemoryEnabled) {
    const recent = history.filter(m => m.role === 'user').slice(-3).map(m => typeof m.content === 'string' ? m.content : '').join(' ');
    if (recent) await loadMemoryInjection(recent);
  }
  const sp = getSystemWithMemory();
  const msgs = sp ? [{role:'system',content:sp},...apiMessages] : [...apiMessages];
  const body = { model, stream:true, stream_options:{include_usage:true}, messages:msgs };
  if (model.includes('claude')) body.reasoning = {effort:'high'};

  const res = await fetch(CHAT_API+'/proxy', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      targetUrl:endpoint,
      headers:{'Authorization':'Bearer '+config.apiKey,'HTTP-Referer':'https://example.com/chat/','X-Title':'Hubby❤︎'},
      payload:body
    })
  });
  if (!res.ok) throw new Error(res.status+': '+(await res.text()).slice(0,200));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer='', fullText='', thinkingText='', thinkingDiv=null;
  let textBlock=null;  // single text block for OpenAI-compat (no tool interleaving in this path)
  lastThinking='';

  while (true) {
    const {done,value} = await reader.read(); if(done) break;
    buffer += decoder.decode(value,{stream:true});
    const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6); if(data==='[DONE]') continue;
      try {
        const evt = JSON.parse(data);
        if (window.__debugSSE) console.log('[SSE/OAI]', evt);
        if (evt.usage) lastUsage = { input_tokens: evt.usage.prompt_tokens, output_tokens: evt.usage.completion_tokens, cache_read_input_tokens: evt.usage.prompt_tokens_details?.cached_tokens };
        const delta = evt.choices?.[0]?.delta;
        const reasoning = delta?.reasoning_content || delta?.reasoning;
        if (reasoning) {
          if (!thinkingDiv) {
            thinkingDiv = document.createElement('div'); thinkingDiv.className='thinking-block';
            thinkingDiv.innerHTML='<div class="thinking-label" onclick="this.parentElement.classList.toggle(\'expanded\')">thinking...</div><div class="thinking-content"></div>';
            bubble.appendChild(thinkingDiv);
          }
          thinkingText += reasoning;
          thinkingDiv.querySelector('.thinking-content').textContent = thinkingText;
        }
        if (delta?.content) {
          fullText += delta.content;
          if (!textBlock) {
            textBlock = document.createElement('div'); textBlock.className='text-block';
            bubble.appendChild(textBlock);
          }
          textBlock.textContent = fullText;
          scrollToBottom();
        }
      } catch(e) {}
    }
  }
  // Stream ended — render markdown for the accumulated text block
  if (textBlock) {
    textBlock.innerHTML = renderMarkdown(fullText);
  }
  lastThinking = thinkingText;
  // Build blocks array for schema consistency (OAI path has no tool_use)
  const blocks = [];
  if (thinkingText) blocks.push({ type:'thinking', thinking: thinkingText });
  // Clean proxy signature leakage
  fullText = fullText.replace(/\uFFFD/g, '');
  if (thinkingText) thinkingText = thinkingText.replace(/\uFFFD/g, '');
  if (fullText) blocks.push({ type:'text', text: fullText });
  return { text: fullText, blocks };
}
