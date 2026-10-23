const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = () => path.join(app.getPath('userData'), 'data');
const convDir = () => path.join(root(), 'conversations');
const settingsFile = () => path.join(root(), 'settings.json');

const DEFAULTS = {
  provider: 'anthropic', // 'anthropic' | 'openai' (any OpenAI-compatible endpoint)
  apiKey: '',
  baseUrl: '',
  model: 'claude-sonnet-5-5',
  systemPrompt: 'You are GrizzyCode, a helpful, concise assistant.',
  quickShortcut: 'Alt+Space',
  theme: 'system',
  permissionMode: 'default', // default | acceptEdits | plan | bypassPermissions
  models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'],
  trustedFolders: [],
  pinnedFolders: [],
  runInTray: true,
  zoom: 0,
  sidebarHidden: false,
  maxTokens: 8192,
  account: null, // { method: 'openrouter' | 'anthropic-key', at }
  // General
  displayName: '', preferences: '', font: 'default', notifications: true, notifySound: true,
  // Privacy
  retentionDays: 0, // 0 = keep forever
  // Capabilities
  capArtifacts: true, capShell: true, capEdit: true, capWeb: false, capSkills: true, capAgents: true, maxSteps: 40,
  // Memory
  memoryEnabled: true, memoryAuto: true,
  // Design systems
  defaultDesignSystem: '',
  // Agents: id of the agent new conversations start with ('' = default)
  activeAgent: '',
  // Claude Code
  allowBypass: true, branchPrefix: 'grizzy/', worktreeDir: '', autoOpenFiles: false, shellPath: '', termFontSize: 12,
  // System
  launchAtLogin: false, keepAwake: false, hardwareAccel: true,
  // Developer
  devMode: false, rsOpen: false,
  // Token savers: MCP tool router, tool-output compression, history compaction (off by default: it costs a summary call)
  saveRouter: true, saveOutputs: true, saveOutputChars: 12000, saveCompact: false, compactAtPct: 60, compactKeep: 8, compactModel: '',
  // Mods: { name: true } for each mod the user turned on
  modsEnabled: {},
  // Providers: per-built-in overrides ({ id: { enabled, baseUrl, name, defaultModel, models } }) and user-added providers
  providerCfg: { overrides: {}, custom: [] },
};

function ensure() { fs.mkdirSync(convDir(), { recursive: true }); }

// Which named provider the default (provider/baseUrl/apiKey) configuration points at.
const isOpenRouterUrl = (u) => /^https?:\/\/([^/]*\.)?openrouter\.ai(\/|$)/i.test(u || '');
const defaultProviderId = (s) => (s.provider === 'anthropic' && !s.baseUrl ? 'anthropic' : isOpenRouterUrl(s.baseUrl) ? 'openrouter' : 'custom');

// Key prefixes identify the provider a key belongs to; an OpenRouter key sent to Anthropic can only ever 401.
const keyKind = (k) => (/^sk-or-/.test(k || '') ? 'openrouter' : /^sk-ant-/.test(k || '') ? 'anthropic' : null);
const OR_BASE = 'https://openrouter.ai/api/v1';
function plainKey(o) {
  if (o.apiKeyEnc && safeStorage.isEncryptionAvailable()) { try { return safeStorage.decryptString(Buffer.from(o.apiKeyEnc, 'base64')); } catch {} }
  return o.apiKey || '';
}
// Keep the default endpoint and the default key consistent. Mutates `next` (the settings about to be written).
//  - the patch supplied a key, or the endpoint was not touched → the key wins: point the endpoint at its provider
//  - the endpoint was switched away from the key's provider → the key moves to its own provider slot and the default key is cleared
function reconcile(next, patch = {}) {
  const key = plainKey(next); const kind = keyKind(key); if (!key || !kind) return false;
  const d = defaultProviderId(next);
  const mismatch = (kind === 'openrouter' && d === 'anthropic') || (kind === 'anthropic' && d === 'openrouter'); // custom endpoints/proxies are left alone
  if (!mismatch) return false;
  if ('apiKey' in patch || !('provider' in patch || 'baseUrl' in patch)) {
    next.provider = kind === 'anthropic' ? 'anthropic' : 'openai'; next.baseUrl = kind === 'openrouter' ? OR_BASE : '';
    if (kind === 'openrouter') {
      const ids = (next.models || []).filter((m) => m.includes('/') && !/:batch$/.test(m)); const cm = String(next.model || '').replace(/:batch$/, '');
      next.model = cm.includes('/') ? cm : ids[0] || next.model;
    }
  } else if (safeStorage.isEncryptionAvailable()) {
    next.keysEnc = { ...(next.keysEnc || {}) }; if (!next.keysEnc[kind]) next.keysEnc[kind] = safeStorage.encryptString(key).toString('base64');
    delete next.apiKeyEnc; delete next.apiKey; if (next.account && next.account.method !== 'manual') next.account = null;
  }
  return true;
}
// Repair settings written by older versions (run once at startup).
function heal() {
  ensure(); let cur; try { cur = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return false; }
  const next = { ...cur }; if (!reconcile(next)) return false;
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2), { mode: 0o600 }); return true;
}

