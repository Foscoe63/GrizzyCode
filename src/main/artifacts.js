// Artifacts: self-contained pages the model builds (dashboards, slide decks, documents, trackers, diagrams, prototypes) and the
// sandbox that runs them. Modeled on Claude.app's typed artifacts: each has an id, a type, a title and versions; it renders in an
// isolated window on a private scheme with no network and every permission denied, and talks to the app only through a small
// bridge (`window.cowork`: askClaude, callMcpTool, runScheduledTask, db, saveFile, openExternal).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const templates = require('./artifact-templates');

const SCHEME = 'gc-artifact';
const MAX_HTML = 2 * 1024 * 1024, MAX_VERSIONS = 25, MAX_DB = 5 * 1024 * 1024;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let host = { onChange: () => {}, electron: null, windows: new Map() };
const dir = () => path.join(store.root(), 'artifacts');
const fileOf = (id) => path.join(dir(), id + '.json');

// ---------------- storage ----------------
function read(id) {
  if (!ID_RE.test(String(id))) return null;
  try { return JSON.parse(fs.readFileSync(fileOf(id), 'utf8')); } catch { return null; }
}
function write(a) {
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = fileOf(a.id) + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(a)); fs.renameSync(tmp, fileOf(a.id));
}
const meta = (a) => ({ id: a.id, title: a.title, type: a.type, createdAt: a.createdAt, updatedAt: a.updatedAt, convId: a.convId || null, bytes: a.html.length, versions: (a.versions || []).length, template: a.template || null, mcpTools: a.mcpTools || [] });
function list() {
  let out = [];
  try { out = fs.readdirSync(dir()).filter((f) => f.endsWith('.json')).map((f) => read(f.slice(0, -5))).filter(Boolean).map(meta); } catch {}
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}
const get = (id) => read(id);
const typeOf = (t) => (templates.TYPES[t] ? t : 'page');
function checkHtml(html) {
  if (typeof html !== 'string' || !html.trim()) throw new Error('html is required and must be a non-empty string.');
  if (html.length > MAX_HTML) throw new Error(`The page is ${html.length} characters; the limit is ${MAX_HTML}. Split it up or trim embedded data.`);
}
function snapshot(a, label) {
  (a.versions ||= []).push({ at: Date.now(), label: label || '', html: a.html });
  if (a.versions.length > MAX_VERSIONS) a.versions.splice(0, a.versions.length - MAX_VERSIONS);
}

function create({ title, type, html, template, convId } = {}) {
  const tpl = template ? templates.get(template) : null;
  if (template && !tpl) throw new Error(`Unknown template "${template}". Available: ${templates.list().map((t) => t.key).join(', ')}.`);
  const body = html != null ? html : tpl?.html;
  checkHtml(body);
  const now = Date.now();
  const a = { id: crypto.randomUUID(), title: String(title || tpl?.title || 'Untitled artifact').trim().slice(0, 120), type: typeOf(type || tpl?.type), html: body, template: tpl ? template : null, convId: convId || null, createdAt: now, updatedAt: now, versions: [], mcpTools: [], consent: {}, db: {} };
  write(a); host.onChange(meta(a), 'create'); return a;
}
function update(id, patch = {}, label) {
  const a = read(id); if (!a) throw new Error(`No artifact ${id}.`);
  if (patch.html != null) { checkHtml(patch.html); snapshot(a, label || 'update'); a.html = patch.html; }
  if (patch.title != null) a.title = String(patch.title).trim().slice(0, 120) || a.title;
  if (patch.type != null) a.type = typeOf(patch.type);
  a.updatedAt = Date.now(); write(a); host.onChange(meta(a), 'update'); return a;
}
// Exact-string edits, like edit_file: every old_string must match exactly once. All or nothing.
function edit(id, edits, label) {
  const a = read(id); if (!a) throw new Error(`No artifact ${id}.`);
  if (!Array.isArray(edits) || !edits.length) throw new Error('edits must be a non-empty list of {old_string, new_string}.');
  let html = a.html;
  edits.forEach((e, i) => {
    const o = String(e?.old_string ?? ''), n = String(e?.new_string ?? '');
    if (!o) throw new Error(`Edit ${i + 1}: old_string is empty.`);
    const c = html.split(o).length - 1;
    if (c !== 1) throw new Error(`Edit ${i + 1}: old_string ${c ? `matches ${c} times; it must be unique` : 'was not found'}.`);
    html = html.replace(o, () => n);
  });
  return update(id, { html }, label || `edit (${edits.length})`);
}
function remove(id) {
  if (!read(id)) return false;
  try { fs.unlinkSync(fileOf(id)); } catch {}
  const w = host.windows.get(id); if (w && !w.isDestroyed()) w.destroy();
  host.onChange({ id }, 'delete'); return true;
}
function versions(id) { const a = read(id); return a ? (a.versions || []).map((v, i) => ({ index: i, at: v.at, label: v.label, bytes: v.html.length })).reverse() : []; }
function restore(id, index) {
  const a = read(id); const v = a?.versions?.[index]; if (!v) throw new Error('No such version.');
  return update(id, { html: v.html }, `restore ${new Date(v.at).toLocaleString()}`);
}
function rename(id, title) { return update(id, { title }); }

