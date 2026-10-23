// Privacy & maintenance: export, delete, retention purge, diagnostics, billing lookups.
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');
const memory = require('./memory');
const designsystems = require('./designsystems');
const plugins = require('./plugins');
const mcp = require('./mcp');
const logger = require('./logger');

// Everything except secrets (API keys never leave the keychain-encrypted store).
function exportAll() {
  const s = store.getSettings();
  const safe = { ...s }; delete safe.apiKey; delete safe.hasKey; delete safe.providerKeys;
  const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(store.root(), f), 'utf8')); } catch { return d; } };
  return {
    app: 'GrizzyCode', exportedAt: new Date().toISOString(), settings: safe,
    conversations: store.listConversations(true).map((m) => store.getConversation(m.id)),
    projects: store.listProjects(), memory: memory.list(), designSystems: designsystems.list(), plugins: plugins.list(),
    schedules: read('schedules.json', []), usage: store.getUsage(),
    connectors: Object.fromEntries(Object.entries(mcp.readConfig().mcpServers || {}).map(([n, d]) => [n, { ...d, env: d.env ? Object.fromEntries(Object.keys(d.env).map((k) => [k, '…'])) : undefined, headers: d.headers ? Object.fromEntries(Object.keys(d.headers).map((k) => [k, '…'])) : undefined }])),
  };
}
// scope: 'conversations' (chats + projects + usage) | 'memory' | 'everything' (all of the above + settings keys, skills, connectors…)
function deleteData(scope) {
  const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
  const r = store.root(); let n = 0;
  if (scope === 'conversations' || scope === 'everything') {
    for (const m of store.listConversations(true)) { store.deleteConversation(m.id); n++; }
    for (const f of ['projects.json', 'usage.json', 'dispatch.json']) rm(path.join(r, f));
  }
  if (scope === 'memory' || scope === 'everything') memory.clear();
  if (scope === 'everything') for (const f of ['schedules.json', 'settings.json', 'mcp_config.json', 'design-systems.json', 'plugins.json', 'skills', 'plugins', 'extensions']) rm(path.join(r, f));
  return { ok: true, conversations: n };
}
// Delete conversations (not pinned) whose last activity is older than `days`; 0 disables.
function purgeOld(days) {
  days = Number(days) || 0; if (days <= 0) return 0;
  const cutoff = Date.now() - days * 86400000; let n = 0;
  for (const m of store.listConversations(true)) { if (m.pinned) continue; const c = store.getConversation(m.id); if ((c.updatedAt || 0) < cutoff) { store.deleteConversation(m.id); n++; } }
  return n;
}
async function openRouterCredits() {
  const key = store.getSettings({ reveal: true }).keys?.openrouter; if (!key) return { error: 'No OpenRouter key saved.' };
  try {
    const r = await fetch('https://openrouter.ai/api/v1/credits', { headers: { authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(10000) });
    if (r.status === 401 || r.status === 403) return { error: 'OpenRouter rejected the saved key.' };
    if (!r.ok) return { error: `OpenRouter returned ${r.status}.` };
    const d = (await r.json()).data || {}; return { ok: true, total: d.total_credits || 0, used: d.total_usage || 0, remaining: (d.total_credits || 0) - (d.total_usage || 0) };
  } catch (e) { return { error: 'Could not reach OpenRouter: ' + e.message }; }
}
function diagnostics(app) {
  const s = store.getSettings(); const safe = { ...s }; delete safe.apiKey; delete safe.hasKey;
  return {
    generatedAt: new Date().toISOString(), app: { name: app.getName(), version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    system: { platform: process.platform, arch: process.arch, os: os.release(), memoryGB: Math.round(os.totalmem() / 1073741824), locale: app.getLocale() },
    settings: safe, providers: s.providerKeys,
    connectors: mcp.list().map((c) => ({ name: c.name, type: c.type, status: c.status, error: c.error, tools: c.tools.length })),
    counts: { conversations: store.listConversations(true).length, memory: memory.list().length, plugins: plugins.list().length },
    logs: { main: logger.scrub(logger.tail('main.log', 80)), mcp: logger.scrub(logger.tail('mcp.log', 80)) },
  };
}
module.exports = { exportAll, deleteData, purgeOld, openRouterCredits, diagnostics };