function getSettings({ reveal = false } = {}) {
  ensure();
  let s = {};
  try { s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch {}
  const out = { ...DEFAULTS, ...s };
  if (out.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
    try { out.apiKey = safeStorage.decryptString(Buffer.from(out.apiKeyEnc, 'base64')); } catch {}
  }
  delete out.apiKeyEnc;
  // Named provider keys (anthropic / openrouter), plus the default key when it belongs to one of them.
  const keys = { ...(s.keys || {}) };
  for (const [id, enc] of Object.entries(s.keysEnc || {})) if (safeStorage.isEncryptionAvailable()) { try { keys[id] = safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch {} }
  const d = defaultProviderId(out); if (out.apiKey && d !== 'custom' && !keys[d] && (!keyKind(out.apiKey) || keyKind(out.apiKey) === d || !['anthropic', 'openrouter'].includes(d))) keys[d] = out.apiKey;
  out.providerKeys = { anthropic: false, openrouter: false, ...Object.fromEntries(Object.entries(keys).filter(([, v]) => v).map(([k]) => [k, true])) };
  delete out.keysEnc; delete out.keys;
  if (reveal) out.keys = keys;
  if (!reveal) { out.hasKey = !!out.apiKey; out.apiKey = ''; }
  return out;
}

function saveSettings(patch) {
  ensure();
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch {}
  const next = { ...cur, ...patch };
  if ('apiKey' in patch) {
    if (patch.apiKey) {
      if (safeStorage.isEncryptionAvailable()) {
        next.apiKeyEnc = safeStorage.encryptString(patch.apiKey).toString('base64');
        delete next.apiKey;
      }
    } else if (patch.apiKey === '') { delete next.apiKeyEnc; delete next.apiKey; }
  }
  if (patch.keys) {
    delete next.keys; next.keysEnc = { ...(cur.keysEnc || {}) }; const plain = { ...(cur.keys || {}) };
    for (const [id, v] of Object.entries(patch.keys)) {
      delete next.keysEnc[id]; delete plain[id];
      if (v) { if (safeStorage.isEncryptionAvailable()) next.keysEnc[id] = safeStorage.encryptString(v).toString('base64'); else plain[id] = v; }
    }
    if (Object.keys(plain).length) next.keys = plain;
  }
  reconcile(next, patch);
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2), { mode: 0o600 });
  return getSettings();
}

const convPath = (id) => path.join(convDir(), path.basename(id) + '.json');

function listConversations(includeArchived = false) {
  ensure();
  return fs.readdirSync(convDir()).filter((f) => f.endsWith('.json')).map((f) => {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(convDir(), f), 'utf8'));
      return { id: c.id, title: c.title, mode: c.mode, cwd: c.cwd, updatedAt: c.updatedAt, pinned: !!c.pinned, archived: !!c.archived, closedAt: c.closedAt || 0, projectId: c.projectId || null };
    } catch { return null; }
  }).filter(Boolean).filter((m) => includeArchived || !m.archived).sort((a, b) => (b.pinned - a.pinned) || b.updatedAt - a.updatedAt);
}

function getConversation(id) { return JSON.parse(fs.readFileSync(convPath(id), 'utf8')); }

function newConversation({ mode = 'chat', cwd = null, permissionMode, projectId = null, worktree = null, ssh = null } = {}) {
  const c = { id: crypto.randomUUID(), title: 'New conversation', mode, cwd, projectId, worktree, ssh, messages: [], createdAt: Date.now(), updatedAt: Date.now(),
    permissionMode: permissionMode || getSettings().permissionMode, agentId: getSettings().activeAgent || '', model: null, allow: [], usage: { in: 0, out: 0, cr: 0, cw: 0 }, ctx: null };
  saveConversation(c);
  return c;
}

function saveConversation(c) { ensure(); c.updatedAt = Date.now(); fs.writeFileSync(convPath(c.id), JSON.stringify(c)); return c; }
function deleteConversation(id) { try { fs.unlinkSync(convPath(id)); } catch {} }

function searchConversations(q) {
  q = (q || '').toLowerCase();
  if (!q) return listConversations();
  return listConversations().filter((m) => {
    if (m.title.toLowerCase().includes(q)) return true;
    try {
      const c = getConversation(m.id);
      return JSON.stringify(c.messages).toLowerCase().includes(q);
    } catch { return false; }
  });
}