// ---------------- rendering ----------------
// Libraries artifacts commonly pull from a CDN; the sandbox serves the bundled copies instead (it has no network).
const NM = path.join(__dirname, '..', '..', 'node_modules');
const LIBS = [
  { re: /https?:\/\/[^"'\s)]*chart(?:\.umd)?(?:\.min)?\.js/gi, from: 'chart.js/dist/chart.umd.js', name: 'chart.umd.js' },
  { re: /https?:\/\/[^"'\s)]*mermaid(?:\.min)?\.js/gi, from: 'mermaid/dist/mermaid.min.js', name: 'mermaid.min.js' },
  { re: /https?:\/\/[^"'\s)]*gridjs(?:\.umd)?(?:\.min)?\.js/gi, from: 'gridjs/dist/gridjs.umd.js', name: 'gridjs.umd.js' },
  { re: /https?:\/\/[^"'\s)]*gridjs[^"'\s)]*\.css/gi, from: 'gridjs/dist/theme/mermaid.min.css', name: 'gridjs.css' },
];
const LIB_NAMES = new Set(LIBS.map((l) => l.name));
const BASE_CSS = `<style id="gc-base">:root{color-scheme:light dark;--bg:#fbfbf9;--fg:#1f1f1e;--muted:#6b6b66;--line:#e4e4de;--card:#fff;--accent:#c6613f;--accent-fg:#fff;--font:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#1c1c1b;--fg:#f2f2ef;--muted:#a5a5a0;--line:#3a3a38;--card:#262625;--accent:#d97757}}
:where(html){background:var(--bg);color:var(--fg);font:14px/1.5 var(--font)}:where(button,input,select,textarea){font-family:inherit}</style>`;
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; worker-src blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
// Fallback bridge for exported copies: the db lives in localStorage and model/tool calls explain why they are unavailable.
const POLYFILL = `<script id="gc-polyfill">(function(){if(window.cowork)return;var P='gc-art:'+location.pathname+':';function g(c){try{return JSON.parse(localStorage.getItem(P+c)||'{}')}catch(e){return{}}}function s(c,v){localStorage.setItem(P+c,JSON.stringify(v))}
var no=function(){return Promise.reject(new Error('Not available outside GrizzyCode.'))};
window.cowork={standalone:true,askClaude:no,callMcpTool:no,runScheduledTask:no,listMcpTools:function(){return Promise.resolve([])},openExternal:function(u){window.open(u,'_blank','noopener')},
saveFile:function(n,c){var a=document.createElement('a');a.href=URL.createObjectURL(new Blob([c]));a.download=n;a.click();return Promise.resolve(true)},
db:{get:function(c,i){return Promise.resolve(g(c)[i]||null)},set:function(c,i,d){var x=g(c);x[i]=d;s(c,x);return Promise.resolve(d)},update:function(c,i,d){var x=g(c);x[i]=Object.assign({},x[i],d);s(c,x);return Promise.resolve(x[i])},delete:function(c,i){var x=g(c);delete x[i];s(c,x);return Promise.resolve(true)},list:function(c){var x=g(c);return Promise.resolve(Object.keys(x).map(function(k){return Object.assign({id:k},x[k])}))}}};})();</script>`;

function withLib(l, text, resolve) {
  l.re.lastIndex = 0; if (!l.re.test(text)) { l.re.lastIndex = 0; return text; } l.re.lastIndex = 0;
  return text.replace(l.re, () => resolve(l));
}
// mode 'sandbox': library URLs point at the private scheme and a CSP is added. mode 'standalone': libraries are inlined so the file works anywhere.
function render(a, mode = 'sandbox') {
  let html = a.html;
  if (mode === 'sandbox') {
    for (const l of LIBS) html = withLib(l, html, (x) => `/lib/${x.name}`);
  } else {
    for (const l of LIBS) {
      l.re.lastIndex = 0; const hit = l.re.test(html); l.re.lastIndex = 0; if (!hit) continue;
      let src; try { src = fs.readFileSync(path.join(NM, l.from), 'utf8'); } catch { continue; }
      const tag = l.name.endsWith('.css') ? `<style>${src}</style>` : `<script>${src.replace(/<\/script/gi, '<\\/script')}</script>`;
      html = html.replace(new RegExp(`<(?:script|link)[^>]*${l.re.source}[^>]*>(?:\\s*</script>)?`, 'gi'), () => tag);
    }
  }
  const head = (mode === 'sandbox' ? `<meta http-equiv="Content-Security-Policy" content="${CSP}">` : '') + '<meta charset="utf-8">' + BASE_CSS + (mode === 'standalone' ? POLYFILL : '');
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + head);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${head}</head>`);
  return `<!doctype html><html><head>${head}<title>${String(a.title).replace(/[<&]/g, '')}</title></head><body>${html}</body></html>`;
}
const standalone = (id) => { const a = read(id); return a ? render(a, 'standalone') : null; };

// ---------------- the model-facing tool ----------------
const toolDef = () => ({
  name: 'artifact', risky: false, kind: 'read',
  description: 'Create and maintain artifacts: self-contained interactive pages (dashboards, slide decks, documents, trackers, diagrams, design prototypes, small apps) that open in their own sandboxed window next to the chat. '
    + 'Use an artifact when the user wants something to look at, use, present or keep - not for short code snippets. Actions: create (title + html, or a starter `template`), update (replace the whole page), edit (exact-string edits, preferred for small changes), read, list, templates. '
    + 'After create the artifact opens automatically; refer to it by title, do not paste its code into the reply. '
    + 'Sandbox: the page has NO network and no external resources except Chart.js, Mermaid and Grid.js script URLs from jsDelivr (served locally). Inline all CSS/JS/images (use data: URIs or inline SVG). CSS variables --bg --fg --muted --line --card --accent --accent-fg --font --mono are predefined and follow light/dark. '
    + 'Host API (window.cowork, all promise-based): db.get(collection,id) / db.set(collection,id,data) / db.update(collection,id,patch) / db.delete(collection,id) / db.list(collection) for persistent data; askClaude(prompt, data?) returns model text; callMcpTool(fullToolName, args) calls a connected MCP tool (the user is asked once to allow each tool); listMcpTools(); runScheduledTask(id); saveFile(name, text); openExternal(url). '
    + 'Guard calls with `if (window.cowork)` so a copy exported to the browser still works. Types: ' + Object.entries(templates.TYPES).map(([k, t]) => `${k} (${t.description})`).join(' '),
  input_schema: { type: 'object', properties: {
    action: { type: 'string', enum: ['create', 'update', 'edit', 'read', 'list', 'templates'] },
    id: { type: 'string', description: 'Artifact id (update, edit, read)' },
    title: { type: 'string' }, type: { type: 'string', enum: Object.keys(templates.TYPES) },
    template: { type: 'string', description: 'Starter template key (create); see action "templates"' },
    html: { type: 'string', description: 'The complete HTML document (create, update)' },
    edits: { type: 'array', items: { type: 'object', properties: { old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['old_string', 'new_string'] }, description: 'Exact replacements, each old_string unique in the page (edit)' },
  }, required: ['action'] },
});
function runTool(input, ctx = {}) {
  const act = input.action;
  const fmt = (a) => `${a.id}  [${a.type}]  ${a.title}`;
  switch (act) {
    case 'create': { const a = create({ title: input.title, type: input.type, html: input.html, template: input.template, convId: ctx.convId }); return `Created artifact ${fmt(a)}. It is open in its own window. Use action "edit" with this id for follow-up changes.`; }
    case 'update': { if (!input.id) throw new Error('id is required.'); const a = update(input.id, { html: input.html, title: input.title, type: input.type }); return `Updated artifact ${fmt(a)} (version ${a.versions.length}).`; }
    case 'edit': { if (!input.id) throw new Error('id is required.'); const a = edit(input.id, input.edits); return `Edited artifact ${fmt(a)}.`; }
    case 'read': { const a = read(input.id); if (!a) throw new Error(`No artifact ${input.id}.`); return `${fmt(a)}\n\n${a.html.length > 30000 ? a.html.slice(0, 30000) + `\n…[truncated ${a.html.length - 30000} chars]` : a.html}`; }
    case 'list': { const l = list(); return l.length ? l.map((m) => `${m.id}  [${m.type}]  ${m.title}  (${m.bytes} chars, ${m.versions} earlier versions)`).join('\n') : 'No artifacts yet.'; }
    case 'templates': return templates.list().map((t) => `${t.key}  [${t.type}]  ${t.title} - ${t.description}`).join('\n') + '\n\nTypes:\n' + Object.entries(templates.TYPES).map(([k, t]) => `${k}: ${t.guide}`).join('\n');
    default: throw new Error('Unknown action. Use create, update, edit, read, list or templates.');
  }
}
const promptBlock = (s) => (s.capArtifacts === false ? '' : '\n\nArtifacts: when the user asks for a page, app, dashboard, deck, document, tracker, diagram or prototype, build it with the artifact tool (start from a template when one fits) rather than pasting a large HTML block into the chat. Keep chat replies short and describe what you made.');

// ---------------- sandbox runtime (Electron) ----------------
const hostOf = (url) => { try { const u = new URL(url); return u.protocol === SCHEME + ':' ? u : null; } catch { return null; } };
const MIME = { '.js': 'text/javascript', '.css': 'text/css' };
// Must run before app ready.
function registerScheme(protocol) { protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]); }

function init(o) {
  host = { ...host, ...o, windows: host.windows };
  const { session, ipcMain, dialog, shell, BrowserWindow } = o.electron;
  const ses = session.fromPartition('persist:gc-artifact');
  ses.setPermissionRequestHandler((_w, _p, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith(SCHEME + '://') && !d.url.startsWith('devtools://') }));
  ses.protocol.handle(SCHEME, (req) => {
    const u = hostOf(req.url); if (!u || !ID_RE.test(u.hostname)) return new Response('Not found', { status: 404 });
    const headers = { 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' };
    if (u.pathname.startsWith('/lib/')) {
      const name = u.pathname.slice(5); const l = LIBS.find((x) => x.name === name);
      if (!l || !LIB_NAMES.has(name)) return new Response('Not found', { status: 404 });
      try { return new Response(fs.readFileSync(path.join(NM, l.from)), { headers: { ...headers, 'content-type': MIME[path.extname(name)] || 'text/plain' } }); } catch { return new Response('Missing library', { status: 404 }); }
    }
    const a = read(u.hostname); if (!a) return new Response('Not found', { status: 404 });
    return new Response(render(a), { headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } });
  });

  // Every bridge call is checked against the frame that sent it: a top-level frame of our scheme, and the artifact id comes from its host, never from the arguments.
  const caller = (e) => {
    const f = e.senderFrame; const u = f && hostOf(f.url);
    if (!u || f.parent !== null || !ID_RE.test(u.hostname)) throw new Error('Not allowed.');
    const a = read(u.hostname); if (!a) throw new Error('This artifact no longer exists.');
    return a;
  };
  const h = (n, f) => ipcMain.handle('cowork:' + n, async (e, ...args) => f(caller(e), e, ...args));
  const win = (e) => BrowserWindow.fromWebContents(e.sender);
  const ask = async (a, e, title, detail, key) => {
    if (a.consent?.[key]) return true;
    const r = await dialog.showMessageBox(win(e), { type: 'question', buttons: ['Allow', 'Deny'], defaultId: 1, cancelId: 1, message: title, detail });
    if (r.response !== 0) return false;
    const cur = read(a.id); if (cur) { (cur.consent ||= {})[key] = true; write(cur); } return true;
  };

  const rate = new Map();
  h('askClaude', async (a, e, prompt, data) => {
    const now = Date.now(), r = (rate.get(a.id) || []).filter((t) => now - t < 60000);
    if (r.length >= 20) throw new Error('Too many requests from this artifact - wait a minute.');
    rate.set(a.id, [...r, now]);
    if (!(await ask(a, e, `Let “${a.title}” use the model?`, 'It will send text it builds to your configured model and the answers count toward your usage.', 'ask'))) throw new Error('The user denied model access for this artifact.');
    return askModel(a, String(prompt ?? '').slice(0, 30000), data);
  });
  h('callMcpTool', async (a, e, tool, args) => {
    const mcp = require('./mcp'); tool = String(tool);
    if (!mcp.toolDefs().some((t) => t.name === tool)) throw new Error(`Tool ${tool.slice(0, 120)} is not available. Connect and enable it in Settings → Connectors.`);
    if (args != null && (typeof args !== 'object' || Array.isArray(args))) throw new Error('Tool args must be an object.');
    if (!(a.mcpTools || []).includes(tool)) {
      const r = await dialog.showMessageBox(win(e), { type: 'question', buttons: ['Allow', 'Deny'], defaultId: 1, cancelId: 1, message: `Let “${a.title}” call ${tool}?`, detail: `${mcp.isReadOnly(tool) ? 'This tool only reads data.' : 'This tool may change data in the connected service.'}\nArguments: ${JSON.stringify(args ?? {}).slice(0, 300)}\n\nAllowing it lets this artifact call that tool whenever it is open.` });
      if (r.response !== 0) throw new Error('The user denied this tool for the artifact.');
      const cur = read(a.id); if (cur) { cur.mcpTools = [...new Set([...(cur.mcpTools || []), tool])]; write(cur); host.onChange(meta(cur), 'update'); }
    }
    return mcp.callTool(tool, args || {});
  });
  h('listMcpTools', async () => require('./mcp').toolDefs().map((t) => ({ name: t.name, description: t.description })));
  h('runScheduledTask', async (a, e, id) => {
    const features = require('./features'); id = String(id);
    const s = features.listSchedules().find((x) => x.id === id); if (!s) throw new Error('No such scheduled task.');
    if (!(await ask(a, e, `Let “${a.title}” run “${s.name}” now?`, 'The task runs unattended with its own permissions.', 'task:' + id))) throw new Error('The user denied running this task.');
    return features.runSchedule(id);
  });
  const dbOf = (a) => a.db || (a.db = {});
  const okName = (v) => typeof v === 'string' && /^[\w.-]{1,64}$/.test(v) && !['__proto__', 'constructor', 'prototype'].includes(v);
  const mutate = (a, fn) => { const cur = read(a.id); const d = dbOf(cur); const out = fn(d); if (JSON.stringify(d).length > MAX_DB) throw new Error('Artifact data is full (5 MB).'); write(cur); return out; };
  h('db', async (a, _e, op, col, id, data) => {
    if (!okName(col) || (op !== 'list' && !okName(id))) throw new Error('Collection and id must be 1-64 characters: letters, digits, dot, dash, underscore.');
    const d = dbOf(a);
    if (op === 'get') return d[col]?.[id] ?? null;
    if (op === 'list') return Object.entries(d[col] || {}).map(([k, v]) => ({ id: k, ...(v && typeof v === 'object' ? v : { value: v }) }));
    if (op === 'set') return mutate(a, (x) => { (x[col] ||= Object.create(null))[id] = data; return data; });
    if (op === 'update') return mutate(a, (x) => { const c = (x[col] ||= Object.create(null)); c[id] = { ...(c[id] && typeof c[id] === 'object' ? c[id] : {}), ...(data && typeof data === 'object' ? data : {}) }; return c[id]; });
    if (op === 'delete') return mutate(a, (x) => { if (x[col]) delete x[col][id]; return true; });
    throw new Error('Unknown db operation.');
  });
  h('saveFile', async (a, e, name, content) => {
    const r = await dialog.showSaveDialog(win(e), { defaultPath: path.basename(String(name || 'artifact.txt')).replace(/[^\w. -]/g, '_') });
    if (r.canceled) return false; fs.writeFileSync(r.filePath, String(content ?? '')); return true;
  });
  h('openExternal', async (_a, _e, url) => { try { const u = new URL(String(url)); if (!['http:', 'https:', 'mailto:'].includes(u.protocol)) return false; await shell.openExternal(u.href); return true; } catch { return false; } });
  h('info', async (a) => ({ id: a.id, title: a.title, type: a.type }));
}

async function askModel(a, prompt, data) {
  const llm = require('./llm'), models = require('./models');
  const s = store.getSettings({ reveal: true }); const model = (s.compactModel && String(s.compactModel).trim()) || s.model;
  const system = `You are called from inside an interactive artifact titled "${a.title}" (type: ${a.type}). Do exactly what the prompt asks and reply with only the result: no preamble, no markdown fences unless asked. If the prompt asks for JSON, reply with only valid JSON.`;
  const content = prompt + (data === undefined ? '' : '\n\n<data>\n' + (typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 60000) + '\n</data>');
  const res = await llm.stream({ ...s, ...models.route(s, model), maxTokens: 4000 }, { system, messages: [{ role: 'user', content }], tools: [] }, () => {}, AbortSignal.timeout(120000));
  try { store.addUsage(res.usage, { model: models.canon(s, model), mode: 'chat', conv: 'artifact:' + a.id, price: models.priceOf(s, model) }); } catch {}
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

function open(id) {
  const a = read(id); if (!a) return false;
  const { BrowserWindow, shell, nativeTheme } = host.electron;
  const cur = host.windows.get(id);
  if (cur && !cur.isDestroyed()) { if (cur.isMinimized()) cur.restore(); cur.show(); cur.focus(); return true; }
  const w = new BrowserWindow({ width: 1100, height: 760, minWidth: 420, minHeight: 320, title: a.title, backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1b' : '#fbfbf9',
    webPreferences: { partition: 'persist:gc-artifact', preload: path.join(__dirname, '..', 'artifact-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false } });
  host.windows.set(id, w);
  const url = `${SCHEME}://${id}/`;
  w.setMenuBarVisibility(false);
  w.webContents.setWindowOpenHandler(({ url: u }) => { if (/^(https?|mailto):/i.test(u)) shell.openExternal(u); return { action: 'deny' }; });
  w.webContents.on('will-navigate', (e, u) => { if (u !== url) { e.preventDefault(); if (/^(https?|mailto):/i.test(u)) shell.openExternal(u); } });
  w.on('page-title-updated', (e) => e.preventDefault());
  w.on('closed', () => host.windows.delete(id));
  w.loadURL(url);
  return true;
}
// The artifact changed: refresh its window if it is open.
function refresh(id) {
  const w = host.windows.get(id); const a = read(id);
  if (w && !w.isDestroyed() && a) { w.setTitle(a.title); w.webContents.reloadIgnoringCache(); }
}

module.exports = { SCHEME, registerScheme, init, setHost: (o) => { host = { ...host, ...o, windows: host.windows }; }, list, get, create, update, edit, remove, versions, restore, rename, open, refresh, standalone, render, toolDef, runTool, promptBlock, templates: templates.list, types: () => Object.entries(templates.TYPES).map(([key, t]) => ({ key, title: t.title, description: t.description })) };
