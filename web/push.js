// PWA + Web Push
const VAPID_PUBLIC = 'BGxGCPJE5p_wjjhgQ76qG7h6hI7QxrjuWNNYKHeLp8RQFG_JvLglQj1rTsZaw3vSn9xkRwpTI3NHDiFoCa-sLVo';
let _swReg = null;

// 先注册SW（不请求权限）
(async function() {
  if (!('serviceWorker' in navigator)) return;
  try {
    _swReg = await navigator.serviceWorker.register('/raffaello/chat/sw.js');
    console.log('[SW] registered');
    // 如果已经订阅了就发到服务器
    const sub = await _swReg.pushManager?.getSubscription();
    if (sub) {
      fetch('/raffaello/heartbeat/push/subscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON())
      });
      console.log('[PUSH] existing subscription synced');
    }
  } catch (e) { console.warn('[SW]', e); }
})();

// 用户点击触发订阅（iOS要求user gesture）
let _pushSettings = {};
async function loadPushSettings() {
  try {
    const r = await fetch('/raffaello/chat/api/settings');
    const s = await r.json();
    _pushSettings = s.push || { enabled:true, conversation_id:'', intervalMin:15, intervalMax:45, alwaysSend:false, console:true, chat:true, chatCount:2 };
  } catch(e) { _pushSettings = { enabled:true, conversation_id:'', intervalMin:15, intervalMax:45, alwaysSend:false, console:true, chat:true, chatCount:2 }; }
}
function renderPushPanel(p) {
  document.getElementById('pushOnBtn').classList.toggle('active', p.enabled!==false);
  document.getElementById('pushOffBtn').classList.toggle('active', p.enabled===false);
  document.getElementById('pushIntervalMin').value = p.intervalMin||15;
  document.getElementById('pushIntervalMax').value = p.intervalMax||45;
  document.getElementById('pushAlwaysBtn').classList.toggle('active', p.alwaysSend===true);
  document.getElementById('pushMaySkipBtn').classList.toggle('active', p.alwaysSend!==true);
  document.getElementById('pushCtxConsoleBtn').classList.toggle('active', p.console!==false);
  document.getElementById('pushCtxChatBtn').classList.toggle('active', p.chat!==false);
  document.getElementById('pushCtxCount').value = p.chatCount||2;
  document.getElementById('pushCtxCountRow').style.display = (p.chat!==false) ? 'flex' : 'none';
}
async function openPush() {
  renderPushPanel(_pushSettings);
  document.getElementById('pushOverlay').classList.add('open');
  loadPushSettings().then(() => renderPushPanel(_pushSettings)).catch(()=>{});
  fetch('/raffaello/chat/api/conversations').then(r=>r.json()).then(convs => {
    const sel = document.getElementById('pushConvSelect');
    sel.innerHTML = '<option value="">最新对话</option>';
    convs.slice(0,15).forEach(c => {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = (c.title||'untitled').slice(0,30);
      if (c.id === _pushSettings.conversation_id) o.selected = true;
      sel.appendChild(o);
    });
  }).catch(()=>{});
}
function closePush() { document.getElementById('pushOverlay').classList.remove('open'); }
function setPushEnabled(v) {
  _pushSettings.enabled = v;
  document.getElementById('pushOnBtn').classList.toggle('active', v);
  document.getElementById('pushOffBtn').classList.toggle('active', !v);
}
function toggleCtx(which) {
  const key = which === 'console' ? 'console' : 'chat';
  _pushSettings[key] = !_pushSettings[key];
  const btn = document.getElementById(which === 'console' ? 'pushCtxConsoleBtn' : 'pushCtxChatBtn');
  btn.classList.toggle('active', _pushSettings[key]);
  if (which === 'chat') {
    document.getElementById('pushCtxCountRow').style.display = _pushSettings.chat ? 'flex' : 'none';
  }
}
function setPushAlways(v) {
  _pushSettings.alwaysSend = v;
  document.getElementById('pushAlwaysBtn').classList.toggle('active', v);
  document.getElementById('pushMaySkipBtn').classList.toggle('active', !v);
}
async function savePush() {
  _pushSettings.conversation_id = document.getElementById('pushConvSelect').value;
  _pushSettings.intervalMin = parseInt(document.getElementById('pushIntervalMin').value)||15;
  _pushSettings.intervalMax = parseInt(document.getElementById('pushIntervalMax').value)||45;
  _pushSettings.console = document.getElementById('pushCtxConsoleBtn').classList.contains('active');
  _pushSettings.chat = document.getElementById('pushCtxChatBtn').classList.contains('active');
  _pushSettings.chatCount = parseInt(document.getElementById('pushCtxCount').value)||2;
  try {
    const r = await fetch('/raffaello/chat/api/settings');
    const s = await r.json();
    s.push = _pushSettings;
    s.proactive = _pushSettings.enabled;
    await fetch('/raffaello/chat/api/settings', {
      method:'PUT', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(s)
    });
  } catch(e) { console.warn('save push failed', e); }
  updatePushIcon();
  closePush();
}
function updatePushIcon() {
  const btn = document.getElementById('pushBtn');
  const icon = btn?.querySelector('.sidebar-btn-icon');
  const label = btn?.querySelector('span:last-child');
  const on = _pushSettings.enabled !== false;
  if(icon) icon.textContent = on ? '🔔' : '🔕';
  if(label) label.textContent = on ? 'push on' : 'push off';
}
async function initPushBtn() {
  await loadPushSettings();
  updatePushIcon();
}
document.addEventListener('DOMContentLoaded', initPushBtn);
