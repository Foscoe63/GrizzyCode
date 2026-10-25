// Mod host: GrizzyCode's implementation of the Claude Code "mods" engine (function-hook plugins).
// Mods are found in Claude Code's own plugin install folders (so one install serves both apps) and in GrizzyCode's mods folder.
// Each enabled mod runs in its own worker thread; this file raises events through the mods' hook chains and answers the
// `$` calls a mod makes (display, session, model, files, processes, store, state, tools, commands).
const { Worker } = require('worker_threads');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const WORKER = path.join(__dirname, 'worker.js');
const HOME = os.homedir();
const NATIVE_DIR = path.join(HOME, '.GrizzyCode', 'mods');
const CC_MODS = path.join(HOME, '.claude', 'mods');
const CC_MODS_DATA = path.join(HOME, '.claude', 'mods-data');       // where mods keep their settings (cut from their own root)
const NATIVE_DATA = path.join(HOME, '.GrizzyCode', 'mods-data');    // GrizzyCode's copy, so mod data never lands in ~/.claude
const EVENT_TIMEOUT = 15000;

// GrizzyCode tool names → the names (and field names) mods know from Claude Code.
const TOOL_MAP = { read_file: 'Read', list_dir: 'LS', grep: 'Grep', write_file: 'Write', edit_file: 'Edit', bash: 'Bash', use_skill: 'Skill', web_fetch: 'WebFetch', exit_plan_mode: 'ExitPlanMode' };
function claudeCall(name, input) {
  const tool = TOOL_MAP[name] || name; const i = { ...(input || {}) };
  if ('path' in i && ['Read', 'Write', 'Edit'].includes(tool)) { i.file_path = i.path; delete i.path; }
  if (tool === 'Skill' && 'id' in i) { i.skill = i.id; delete i.id; }
  if (tool === 'LS' && 'path' in i) { i.path = i.path; }
  return { tool, input: i };
}

class ModHost {
  constructor() {
    this.mods = new Map();        // name -> record
    this.env = null;
    this.state = new Map();       // "<conv>|<plugin>|<key>" -> { value, version }
    this.panes = new Map();       // id -> { plugin, title }
    this.statusLines = new Map(); // plugin -> text
    this.commands = new Map();    // "<plugin>:<name>" -> spec + plugin
    this.session = { convId: '', cwd: '' };
    this.chains = 0; this.dirtyTimer = null; this.working = false;
  }
  init(env) { this.env = env; return this; }
  log(msg) { try { this.env?.log?.(msg); } catch {} }