const usageFile = () => path.join(root(), 'usage.json');
const z4 = () => ({ in: 0, out: 0, cr: 0, cw: 0 });
const add4 = (a, u) => { a.in += u.in || 0; a.out += u.out || 0; a.cr += u.cr || 0; a.cw += u.cw || 0; return a; };
function getUsage() {
  let d = {}; try { d = JSON.parse(fs.readFileSync(usageFile(), 'utf8')); } catch {}
  const fix = (x) => ({ ...z4(), ...(x || {}) });
  return { total: fix(d.total), days: Object.fromEntries(Object.entries(d.days || {}).map(([k, v]) => [k, { ...fix(v), cost: v?.cost || 0 }])),
    models: d.models || {}, modes: { chat: fix(d.modes?.chat), code: fix(d.modes?.code) }, requests: d.requests || 0, sessions: d.sessions || [], cost: d.cost || 0, since: d.since || null };
}
function clearUsage() { try { fs.unlinkSync(usageFile()); } catch {} }
// meta: { model, mode: 'chat'|'code', conv, price: { in, out, cr, cw } per token }
function addUsage(u, meta = {}) {
  if (!u || (!u.in && !u.out && !u.cr && !u.cw)) return;
  ensure();
  const d = getUsage(); const day = new Date().toISOString().slice(0, 10);
  const cost = meta.price ? (u.in || 0) * meta.price.in + (u.out || 0) * meta.price.out + (u.cr || 0) * (meta.price.cr || meta.price.in) + (u.cw || 0) * (meta.price.cw || meta.price.in) : 0;
  add4(d.total, u); (d.days[day] ||= { ...z4(), cost: 0 }); add4(d.days[day], u); d.days[day].cost += cost;
  if (meta.model) { const m = (d.models[meta.model] ||= { ...z4(), n: 0, cost: 0 }); add4(m, u); m.n++; m.cost += cost; }
  add4(d.modes[meta.mode === 'code' ? 'code' : 'chat'], u);
  d.requests++; d.cost += cost; d.since ||= day;
  if (meta.conv && !d.sessions.includes(meta.conv)) d.sessions.push(meta.conv);
  if (d.sessions.length > 20000) d.sessions = d.sessions.slice(-20000);
  const keep = Object.keys(d.days).sort().slice(-120); d.days = Object.fromEntries(keep.map((k) => [k, d.days[k]]));
  fs.writeFileSync(usageFile(), JSON.stringify(d));
}

function lastClosed() { return listConversations(true).filter((m) => m.archived).sort((a, b) => b.closedAt - a.closedAt)[0] || null; }

// ---- projects: named workspaces with custom instructions that apply to their conversations
const projectsFile = () => path.join(root(), 'projects.json');
function listProjects() {
  let l = []; try { l = JSON.parse(fs.readFileSync(projectsFile(), 'utf8')); } catch {}
  const counts = {}; for (const c of listConversations(true)) if (c.projectId) counts[c.projectId] = (counts[c.projectId] || 0) + 1;
  return l.map((p) => ({ ...p, chats: counts[p.id] || 0 })).sort((a, b) => b.updatedAt - a.updatedAt);
}
const getProject = (id) => (id ? listProjects().find((p) => p.id === id) || null : null);
function saveProject(p) {
  ensure(); let l = []; try { l = JSON.parse(fs.readFileSync(projectsFile(), 'utf8')); } catch {}
  const rec = { id: p.id || crypto.randomUUID(), name: (p.name || '').trim() || 'Untitled project', instructions: p.instructions || '', folder: p.folder || null, createdAt: Date.now(), updatedAt: Date.now() };
  const i = l.findIndex((x) => x.id === rec.id); if (i >= 0) { rec.createdAt = l[i].createdAt; l[i] = rec; } else l.push(rec);
  fs.writeFileSync(projectsFile(), JSON.stringify(l, null, 2)); return getProject(rec.id);
}
function deleteProject(id) {
  let l = []; try { l = JSON.parse(fs.readFileSync(projectsFile(), 'utf8')); } catch {}
  fs.writeFileSync(projectsFile(), JSON.stringify(l.filter((x) => x.id !== id), null, 2));
  for (const m of listConversations(true)) if (m.projectId === id) { const c = getConversation(m.id); c.projectId = null; saveConversation(c); }
}

module.exports = { heal, keyKind, defaultProviderId, isOpenRouterUrl, listProjects, getProject, saveProject, deleteProject, getUsage, clearUsage, addUsage, lastClosed, root, getSettings, saveSettings, listConversations, getConversation, newConversation, saveConversation, deleteConversation, searchConversations };
