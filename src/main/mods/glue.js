// Connects the mod host to the rest of the app: the services a mod can call, and the IPC the renderer uses.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const host = require('./host');
const author = require('./author');
const { shell } = require('electron');

const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const textOf = (v) => (typeof v === 'string' ? v : (v || []).map((b) => b.text || '').join('\n'));
const usageOf = (u) => ({ input_tokens: u?.in || 0, output_tokens: u?.out || 0, cache_read_input_tokens: u?.cr || 0, cache_creation_input_tokens: u?.cw || 0 });

// d: { ipcMain, store, mcp, models, llm, tools, logger, app, dialog, Notification, wins, showMain, focused }
function setup(d) {
  const { ipcMain, store, mcp, models, llm, tools, logger, app, dialog, Notification } = d;
  const asks = new Map();
  const env = {
    getSettings: (o) => store.getSettings(o), saveSettings: (p) => store.saveSettings(p), getConversation: (id) => { try { return store.getConversation(id); } catch { return null; } },
    root: () => store.root(), version: () => app.getVersion(), fullPath: () => mcp.fullPath(), log: (m) => logger.append('mods.log', logger.scrub(m)),
    push: (ch, payload) => { for (const w of d.wins) if (!w.isDestroyed()) w.webContents.send(ch, payload); },
    ask: (q) => new Promise((resolve, reject) => { const id = crypto.randomUUID(); asks.set(id, { resolve, reject }); env.push('mods:ask', { id, ...q }); setTimeout(() => { if (asks.delete(id)) reject(new Error('The question timed out.')); }, 10 * 60 * 1000); }),
    notify: async (plugin, text, title) => { if (!Notification.isSupported()) return { isSent: false, reason: 'no-channel' }; new Notification({ title: title || plugin, body: text }).show(); return { isSent: true, channel: 'system' }; },
    builtinToolNames: () => ['read_file', 'list_dir', 'grep', 'write_file', 'edit_file', 'bash', 'use_skill', 'web_fetch'],
    builtinCommands: () => ['plan', 'accept', 'ask', 'bypass', 'clear', 'export', 'usage', 'terminal', 'changes'].map((name) => ({ name, description: '', source: 'builtin' })),
    mcpCall: (server, tool, args) => mcp.callTool(`mcp__${server}__${tool}`, args),
    sessionUsage: (convId) => {
      const c = convId ? env.getConversation(convId) : null; const s = store.getSettings({ reveal: true });
      const used = c?.ctx?.used || 0, window = c?.ctx?.max || models.contextWindow(s, c?.model || s.model) || 200000;
      return { startedAt: c?.createdAt || Date.now(), context: { tokens: used, window, percent: window ? Math.round((used / window) * 100) : 0 }, rateLimits: [], cost: { usd: 0 } };
    },
    // One-shot completion with the user's default model (a mod's `model` field is a hint; only a "provider:model" id is honoured).
    modelComplete: async (req, messagesOverride) => {
      const s = store.getSettings({ reveal: true });
      try {
        const wanted = /^[a-z0-9-]+:/.test(String(req.model || '')) ? req.model : s.model;
        const route = models.route(s, wanted);
        const msgs = messagesOverride || [{ role: 'user', content: textOf(req.prompt) }];
        const res = await llm.stream({ ...s, ...route, maxTokens: Math.max(16, Math.min(8000, req.maxTokens || 1500)) }, { system: textOf(req.system) || 'You are a helpful assistant.', messages: msgs, tools: [] }, () => {}, AbortSignal.timeout(req.timeoutMs || 90000));
        const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        store.addUsage(res.usage, { model: models.canon(s, wanted), mode: 'chat', conv: 'mods' });
        return text.trim() ? { isAnswered: true, text, usage: usageOf(res.usage) } : { isAnswered: false, reason: 'empty-reply', usage: usageOf(res.usage) };
      } catch (e) { return { isAnswered: false, reason: 'api-error', status: null, error: { message: String(e.message || e) }, usage: ZERO }; }
    },
    // The chat so far (as a transcript) plus the prompt: how a mod asks "write a handoff of this conversation".
    modelFork: async (convId, req) => {
      const c = convId ? env.getConversation(convId) : null; if (!c || !c.messages.length) return { isAnswered: false, reason: 'nothing-to-fork' };
      const lines = []; for (const m of c.messages) {
        if (typeof m.content === 'string') lines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`);
        else for (const b of m.content) { if (b.type === 'text') lines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${b.text}`); else if (b.type === 'tool_use') lines.push(`[tool ${b.name} ${JSON.stringify(b.input).slice(0, 300)}]`); else if (b.type === 'tool_result') lines.push(`[result ${String(b.content).slice(0, 400)}]`); }
      }
      let transcript = lines.join('\n\n'); if (transcript.length > 300000) transcript = '…\n' + transcript.slice(-300000);
      return env.modelComplete({ prompt: `Here is the conversation so far:\n\n<conversation>\n${transcript}\n</conversation>\n\n${req.prompt}`, maxTokens: 4000, timeoutMs: 180000 });
    },
    modelClassify: async (text, labels, o) => {
      const r = await env.modelComplete({ model: o?.model, prompt: `Classify the text with exactly one of these labels: ${labels.join(', ')}.\nAnswer with the label only.\n\nText:\n${text}`, maxTokens: 20, timeoutMs: 30000 });
      if (!r.isAnswered) return undefined; const a = r.text.trim().toLowerCase(); return labels.find((l) => a.includes(String(l).toLowerCase()));
    },
  };
  host.init(env);

  const h = (n, f) => ipcMain.handle(n, (_e, ...a) => f(...a));
  h('mods:list', () => host.list());
  h('mods:info', () => host.info());
  h('mods:setEnabled', async (name, on) => {
    if (on) {
      const m = host.discover().find((x) => x.name === name); if (!m) return { error: 'Mod not found.' };
      const r = await dialog.showMessageBox(d.focused(), { type: 'warning', message: `Turn on “${m.name}”?`, detail: `${m.description || ''}\n\nMods are programs. This one can read and write files, run commands and see your conversations, with your permissions. Only turn on mods you trust.\n\nSource: ${m.source}\n${m.root}`, buttons: ['Turn on', 'Cancel'], defaultId: 1, cancelId: 1 });
      if (r.response !== 0) return { cancelled: true };
    }
    const out = await host.setEnabled(name, on); const rec = host.mods.get(name);
    return { ...out, status: rec?.status || 'off', error: rec?.error || null };
  });
  h('mods:debugState', () => ({ session: host.session, state: [...host.state].map(([k, v]) => [k, v.version]), mods: [...host.mods.values()].map((m) => [m.name, m.status, m.hooks.length]) }));
  h('mods:session', (s) => host.setSession(s || {}));
  h('mods:render', (component, requestId, props) => host.render(component, requestId, props));
  h('mods:press', (a) => host.press(a || {}));
  h('mods:closePane', (id) => host.closePane(id));
  h('mods:command', (plugin, name, args) => host.commandRun(plugin, name, args));
  h('mods:askAnswer', (id, answer) => { const p = asks.get(id); if (!p) return; asks.delete(id); answer === null ? p.reject(new Error('dismissed')) : p.resolve(answer); });
  const find = (name) => host.discover().find((x) => x.name === name);
  // After files change on disk: restart the mod if it is on, and refresh the lists.
  const refreshed = async (name) => { if (host.enabledMap()[name] || host.mods.has(name)) await host.reload(name); host.dirty(); };
  h('mods:pickInstall', async () => {
    const r = await dialog.showOpenDialog(d.focused(), { properties: ['openFile', 'openDirectory'], filters: [{ name: 'Mod', extensions: ['plugin', 'zip'] }] });
    if (r.canceled) return null;
    const out = author.install(r.filePaths[0], (root) => host.inspectRoot(root, 'GrizzyCode'));
    if (out.ok) await refreshed(out.name);
    return out;
  });
  // A brand-new mod is written to GrizzyCode's own mods folder, never to Claude Code's plugins or any marketplace.
  h('mods:create', async (spec) => {
    const out = author.create(spec || {}, { taken: host.discover().map((m) => m.name) });
    if (out.ok) host.dirty();
    return out;
  });
  h('mods:reload', async (name) => (find(name) ? host.reload(name) : { error: 'Mod not found.' }));
  h('mods:reveal', (name) => { const m = find(name); if (!m) return { error: 'Mod not found.' }; shell.showItemInFolder(path.join(m.root, '.claude-plugin', 'plugin.json')); return { ok: true }; });
  h('mods:export', async (name) => {
    const m = find(name); if (!m) return { error: 'Mod not found.' };
    const r = await dialog.showSaveDialog(d.focused(), { defaultPath: `${m.name}${m.version ? '-' + m.version : ''}.zip`, filters: [{ name: 'Mod', extensions: ['zip'] }] });
    if (r.canceled || !r.filePath) return null;
    return author.exportZip(m, r.filePath);
  });
  h('mods:publish', async (name) => {
    const m = find(name); if (!m) return { error: 'Mod not found.' };
    const pick = await dialog.showOpenDialog(d.focused(), { title: `Publish “${m.name}” to a marketplace folder`, message: 'Choose a marketplace folder (one with .claude-plugin/marketplace.json), or an empty folder to start a new one.', properties: ['openDirectory', 'createDirectory'], buttonLabel: 'Choose' });
    if (pick.canceled) return null;
    const dir = pick.filePaths[0], plan = author.planPublish(m, dir); if (plan.error) return plan;
    const ok = await dialog.showMessageBox(d.focused(), { type: 'question', message: `Publish “${m.name}” to “${plan.marketName}”?`, detail: `${plan.isNew ? 'This starts a new marketplace' : 'This adds the mod to the existing marketplace'} in:\n${dir}\n\n${plan.replaces ? `A mod called “${m.name}” is already there and will be replaced.\n\n` : ''}Nothing else in the folder changes.`, buttons: [plan.replaces ? 'Replace and publish' : 'Publish', 'Cancel'], defaultId: 1, cancelId: 1 });
    if (ok.response !== 0) return { cancelled: true };
    return author.publish(m, dir);
  });
  h('mods:remove', async (name) => {
    const m = find(name); if (!m) return { error: 'Mod not found.' };
    if (m.source !== 'GrizzyCode') return { error: 'Only mods in GrizzyCode’s mods folder can be removed here. Remove Claude Code plugins in Claude Code.' };
    const ok = await dialog.showMessageBox(d.focused(), { type: 'warning', message: `Delete “${m.name}”?`, detail: `This deletes the folder:\n${m.root}`, buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1 });
    if (ok.response !== 0) return { cancelled: true };
    await host.stop(name, true); const out = author.removeNative(m);
    if (out.ok) { const en = { ...host.enabledMap() }; delete en[name]; store.saveSettings({ modsEnabled: en }); host.dirty(); }
    return out;
  });
  return host;
}
module.exports = { setup, host };