  // ---------- discovery ----------
  readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
  inspectRoot(root, source, extra = {}) {
    const m = this.readJson(path.join(root, '.claude-plugin', 'plugin.json')); const hk = this.readJson(path.join(root, 'hooks', 'hooks.json'));
    if (!m || !m.name || !hk || !Array.isArray(hk.modules) || !hk.modules.length) return null;
    const base = path.resolve(root), entries = hk.modules.map((x) => path.resolve(path.join(base, 'hooks'), String(x)));
    if (entries.some((e) => !e.startsWith(base + path.sep) || !fs.existsSync(e))) return null;
    const entry = entries[0];
    const options = {};
    for (const [k, def] of Object.entries(m.userConfig || {})) if (def && def.default !== undefined) options[k] = def.default;
    return { name: String(m.name), version: String(m.version || ''), description: String(m.description || ''), root: base, entry, source, options, entries, userConfig: m.userConfig || {}, ...extra };
  }
  discover() {
    const found = new Map();
    const inst = this.readJson(path.join(HOME, '.claude', 'plugins', 'installed_plugins.json'));
    for (const [id, list] of Object.entries(inst?.plugins || {})) for (const rec of list || []) {
      if (!rec.installPath) continue; const m = this.inspectRoot(rec.installPath, 'Claude Code', { id });
      if (m && !found.has(m.name)) found.set(m.name, m);
    }
    try { for (const d of fs.readdirSync(NATIVE_DIR, { withFileTypes: true })) if (d.isDirectory()) { const m = this.inspectRoot(path.join(NATIVE_DIR, d.name), 'GrizzyCode'); if (m) found.set(m.name, m); } } catch {}
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  enabledMap() { return this.env.getSettings().modsEnabled || {}; }
  list() {
    const en = this.enabledMap();
    return this.discover().map((m) => { const r = this.mods.get(m.name); return { name: m.name, version: m.version, description: m.description, source: m.source, root: m.root, enabled: !!en[m.name], status: r?.status || 'off', error: r?.error || null, hooks: r?.hooks?.length || 0 }; });
  }

  // ---------- lifecycle ----------
  async startEnabled() { const en = this.enabledMap(); for (const m of this.discover()) if (en[m.name]) await this.start(m); }
  async setEnabled(name, on) {
    this.env.saveSettings({ modsEnabled: { ...this.enabledMap(), [name]: !!on } });
    if (on) { const m = this.discover().find((x) => x.name === name); if (!m) return { error: 'Mod not found.' }; await this.start(m); } else await this.stop(name);
    this.dirty(); return { ok: true };
  }
  // Re-read a mod from disk and restart it if it is switched on (after its files were edited or replaced).
  async reload(name) {
    const m = this.discover().find((x) => x.name === name); if (!m) { await this.stop(name); return { error: 'Mod not found.' }; }
    if (this.enabledMap()[name]) await this.start(m); else await this.stop(name);
    this.dirty(); return { ok: true };
  }
  start(m) {
    return new Promise((resolve) => {
      this.stop(m.name, true);
      const rec = { ...m, status: 'starting', error: null, hooks: [], chains: new Map(), pressWait: new Map(), inflight: 0, tools: new Map(), seq: 0, rpcCount: 0 };
      this.mods.set(m.name, rec);
      let w; try { w = new Worker(WORKER, { workerData: { name: m.name, root: m.root, pluginRoot: this.pluginRoot(m), entry: m.entry, entries: m.entries || [m.entry], options: m.options } }); } catch (e) { rec.status = 'failed'; rec.error = e.message; return resolve(rec); }
      rec.worker = w;
      const fail = (err) => { if (rec.status !== 'failed') { rec.status = 'failed'; rec.error = String(err).slice(0, 600); this.log(`mod ${m.name}: ${rec.error}`); for (const c of rec.chains.values()) c.fail(new Error('mod stopped')); rec.chains.clear(); } this.dirty(); resolve(rec); };
      const timeout = setTimeout(() => fail('timed out while loading'), 10000);
      w.on('message', (msg) => {
        if (msg.t === 'ready') { clearTimeout(timeout); rec.status = 'running'; rec.hooks = msg.hooks || []; this.dirty(); resolve(rec); this.raiseOne(rec, 'session.start', this.sessionStartInput()); }
        else if (msg.t === 'failed') { clearTimeout(timeout); fail(msg.error); }
        else if (msg.t === 'log') this.log(`mod ${m.name}: ${msg.msg}`);
        else if (msg.t === 'rpc') this.onRpc(rec, msg);
        else if (msg.t === 'next') this.onNext(rec, msg);
        else if (msg.t === 'eventRet') { const c = rec.chains.get(msg.chain); if (c) { rec.chains.delete(msg.chain); msg.error ? c.fail(new Error(msg.error)) : c.done(msg.value); } }
        else if (msg.t === 'pressRet') { const p = rec.pressWait.get(msg.id); if (p) { rec.pressWait.delete(msg.id); p(msg); } }
      });
      w.on('error', (e) => fail(e.stack || e.message));
      w.on('exit', () => { if (rec.status === 'running') { rec.status = 'stopped'; for (const c of rec.chains.values()) c.fail(new Error('mod stopped')); rec.chains.clear(); this.dirty(); } });
    });
  }
  async stop(name, quiet) {
    const rec = this.mods.get(name); if (!rec) return;
    this.mods.delete(name);
    try { rec.status = 'stopped'; await rec.worker?.terminate(); } catch {}
    for (const c of rec.chains.values()) c.fail(new Error('mod stopped')); rec.chains.clear();
    this.statusLines.delete(name);
    for (const [id, p] of [...this.panes]) if (p.plugin === name) this.panes.delete(id);
    for (const k of [...this.commands.keys()]) if (k.startsWith(name + ':')) this.commands.delete(k);
    if (!quiet) this.dirty();
  }
  async stopAll() { for (const n of [...this.mods.keys()]) await this.stop(n, true); }
  running() { return [...this.mods.values()].filter((m) => m.status === 'running').sort((a, b) => a.name.localeCompare(b.name)); }
  hasHook(event, filter) { return this.running().some((m) => m.hooks.some((h) => h.event === event && (!filter || filter(h)))); }

  // ---------- events ----------
  sessionStartInput() { return { cwd: this.session.cwd || HOME, surface: 'desktop', isInteractive: true }; }
  onNext(rec, msg) {
    const c = rec.chains.get(msg.chain); if (!c) return;
    rec.inflight++;
    Promise.resolve().then(() => c.next(msg.input)).then((value) => rec.worker.postMessage({ t: 'nextRet', id: msg.id, value }), (err) => rec.worker.postMessage({ t: 'nextRet', id: msg.id, error: String(err.message || err) })).finally(() => { rec.inflight--; c.touch(); });
  }
  // Run one mod's hooks for an event; `next` continues to the rest of the chain.
  callMod(rec, event, input, next, timeoutMs = EVENT_TIMEOUT) {
    return new Promise((resolve) => {
      if (rec.status !== 'running') return resolve(next(input));
      const chain = ++this.chains; let deadline = Date.now() + timeoutMs, timer = null, finished = false;
      const end = (fn) => { if (finished) return; finished = true; clearInterval(timer); rec.chains.delete(chain); fn(); };
      const c = { next, touch: () => { deadline = Date.now() + timeoutMs; }, done: (v) => end(() => resolve(v)), fail: (e) => end(() => { this.log(`mod ${rec.name}: ${event} skipped (${e.message})`); resolve(next(input)); }) };
      rec.chains.set(chain, c);
      timer = setInterval(() => { if (!rec.inflight && !rec.rpcCount && Date.now() > deadline) c.fail(new Error('timed out')); }, 500);
      try { rec.worker.postMessage({ t: 'event', chain, event, input }); } catch (e) { c.fail(e); }
    });
  }
  async raise(event, input, bottom, o = {}) {
    const mods = this.running().filter((m) => m.hooks.some((h) => h.event === event));
    const run = (i, e) => (i >= mods.length ? bottom(e) : this.callMod(mods[i], event, e, (e2) => run(i + 1, e2), o.timeoutMs));
    return run(0, input);
  }
  raiseOne(rec, event, input) { return this.callMod(rec, event, input, async (e) => ({})).catch(() => {}); }
  raiseAll(event, input) { return Promise.all(this.running().filter((m) => m.hooks.some((h) => h.event === event)).map((m) => this.raiseOne(m, event, input))); }

  // ---------- engine-side behaviours the app calls ----------
  setSession({ convId, cwd }) {
    const changed = convId !== this.session.convId; this.session = { convId: convId || '', cwd: cwd || '' };
    if (changed) { this.raiseAll('session.start', this.sessionStartInput()); this.dirty(); }
  }
  async promptSubmit(text, origin = { kind: 'composer' }) {
    if (!this.hasHook('prompt.submit')) return { text };
    try { const r = await this.raise('prompt.submit', { text, wait: false, origin }, async (e) => ({ text: e.text })); return r && (r.drop !== undefined || typeof r.text === 'string') ? r : { text }; } catch { return { text }; }
  }
  async promptCompose(model) {
    if (!this.hasHook('prompt.compose')) return [];
    try { const r = await this.raise('prompt.compose', { model, promptModel: model, surfaces: ['desktop'], tools: [], outputStyle: null, traits: [] }, async () => ({ sections: [] })); return (r?.sections || []).filter((s) => s && typeof s.text === 'string'); } catch { return []; }
  }
  async commandRun(plugin, command, args) {
    const input = { command, args: args || '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } };
    try { return await this.raise('command.run', input, async () => ({ text: `No mod handled /${command}.` }), { timeoutMs: 60000 }); } catch (e) { return { text: `/${command} failed: ${e.message}` }; }
  }
  // Wrap a tool execution so mods see (and may rewrite or refuse) the call. exec() performs it; returns the tool's text.
  async toolCall(name, input, toolUseId, exec) {
    const { tool, input: flat } = claudeCall(name, input);
    if (!this.hasHook('tool.call')) return exec(input);
    let ran = null;
    const e = { tool, tool_use_id: toolUseId, ...flat };
    const r = await this.raise('tool.call', e, async (e2) => { try { const out = await exec(input); ran = { text: String(out) }; return { result: { text: String(out) }, text: String(out) }; } catch (err) { ran = { error: err }; return { isError: true, result: { error: String(err.message || err) }, text: 'ERROR: ' + (err.message || err) }; } }, { timeoutMs: 20000 });
    if (r && r.deny) throw new Error(String(r.deny));
    if (ran?.error) throw ran.error;
    if (ran) return ran.text;
    return r?.text ?? (r?.result !== undefined ? JSON.stringify(r.result) : '');
  }
  async turnStart(info) { this.working = true; await Promise.race([this.raiseAll('turn.start', info), new Promise((r) => setTimeout(r, 2000))]); this.dirty(); }
  async turnComplete(info) { this.working = false; await this.raise('turn.complete', info, async () => ({})); this.dirty(); }
  async turnStep(info, exec) { return this.raise('turn.step', info, async () => ({ usage: await exec() })); }

  // ---------- mod tools ----------
  toolDefs() {
    const out = [];
    for (const m of this.running()) for (const [n, spec] of m.tools) out.push({ name: `mcp__${m.name}__${n}`, description: String(spec.description || '').slice(0, 1000), input_schema: spec.inputSchema && typeof spec.inputSchema === 'object' ? spec.inputSchema : { type: 'object', properties: {} } });
    return out;
  }
  isModTool(full) { const [, plugin, ...rest] = String(full).split('__'); return !!(plugin && this.mods.get(plugin)?.tools.has(rest.join('__'))); }
  async callModTool(full, input, toolUseId) {
    const r = await this.raise('tool.call', { tool: full, tool_use_id: toolUseId, ...input }, async () => ({ isError: true, result: 'This tool has no handler.', text: 'This tool has no handler.' }), { timeoutMs: 30000 });
    if (r?.deny) throw new Error(String(r.deny));
    const text = r?.text ?? (typeof r?.result === 'string' ? r.result : JSON.stringify(r?.result ?? ''));
    return r?.isError ? 'ERROR: ' + text : text;
  }

  // ---------- UI ----------
  dirty() { clearTimeout(this.dirtyTimer); this.dirtyTimer = setTimeout(() => this.env?.push('mods:dirty', this.info()), 80); }
  info() {
    return {
      working: this.working,
      band: this.hasHook('ui.render', (h) => h.matcher?.component === 'AbovePrompt'),
      messageHooks: this.hasHook('ui.render', (h) => ['UserMessage', 'AssistantMessage', 'ToolUse', 'ToolResult', 'ToolGroup', 'CommandOutput'].includes(h.matcher?.component)),
      panes: [...this.panes].map(([id, p]) => ({ id, plugin: p.plugin, title: p.title })),
      status: [...this.statusLines].map(([plugin, text]) => ({ plugin, text })),
      commands: [...this.commands.values()].map((c) => ({ name: c.name, description: c.description, plugin: c.plugin, argumentHint: c.argumentHint || '' })),
    };
  }
  async render(component, requestId, props) {
    const surface = 'desktop';
    const input = { surface, component, requestId: requestId || component, viewport: { columns: 120, rows: 40 }, props: props || {} };
    try { return await this.raise('ui.render', input, async (e) => ({ type: 'engine', props: e.props }), { timeoutMs: 8000 }); } catch (e) { return { type: 'engine', props: input.props }; }
  }
  closePane(id) { if (this.panes.delete(String(id))) this.raiseAll('ui.close', { id: String(id), origin: 'person' }); this.dirty(); }
  async press({ plugin, handle, element, component, requestId, text, value }) {
    const rec = this.mods.get(plugin); if (!rec || rec.status !== 'running') return { error: 'That mod is not running.' };
    const arg = { plugin, element, component, requestId, surface: 'desktop', ...(text !== undefined ? { text } : {}), ...(value !== undefined ? { value } : {}) };
    const core = (e) => new Promise((resolve) => { const id = ++rec.seq; rec.pressWait.set(id, (m) => resolve({ element: e.element, error: m.error })); rec.worker.postMessage({ t: 'press', id, handle, arg: { ...arg, element: e.element } }); });
    const r = await this.raise('ui.press', { plugin, element, component, requestId, surface: 'desktop' }, core, { timeoutMs: 120000 });
    this.dirty(); return r || {};
  }

  // ---------- shared mod home ----------
  // Mods find the shared home (switches.json, the /mods list, open requests) by cutting their own root at "/.claude/".
  // A mod in GrizzyCode's folder would cut at nothing, so it sees itself at ~/.claude/mods/<folder> instead; the paths
  // below map that view back to the real folder, and map switches.json / .open-* to ~/.GrizzyCode/mods so GrizzyCode's
  // switches stay separate from Claude Code's. Likewise ~/.claude/mods-data (mod settings) maps to ~/.GrizzyCode/mods-data. Nothing is written to ~/.claude.
  pluginRoot(m) { return m.source === 'GrizzyCode' ? path.join(CC_MODS, path.basename(m.root)) : m.root; }
  nativeFolders() {
    try { return fs.readdirSync(NATIVE_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(NATIVE_DIR, d.name, '.claude-plugin', 'plugin.json'))).map((d) => d.name); } catch { return []; }
  }
  mapPath(p) {
    p = String(p);
    if (p === CC_MODS_DATA || p.startsWith(CC_MODS_DATA + path.sep)) return path.join(NATIVE_DATA, p.slice(CC_MODS_DATA.length));
    if (!p.startsWith(CC_MODS + path.sep)) return p;
    const rest = p.slice(CC_MODS.length + 1), name = rest.split(path.sep)[0];
    if (name === 'switches.json' || name.startsWith('.open-')) return path.join(NATIVE_DIR, rest); // GrizzyCode keeps its own switches and open requests
    if (!name || fs.existsSync(path.join(CC_MODS, name)) || !this.nativeFolders().includes(name)) return p;
    return path.join(NATIVE_DIR, rest);
  }
  listDir(p) {
    const real = this.mapPath(p); let out = [];
    try { out = fs.readdirSync(real, { withFileTypes: true }); } catch (e) { if (path.resolve(real) !== CC_MODS) throw e; }
    const rows = out.map((d) => { let st = {}; try { st = fs.statSync(path.join(real, d.name)); } catch {} return { name: d.name, kind: d.isDirectory() || (d.isSymbolicLink() && st.isDirectory?.()) ? 'dir' : d.isFile() ? 'file' : 'other', size: st.size || 0, mtimeMs: st.mtimeMs || 0, isLink: d.isSymbolicLink() }; });
    if (path.resolve(real) === CC_MODS) for (const n of this.nativeFolders()) if (!rows.some((r) => r.name === n)) rows.push({ name: n, kind: 'dir', size: 0, mtimeMs: 0, isLink: true });
    return rows;
  }

  // ---------- services behind `$` ----------
  async onRpc(rec, msg) {
    const reply = (value, error) => { if (msg.id) { try { rec.worker.postMessage({ t: 'ret', id: msg.id, value, error }); } catch {} } };
    rec.rpcCount++;
    try { reply(await this.service(rec, msg.noun, msg.method, msg.args || [])); } catch (e) { reply(undefined, String(e && e.message || e)); } finally { rec.rpcCount--; }
  }
  convRows() {
    const c = this.session.convId ? this.env.getConversation(this.session.convId) : null; if (!c) return [];
    const rows = [];
    for (const m of c.messages) {
      if (typeof m.content === 'string') { rows.push({ role: m.role, text: m.content, toolUses: [] }); continue; }
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const uses = m.content.filter((b) => b.type === 'tool_use').map((b) => { const c2 = claudeCall(b.name, b.input); return { tool_use_id: b.id, tool: c2.tool, input: c2.input }; });
      const results = m.content.filter((b) => b.type === 'tool_result').map((b) => ({ tool_use_id: b.tool_use_id, text: String(b.content || ''), isError: /^ERROR/.test(String(b.content || '')) }));
      if (m.role === 'user' && !text && results.length) { rows.push({ role: 'user', text: '', toolUses: [], toolResults: results }); continue; }
      rows.push({ role: m.role, text, toolUses: uses, ...(results.length ? { toolResults: results } : {}) });
    }
    return rows;
  }
  stKey(rec, ref) { return `${this.session.convId || '_'}|${ref.plugin || rec.name}|${ref.key}|${ref.id || ''}`; }
  async service(rec, noun, method, a) {
    const k = `${noun}.${method}`;
    switch (k) {
      // display
      case 'ui.status': this.statusLines.set(rec.name, a[0] ? String(a[0]).slice(0, 2000) : undefined); if (!a[0]) this.statusLines.delete(rec.name); this.dirty(); return;
      case 'ui.toast': this.env.push('mods:toast', { plugin: rec.name, text: String(a[0] || '').slice(0, 2000), timeoutMs: a[1]?.timeoutMs }); return;
      case 'ui.log': if (a[1]?.to === 'debug') this.log(`mod ${rec.name}: ${a[0]}`); else this.env.push('mods:log', { plugin: rec.name, text: String(a[0] || '').slice(0, 4000) }); return;
      case 'ui.invalidate': this.dirty(); return;
      case 'ui.ask': return this.env.ask({ plugin: rec.name, question: String(a[0] || ''), options: Array.isArray(a[1]) ? a[1] : a[1]?.options || [], header: a[1]?.header, multiSelect: !!a[1]?.multiSelect });
      case 'ui.notify': return this.env.notify(rec.name, String(a[0] || ''), a[1]?.title);
      case 'ui.open': { const p = a[0] || {}; if (!p.id) throw new Error('ui.open needs an id'); this.panes.set(String(p.id), { plugin: rec.name, title: String(p.title || p.id) }); this.env.push('mods:openPane', { id: String(p.id) }); this.dirty(); return { isPlaced: true }; }
      case 'ui.close': { const id = String(a[0]?.id || ''); const had = this.panes.delete(id); if (had) this.raiseAll('ui.close', { id, origin: 'plugin' }); this.dirty(); return; }
      case 'ui.panes': return [...this.panes].map(([id, p]) => ({ id, title: p.title, isShown: true, isFocused: false, isPlaced: true }));
      case 'ui.scroll': case 'ui.focus': case 'ui.copy': case 'ui.view': case 'ui.blit': return {};
      case 'ui.selection': return undefined;
      // session
      case 'session.id': return this.session.convId || 'grizzycode';
      case 'session.cwd': case 'session.root': return this.session.cwd || HOME;
      case 'session.model': return this.env.getSettings().model;
      case 'session.turns': return this.convRows().filter((r) => r.role === 'user' && r.text).length;
      case 'session.messages': return this.convRows();
      case 'session.repo': return null;
      case 'session.surfaces': return ['desktop'];
      case 'session.surface': return 'desktop';
      case 'session.version': return { version: this.env.version(), build: 'GrizzyCode' };
      case 'session.usage': return this.env.sessionUsage(this.session.convId);
      case 'session.identity': return { name: this.env.getSettings().displayName || '', email: '' };
      case 'session.authorize': return { isAuthorized: true };
      // model
      case 'model.complete': return this.env.modelComplete(a[0] || {});
      case 'model.fork': return this.env.modelFork(this.session.convId, a[0] || {});
      case 'model.classify': return this.env.modelClassify(String(a[0] || ''), a[1] || [], a[2]);
      // tools and commands
      case 'tool.register': { const s = a[0] || {}; if (!/^[A-Za-z0-9_-]{1,40}$/.test(s.name || '')) throw new Error('tool names are letters, digits, _ and -'); rec.tools.set(s.name, s); return { name: `mcp__${rec.name}__${s.name}` }; }
      case 'tool.list': return [...this.env.builtinToolNames().map((n) => ({ name: TOOL_MAP[n] || n, description: '', mcp: false })), ...this.toolDefs().map((t) => ({ name: t.name, description: t.description, mcp: true }))];
      case 'command.register': { const s = a[0] || {}; if (!/^[A-Za-z0-9_-]{1,40}$/.test(s.name || '')) throw new Error('command names are letters, digits, _ and -'); this.commands.set(`${rec.name}:${s.name}`, { ...s, plugin: rec.name }); this.dirty(); return {}; }
      case 'command.list': return [...this.env.builtinCommands(), ...[...this.commands.values()].map((c) => ({ name: c.name, description: c.description, source: 'plugin', plugin: c.plugin }))];
      case 'agent.list': return [];
      // files
      case 'fs.read': return fs.readFileSync(this.mapPath(a[0]), 'utf8');
      case 'fs.write': { const p = this.mapPath(a[0]); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, String(a[1] ?? '')); return; }
      case 'fs.exists': return fs.existsSync(this.mapPath(a[0]));
      case 'fs.list': return this.listDir(String(a[0] || this.session.cwd || '.'));
      case 'fs.stat': { const p = this.mapPath(a[0]); const l = fs.lstatSync(p), s = fs.statSync(p); return { kind: s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other', size: s.size, mtimeMs: s.mtimeMs, isLink: l.isSymbolicLink() }; }
      // storage
      case 'store.get': return this.storeRead()[rec.name]?.[String(a[0])];
      case 'store.set': { const s = this.storeRead(); (s[rec.name] ||= {})[String(a[0])] = a[1]; this.storeWrite(s); return; }
      case 'store.delete': { const s = this.storeRead(); delete s[rec.name]?.[String(a[0])]; this.storeWrite(s); return; }
      case 'store.keys': return Object.keys(this.storeRead()[rec.name] || {});
      case 'state.get': { const v = this.state.get(this.stKey(rec, a[0] || {})); return { value: v?.value, version: v?.version || 0 }; }
      case 'state.set': { const key = this.stKey(rec, a[0] || {}); const cur = this.state.get(key); if (a[2]?.ifVersion !== undefined && (cur?.version || 0) !== a[2].ifVersion) return { isApplied: false, version: cur?.version || 0 }; const next = { value: a[1], version: (cur?.version || 0) + 1 }; this.state.set(key, next); this.dirty(); return { isApplied: true, version: next.version }; }
      // environment
      case 'env.get': return process.env[String(a[0])];
      case 'env.set': return { isApplied: false };
      case 'settings.read': return {};
      case 'process.run': return this.run(a[0], a[1] || {});
      case 'mcp.call': return { text: await this.env.mcpCall(String(a[0]), String(a[1]), a[2] || {}) };
      case 'audio.play': case 'audio.speak': return {};
      default: throw new Error(`$.${noun}.${method} is not available in GrizzyCode`);
    }
  }
  storeFile() { return path.join(this.env.root(), 'mods-store.json'); }
  storeRead() { return this.readJson(this.storeFile()) || {}; }
  storeWrite(s) { fs.mkdirSync(this.env.root(), { recursive: true }); fs.writeFileSync(this.storeFile(), JSON.stringify(s)); }
  run(argv, init) {
    return new Promise((resolve) => {
      if (Array.isArray(argv)) argv = argv.map((x) => (typeof x === 'string' ? this.mapPath(x) : x)); if (init.cwd) init = { ...init, cwd: this.mapPath(init.cwd) };
      if (!Array.isArray(argv) || !argv.length || argv.some((x) => typeof x !== 'string')) return resolve({ exitCode: 127, stdout: '', stderr: 'process.run needs an argv array of strings', isStdoutTruncated: false, isStderrTruncated: false });
      const cap = 8 * 1024 * 1024; let out = '', err = '', tOut = false, tErr = false, done = false;
      const env = { ...process.env, ...(init.env || {}), PATH: this.env.fullPath() };
      let p; try { p = spawn(argv[0], argv.slice(1), { cwd: init.cwd || this.session.cwd || HOME, env }); } catch (e) { return resolve({ exitCode: 127, stdout: '', stderr: String(e.message), isStdoutTruncated: false, isStderrTruncated: false }); }
      const finish = (code) => { if (done) return; done = true; clearTimeout(t); resolve({ exitCode: code ?? 1, stdout: out, stderr: err, isStdoutTruncated: tOut, isStderrTruncated: tErr }); };
      const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} err += '\n[timed out]'; finish(124); }, init.timeoutMs || 120000);
      p.stdout.on('data', (d) => { if (out.length < cap) out += d; else tOut = true; }); p.stderr.on('data', (d) => { if (err.length < cap) err += d; else tErr = true; });
      p.on('error', (e) => { err += String(e.message); finish(127); }); p.on('close', finish);
      p.stdin.on('error', () => {}); p.stdin.end(typeof init.stdin === 'string' ? init.stdin : '');
    });
  }
}
module.exports = new ModHost();
module.exports.ModHost = ModHost; module.exports.NATIVE_DIR = NATIVE_DIR; module.exports.claudeCall = claudeCall; module.exports.TOOL_MAP = TOOL_MAP;
