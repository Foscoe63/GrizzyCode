// One mod, one worker thread. Loads the mod's hooks module in a vm context with no Node and no DOM, gives it `$`
// (every engine call that needs the app is an RPC to the main thread), and runs its hooks when the host raises an event.
const { parentPort, workerData } = require('worker_threads');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { transform } = require('sucrase');

const { name: PLUGIN, root: ROOT, pluginRoot: PLUGIN_ROOT, options: OPTIONS, entry: ENTRY, entries: ENTRIES } = workerData;
const post = (m) => parentPort.postMessage(m);
const log = (msg) => post({ t: 'log', msg: String(msg).slice(0, 2000) });

// ---------- RPC to the host ----------
let rpcId = 0; const rpcPending = new Map();
const rpc = (noun, method, args) => new Promise((resolve, reject) => { const id = ++rpcId; rpcPending.set(id, { resolve, reject }); post({ t: 'rpc', id, noun, method, args }); });
const rpcVoid = (noun, method, args) => { post({ t: 'rpc', id: 0, noun, method, args }); };

// ---------- elements and JSX ----------
const handles = new Map(); let handleSeq = 0;
function addHandle(fn) { const id = ++handleSeq; handles.set(id, fn); if (handles.size > 4000) handles.delete(handles.keys().next().value); return id; }
const flatten = (c) => (Array.isArray(c) ? c.flatMap(flatten) : c === null || c === undefined || c === false || c === true ? [] : [typeof c === 'number' ? String(c) : c]);
function el(type) {
  return (props) => {
    const { children, onPress, onInput, onSelect, onSubmit, ...rest } = props || {};
    const node = { type, props: rest, children: flatten(children) };
    for (const [k, f] of [['onPress', onPress], ['onInput', onInput], ['onSelect', onSelect], ['onSubmit', onSubmit]]) if (typeof f === 'function') { node.press = node.press || { plugin: PLUGIN, handle: addHandle(f) }; if (k !== 'onPress') node.on = { ...(node.on || {}), [k]: addHandle(f) }; }
    return node;
  };
}
const TABLE = Object.freeze(Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Select', 'Svg', 'Link', 'Code', 'Markdown', 'Client', 'Raster', 'Image'].map((n) => [n, el(n)])));
function h(type, props, ...children) {
  if (typeof type === 'function') return type({ ...(props || {}), children: children.length ? children : props?.children });
  return { type, props: props || {}, children: flatten(children) };
}
const Fragment = (p) => flatten(p.children);
// Make a hook result JSON-safe: nodes already carry press handles, stray functions are dropped.
const safe = (v) => JSON.parse(JSON.stringify(v ?? null, (k, x) => (typeof x === 'function' ? undefined : x)));

// ---------- hooks ----------
const hooks = []; // { event, matcher, fn, catchFn, isStream }
// Regexes written inside the mod's vm context belong to another realm, so `instanceof RegExp` is false for them.
const isRe = (v) => Object.prototype.toString.call(v) === '[object RegExp]';
const globToRe = (g) => new RegExp('^' + String(g).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
function matches(m, input) {
  if (!m) return true;
  for (const [k, exp] of Object.entries(m)) {
    const act = input?.[k]; const s = act === undefined ? '' : String(act);
    if (isRe(exp)) { if (!exp.test(s)) return false; }
    else if (Array.isArray(exp)) { if (!exp.some((x) => (isRe(x) ? x.test(s) : String(x).includes('*') ? globToRe(x).test(s) : String(x) === s))) return false; }
    else if (typeof exp === 'string' && exp.includes('*')) { if (!globToRe(exp).test(s)) return false; }
    else if (exp !== undefined && String(exp) !== s) return false;
  }
  return true;
}
function on(event, a, b) {
  const [matcher, fn] = typeof a === 'function' ? [undefined, a] : [a, b];
  if (typeof fn !== 'function') throw new Error(`on(${event}): a hook function is required`);
  const rec = { event, matcher, fn, catchFn: null, isStream: fn.constructor && fn.constructor.name === 'AsyncGeneratorFunction' };
  hooks.push(rec);
  return { catch(f) { rec.catchFn = f; return this; } };
}

// Run this mod's hooks for an event, then hand the rest of the chain (other mods, then the engine) to `mainNext`.
async function runChain(event, input, mainNext) {
  const list = hooks.filter((x) => x.event === event && matches(x.matcher, input));
  const step = async (i, e) => {
    if (i >= list.length) return mainNext(e);
    const rec = list[i]; let called = false; let settled;
    const cont = async (e2 = e) => { called = true; settled = step(i + 1, e2); return settled; };
    const next = rec.isStream ? (e2 = e) => (async function* () { return await cont(e2); })() : cont;
    Object.defineProperty(next, 'called', { get: () => called });
    try {
      let out;
      if (rec.isStream) { const gen = rec.fn($, e, next); for (;;) { const r = await gen.next(); if (r.done) { out = r.value; break; } } }
      else out = await rec.fn($, e, next);
      if (out === undefined) return called ? settled : step(i + 1, e); // a hook that returns nothing lets the chain go on
      return out;
    } catch (err) {
      log(`${event} hook failed: ${err && err.message || err}`);
      if (rec.catchFn) { try { return await rec.catchFn($, e, next); } catch (e2) { log(`${event} catch handler failed: ${e2 && e2.message || e2}`); } }
      return called ? settled : step(i + 1, e);
    }
  };
  return step(0, input);
}

// ---------- the `$` object ----------
const timers = new Set();
const timer = (id) => ({ cancel() { clearTimeout(id); clearInterval(id); timers.delete(id); } });
const guard = (fn) => () => { Promise.resolve().then(fn).catch((e) => log(`timer callback failed: ${e && e.message || e}`)); };
const noun = (n, methods) => Object.fromEntries(methods.map((m) => [m, (...args) => rpc(n, m, args)]));
const $ = Object.freeze({
  plugin: Object.freeze({ name: PLUGIN, root: PLUGIN_ROOT || ROOT }),
  ui: Object.freeze({
    ...noun('ui', ['ask', 'notify', 'open', 'close', 'panes', 'scroll', 'focus', 'copy', 'selection', 'view', 'blit']),
    status: (text) => { rpcVoid('ui', 'status', [text]); },
    toast: (text, o) => { rpcVoid('ui', 'toast', [text, o]); },
    log: (text, o) => { rpcVoid('ui', 'log', [text, o]); },
    notice: () => {},
    invalidate: (ev) => { rpcVoid('ui', 'invalidate', [ev]); },
    resolve: () => TABLE,
  }),
  model: Object.freeze(noun('model', ['complete', 'fork', 'classify'])),
  audio: Object.freeze(noun('audio', ['play', 'speak'])),
  mcp: Object.freeze(noun('mcp', ['call', 'connect'])),
  session: Object.freeze(noun('session', ['messages', 'cwd', 'root', 'model', 'turns', 'id', 'repo', 'surfaces', 'surface', 'usage', 'version', 'compact', 'send', 'append', 'authorize', 'identity'])),
  turn: Object.freeze(noun('turn', ['abort'])),
  prompt: Object.freeze(noun('prompt', ['submit', 'read', 'media', 'fill', 'suggest', 'compose'])),
  tool: Object.freeze(noun('tool', ['list', 'call', 'check', 'register'])),
  command: Object.freeze(noun('command', ['list', 'run', 'register'])),
  config: Object.freeze(noun('config', ['list', 'set'])),
  telemetry: Object.freeze({ log: async () => {}, mark: async () => {} }),
  agent: Object.freeze(noun('agent', ['spawn', 'list', 'register'])),
  fs: Object.freeze(noun('fs', ['read', 'write', 'list', 'exists', 'stat', 'ancestors'])),
  store: Object.freeze(noun('store', ['get', 'set', 'delete', 'keys'])),
  state: Object.freeze(noun('state', ['get', 'set'])),
  clock: Object.freeze({
    now: async () => Date.now(),
    sleep: (ms) => new Promise((r) => { const id = setTimeout(() => { timers.delete(id); r(); }, ms); timers.add(id); }),
    after: (ms, fn) => { const id = setTimeout(() => { timers.delete(id); guard(fn)(); }, ms); timers.add(id); return timer(id); },
    every: (ms, fn) => { const id = setInterval(guard(fn), Math.max(16, ms)); timers.add(id); return timer(id); },
  }),
  http: Object.freeze(noun('http', ['fetch'])),
  process: Object.freeze(noun('process', ['run', 'spawn'])),
  settings: Object.freeze(noun('settings', ['read'])),
  env: Object.freeze(noun('env', ['get', 'set'])),
});

// ---------- the `claude-code` module's runtime exports: state atoms ----------
const freeze = Object.freeze;
const atom = (ref, initial, options) => freeze({ ref: freeze({ ...ref }), initial, ...(options && options.shape ? { shape: options.shape } : {}) });
const derive = (sources, compute) => freeze({ sources: freeze([...sources]), compute });
const memberOf = (a, e) => freeze({ ...a, ref: freeze({ ...a.ref, id: e && e.requestId }) });
async function read($$, src) {
  if (src && Array.isArray(src.sources)) return src.compute(...(await Promise.all(src.sources.map((x) => read($$, x)))));
  if (src && 'initial' in src && src.ref) { const r = await $$.state.get(src.ref); return r.value === undefined ? src.initial : r.value; }
  return (await $$.state.get(src)).value;
}
async function update($$, target, change) {
  const ref = target.ref || target; const initial = target.initial;
  for (let i = 0; i < 8; i++) {
    const r = await $$.state.get(ref); const cur = r.value === undefined ? initial : r.value; const next = change(cur);
    const w = await $$.state.set(ref, next, { ifVersion: r.version });
    if (w && w.isApplied === false) continue;
    return next;
  }
  throw new Error('update: the value kept changing');
}
const CLAUDE_CODE = freeze({ atom, derive, memberOf, read, update, tier: () => {} });

// ---------- module loader (ES modules → CommonJS in a vm context) ----------
const EXT = ['', '.ts', '.tsx', '.js', '.mjs', '.jsx', '.mts', '.cts', '.cjs'];
const cache = new Map();
const sandbox = {
  h, Fragment, console: { log: (...a) => log(a.join(' ')), warn: (...a) => log(a.join(' ')), error: (...a) => log(a.join(' ')), info: () => {}, debug: () => {} },
  URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa, structuredClone, queueMicrotask,
};
const ctx = vm.createContext(sandbox, { name: PLUGIN, codeGeneration: { strings: false, wasm: false } });
function resolveFile(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  for (const e of EXT) { const p = base + e; try { if (fs.statSync(p).isFile()) return p; } catch {} }
  for (const e of EXT.slice(1)) { const p = path.join(base, 'index' + e); try { if (fs.statSync(p).isFile()) return p; } catch {} }
  throw new Error(`Cannot find module '${spec}' from ${from}`);
}
function load(file) {
  if (cache.has(file)) return cache.get(file).exports;
  if (!file.startsWith(ROOT + path.sep)) throw new Error(`Module outside the plugin folder: ${file}`);
  const src = fs.readFileSync(file, 'utf8');
  const code = transform(src, { transforms: ['typescript', 'jsx', 'imports'], jsxPragma: 'h', jsxFragmentPragma: 'Fragment', production: true, filePath: file }).code;
  const mod = { exports: {} }; cache.set(file, mod);
  const req = (spec) => {
    if (spec === 'claude-code') return CLAUDE_CODE;
    if (spec.startsWith('claude-code/')) return {};
    if (!spec.startsWith('.')) throw new Error(`Imports of packages are not available to a mod: ${spec}`);
    return load(resolveFile(file, spec));
  };
  const fn = vm.runInContext(`(function (exports, require, module, __filename, __dirname) {${code}\n})`, ctx, { filename: file });
  fn(mod.exports, req, mod, file, path.dirname(file));
  return mod.exports;
}

// ---------- host messages ----------
const nextPending = new Map(); let nextSeq = 0;
parentPort.on('message', async (m) => {
  try {
    if (m.t === 'ret') { const p = rpcPending.get(m.id); if (p) { rpcPending.delete(m.id); m.error ? p.reject(new Error(m.error)) : p.resolve(m.value); } }
    else if (m.t === 'nextRet') { const p = nextPending.get(m.id); if (p) { nextPending.delete(m.id); m.error ? p.reject(new Error(m.error)) : p.resolve(m.value); } }
    else if (m.t === 'event') {
      const mainNext = (e) => new Promise((resolve, reject) => { const id = ++nextSeq; nextPending.set(id, { resolve, reject }); post({ t: 'next', chain: m.chain, id, input: safe(e) }); });
      try { const value = await runChain(m.event, m.input, mainNext); post({ t: 'eventRet', chain: m.chain, value: safe(value) }); }
      catch (err) { post({ t: 'eventRet', chain: m.chain, error: String(err && err.message || err) }); }
    }
    else if (m.t === 'press') {
      const f = handles.get(m.handle);
      if (f) { try { await f(m.arg); post({ t: 'pressRet', id: m.id }); } catch (err) { log(`press handler failed: ${err && err.message || err}`); post({ t: 'pressRet', id: m.id, error: String(err && err.message || err) }); } }
      else post({ t: 'pressRet', id: m.id, error: 'stale' });
    }
    else if (m.t === 'summary') post({ t: 'summary', id: m.id, hooks: hooks.map((x) => ({ event: x.event, matcher: x.matcher ? Object.fromEntries(Object.entries(x.matcher).map(([k, v]) => [k, isRe(v) ? String(v) : v])) : null })) });
  } catch (err) { log(`worker message failed: ${err && err.message || err}`); }
});

(async () => {
  try {
    for (const file of ENTRIES && ENTRIES.length ? ENTRIES : [ENTRY]) {
      const mod = load(file);
      const register = mod.register || mod.default;
      if (typeof register !== 'function') throw new Error(`The hooks module ${path.basename(file)} does not export register()`);
      await register(on, OPTIONS || {});
    }
    post({ t: 'ready', hooks: hooks.map((x) => ({ event: x.event, matcher: x.matcher ? Object.fromEntries(Object.entries(x.matcher).map(([k, v]) => [k, isRe(v) ? String(v) : v])) : null })) });
  } catch (err) { post({ t: 'failed', error: String(err && (err.stack || err.message) || err).slice(0, 2000) }); }
})();
