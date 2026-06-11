// ============================================================
//  STATE — single source of truth
// ============================================================
const CHAT_API = '/raffaello/chat/api';
const DEFAULTS = {
  anthropic: { endpoint: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514' },
  'openai-compat': { endpoint: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4' }
};

let config = { provider:'anthropic', endpoint:'', apiKey:'', model:'', systemPrompt:'', mcpServers:'' };
let history = [];           // messages for CURRENT conversation only
let streaming = false;      // true while awaiting a response

function scrollToBottom() {
  const c = document.getElementById('messages');
  const last = c.lastElementChild;
  if (last) last.scrollIntoView({ behavior:'smooth', block:'end' });
  else c.scrollTop = c.scrollHeight;
}
let conversations = [];     // metadata array (shallow — messages loaded on demand)
let currentConvId = null;
let pendingImage = null;
let allMcpTools = [];
let mcpConnections = [];
let lastThinking = '';
let lastToolCalls = [];
let lastUsage = null;
let baseSystemPrompt = '';
let globalMemoryEnabled = JSON.parse(localStorage.getItem('chat-memory-enabled') || 'true');
let cachedInjection = '';
let cachedInjectionStatic = '';
let cachedInjectionDynamic = '';

// Global memory activation state (shared across all conversations)
let globalMemState = JSON.parse(localStorage.getItem('chat-memstate') || '{"defaultMode":"active","overrides":{}}');
function saveMemState() { localStorage.setItem('chat-memstate', JSON.stringify(globalMemState)); }
function isMemoryActive(id) {
  if (globalMemState.overrides[id] !== undefined) return globalMemState.overrides[id];
  return globalMemState.defaultMode === 'active';
}
function toggleMemoryActive(id) {
  globalMemState.overrides[id] = !isMemoryActive(id);
  saveMemState();
}
function setAllMemoriesActive(active) {
  globalMemState.defaultMode = active ? 'active' : 'inactive';
  globalMemState.overrides = {};
  saveMemState();
}

function toggleGlobalMemory(on) {
  globalMemoryEnabled = on;
  localStorage.setItem('chat-memory-enabled', JSON.stringify(on));
  if (on) loadMemoryInjection();
  updateHeader();
}

// Style — synced to server via settings
let styles = [];
let activeStyleId = '';
function loadStylesFromConfig() {
  styles = config.styles || JSON.parse(localStorage.getItem('chat-styles') || '[]');
  activeStyleId = config.activeStyleId || localStorage.getItem('chat-active-style') || '';
}
function saveStyles() {
  config.styles = styles;
  config.activeStyleId = activeStyleId;
  localStorage.setItem('chat-styles', JSON.stringify(styles));
  localStorage.setItem('chat-active-style', activeStyleId);
  fetch(CHAT_API + '/settings', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(config) }).catch(()=>{});
}
function setActiveStyle(id) { activeStyleId = id; saveStyles(); }
function getActiveStyle() { return styles.find(s => s.id === activeStyleId) || null; }

// Guards
let _switchLock = false;    // prevents re-entrant conversation switches
let _savingQueue = Promise.resolve(); // serialises saves

