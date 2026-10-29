// Cowork: task sessions for work that is not code. A task runs in a granted folder or a fresh scratch workspace,
// optionally inside a Space (shared instructions, folders and links). Modeled on Claude.app's Cowork (scratch-YYYY-MM-DD-xxxxxx
// workspaces, Spaces, session retention); there is no VM, so the agent's normal permission modes are the boundary.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const agent = require('./agent');

let emit = () => {}, broadcast = () => {};
const dir = (n) => path.join(store.root(), n);
const file = (n) => path.join(store.root(), 'cowork-' + n + '.json');
const read = (n) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch { return []; } };
const write = (n, v) => { fs.mkdirSync(store.root(), { recursive: true }); fs.writeFileSync(file(n), JSON.stringify(v, null, 2)); broadcast('features:update', 'cowork'); };
const MODES = ['acceptEdits', 'plan', 'default'];
const cfg = () => store.getSettings();

// ---- Policy: org-style limits kept in settings. They bind Cowork tasks started from the app, not what you can edit on this Mac ----
const policy = () => ({ enabled: true, allowedFolders: [], ...(cfg().coworkPolicy || {}) });
function checkPolicy(folder) {
  const p = policy();
  if (!p.enabled) throw new Error('Cowork is turned off by policy on this computer.');
  if (folder && p.allowedFolders.length && !p.allowedFolders.some((f) => folder === f || folder.startsWith(f.replace(/\/$/, '') + '/'))) throw new Error('Policy only allows Cowork in: ' + p.allowedFolders.join(', '));
}

// ---- Egress: web_fetch / web_search in Cowork tasks follow coworkEgress ({ mode: all | allowlist | none, hosts }) ----
// Covers the web tools only. A shell command such as curl is not filtered; use "Ask first" to review those.
function egressCheck(conv, name, input) {
  if (!conv?.cowork || (name !== 'web_fetch' && name !== 'web_search')) return null;
  const e = { mode: 'all', hosts: [], ...(cfg().coworkEgress || {}) };
  if (e.mode === 'all') return null;
  if (e.mode === 'none') return 'Network access is off for Cowork tasks (Cowork → Network).';
  if (name === 'web_search') return 'Web search is off for Cowork tasks because the network is limited to an allow-list.';
  let host; try { host = new URL(input.url).hostname.toLowerCase(); } catch { return 'That is not a valid URL.'; }
  return e.hosts.some((h) => host === h || host.endsWith('.' + h)) ? null : `${host} is not on the Cowork allow-list (Cowork → Network).`;
}

// ---- Spaces ----
const listSpaces = () => read('spaces');
function saveSpace(p) {
  const name = String(p?.name || '').trim(); if (!name) throw new Error('A Space needs a name.');
  const l = read('spaces'); let s = p.id && l.find((x) => x.id === p.id);
  if (!s) { s = { id: crypto.randomUUID(), createdAt: Date.now() }; l.push(s); }
  Object.assign(s, { name: name.slice(0, 80), instructions: String(p.instructions || '').slice(0, 8000),
    folders: (p.folders || []).map(String).filter((f) => path.isAbsolute(f) && fs.existsSync(f)).slice(0, 20),
    links: (p.links || []).map(String).filter((u) => /^https?:\/\//i.test(u)).slice(0, 30) });
  write('spaces', l); return s;
}
const removeSpace = (id) => write('spaces', read('spaces').filter((s) => s.id !== id));

// ---- Scratch workspaces ----
function createScratch() {
  const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
  const p = path.join(dir('cowork-scratch'), `scratch-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(p, { recursive: true }); return p;
}
// Deletes scratch workspaces of tasks that are not running and are older than `days` (0 = keep forever). Granted folders are never touched.
function cleanup(days) {
  days = Number(days) || 0; if (!days) return 0;
  const keep = new Set(read('tasks').filter((t) => t.status === 'running' || Date.now() - t.createdAt < days * 864e5).map((t) => t.cwd));
  let n = 0; const base = dir('cowork-scratch');
  let names = []; try { names = fs.readdirSync(base); } catch {}
  for (const nm of names) { const p = path.join(base, nm); if (keep.has(p)) continue; try { fs.rmSync(p, { recursive: true, force: true }); n++; } catch {} }
  return n;
}

// ---- Cowork memory: separate from GrizzyCode's chat memory; only Cowork tasks see it ----
const memList = () => read('memory');
function memAdd(text) {
  text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 600); if (!text) throw new Error('Nothing to remember.');
  const l = read('memory'); if (!l.some((m) => m.text.toLowerCase() === text.toLowerCase())) l.push({ id: crypto.randomUUID(), text, createdAt: Date.now() });
  write('memory', l.slice(-100)); return l;
}
const memRemove = (id) => write('memory', read('memory').filter((m) => m.id !== id));

// ---- Plugins: installed plugins can be switched on for Cowork; their skills and commands are then named in the task prompt ----
function pluginList() {
  const on = new Set(cfg().coworkPlugins || []);
  return require('./plugins').list().map((p) => ({ name: p.name, description: p.description || '', skills: p.skills || [], commands: p.commands || [], enabled: on.has(p.name) }));
}
function setPlugin(name, enabled) {
  const on = new Set(cfg().coworkPlugins || []); enabled ? on.add(name) : on.delete(name);
  store.saveSettings({ coworkPlugins: [...on] }); broadcast('features:update', 'cowork'); return pluginList();
}

function setEgress(o) {
  const mode = ['all', 'allowlist', 'none'].includes(o?.mode) ? o.mode : 'all';
  const hosts = [...new Set((o?.hosts || []).map((h) => String(h).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[\/:].*$/, '').replace(/^\*\./, '')).filter((h) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)))].slice(0, 100);
  store.saveSettings({ coworkEgress: { mode, hosts } }); return { mode, hosts };
}
function setPolicy(o) {
  const allowedFolders = (o?.allowedFolders || []).map(String).filter((f) => path.isAbsolute(f)).slice(0, 50);
  const p = { enabled: o?.enabled !== false, allowedFolders }; store.saveSettings({ coworkPolicy: p }); return p;
}

// ---- Files: list and read what a task produced (confined to the task's folder) ----
const taskOf = (id) => read('tasks').find((t) => t.id === id);
const SKIP = new Set(['node_modules', '.git', '.DS_Store']);
function files(id) {
  const t = taskOf(id); if (!t) return []; const out = [];
  (function walk(d, depth) {
    let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (SKIP.has(e.name) || e.name.startsWith('.')) continue; const f = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 4) walk(f, depth + 1); } else if (e.isFile()) { try { const st = fs.statSync(f); out.push({ rel: path.relative(t.cwd, f), size: st.size, mtime: st.mtimeMs }); } catch {} }
    }
  })(t.cwd, 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 300);
}
const IMG = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
const TEXT = /\.(txt|md|markdown|json|csv|tsv|log|yaml|yml|xml|js|ts|py|sh|css|toml|ini|rtf)$/i;
function resolveIn(t, rel) {
  const f = path.resolve(t.cwd, String(rel)); if (f !== t.cwd && !f.startsWith(t.cwd + path.sep)) throw new Error('That file is outside the task folder.');
  if (!fs.statSync(f).isFile()) throw new Error('Not a file.'); return f;
}
function preview(id, rel) {
  const t = taskOf(id); if (!t) throw new Error('Task not found.'); const f = resolveIn(t, rel); const ext = path.extname(f).slice(1).toLowerCase(); const size = fs.statSync(f).size;
  if (IMG[ext]) return size > 6e6 ? { kind: 'none', note: 'Image is too large to preview.' } : { kind: 'image', src: `data:${IMG[ext]};base64,` + fs.readFileSync(f).toString('base64') };
  if (ext === 'html' || ext === 'htm') return { kind: 'html', text: fs.readFileSync(f, 'utf8').slice(0, 400000) };
  if (ext === 'csv' || ext === 'tsv') return { kind: 'table', text: fs.readFileSync(f, 'utf8').slice(0, 200000), sep: ext === 'tsv' ? '\t' : ',' };
  if (ext === 'md' || ext === 'markdown') return { kind: 'markdown', text: fs.readFileSync(f, 'utf8').slice(0, 200000) };
  if (TEXT.test(f) || size < 20000 && !fs.readFileSync(f).includes(0)) return { kind: 'text', text: fs.readFileSync(f, 'utf8').slice(0, 200000) };
  return { kind: 'none', note: `${ext.toUpperCase() || 'This'} files open in their own app.` };
}
const absFile = (id, rel) => { const t = taskOf(id); return t ? resolveIn(t, rel) : null; };
// Saves an HTML file a task made as a GrizzyCode artifact (its own sandboxed window).
function toArtifact(id, rel) {
  const t = taskOf(id); if (!t) throw new Error('Task not found.'); const f = resolveIn(t, rel);
  if (!/\.html?$/i.test(f)) throw new Error('Only HTML files can become artifacts.');
  return require('./artifacts').create({ title: path.basename(f).replace(/\.html?$/i, ''), type: 'page', html: fs.readFileSync(f, 'utf8'), convId: t.convId });
}

// ---- Branch: a copy of a task's session (and, for a scratch workspace, its files) that you can take a different way ----
function branch(id) {
  const t = taskOf(id); if (!t) throw new Error('Task not found.'); checkPolicy(t.scratch ? null : t.cwd);
  const src = store.getConversation(t.convId); const cwd = t.scratch ? createScratch() : t.cwd;
  if (t.scratch) fs.cpSync(t.cwd, cwd, { recursive: true });
  const c = store.newConversation({ mode: 'code', cwd, permissionMode: t.permissionMode });
  Object.assign(c, { cowork: { ...src.cowork }, messages: JSON.parse(JSON.stringify(src.messages)), title: ('Branch: ' + src.title).slice(0, 60) }); store.saveConversation(c);
  const n = { ...t, id: crypto.randomUUID(), cwd, convId: c.id, status: 'done', createdAt: Date.now(), finishedAt: Date.now(), error: '', prompt: 'Branch of: ' + t.prompt };
  const l = read('tasks'); l.push(n); write('tasks', l); return n;
}

// ---- Data controls ----
function exportData() {
  return { exportedAt: new Date().toISOString(), spaces: read('spaces'), memory: read('memory'), policy: policy(),
    tasks: read('tasks').map((t) => ({ ...t, conversation: (() => { try { return store.getConversation(t.convId); } catch { return null; } })() })) };
}
// Deletes Cowork tasks, their sessions, Spaces, memory and scratch workspaces. Folders you granted are not touched.
function deleteAll() {
  for (const t of read('tasks')) { try { agent.stop(t.convId); } catch {} store.deleteConversation(t.convId); }
  write('tasks', []); write('spaces', []); write('memory', []);
  try { fs.rmSync(dir('cowork-scratch'), { recursive: true, force: true }); } catch {}
  return true;
}

// ---- Tasks ----
const listTasks = () => read('tasks').sort((a, b) => b.createdAt - a.createdAt);
function setTask(id, patch) { const l = read('tasks'); const t = l.find((x) => x.id === id); if (t) { Object.assign(t, patch); write('tasks', l); } }
function start({ prompt, folder, spaceId, permissionMode }) {
  prompt = String(prompt || '').trim(); if (!prompt) throw new Error('Describe the task first.');
  checkPolicy(folder);
  const space = spaceId ? read('spaces').find((s) => s.id === spaceId) : null;
  if (spaceId && !space) throw new Error('That Space no longer exists.');
  if (folder && !fs.statSync(folder).isDirectory()) throw new Error('That folder does not exist.');
  const cwd = folder || createScratch();
  const pm = MODES.includes(permissionMode) ? permissionMode : 'acceptEdits';
  const c = store.newConversation({ mode: 'code', cwd, permissionMode: pm });
  c.cowork = { spaceId: space?.id || null, scratch: !folder }; store.saveConversation(c);
  const t = { id: crypto.randomUUID(), prompt, cwd, scratch: !folder, spaceId: space?.id || null, permissionMode: pm, convId: c.id, status: 'running', createdAt: Date.now(), finishedAt: 0, error: '' };
  const l = read('tasks'); l.push(t); write('tasks', l);
  agent.send(c.id, prompt, (ev) => {
    emit(ev);
    if (ev.type === 'done') setTask(t.id, { status: 'done', finishedAt: Date.now() });
    else if (ev.type === 'error') setTask(t.id, { status: 'failed', finishedAt: Date.now(), error: ev.message });
  });
  return t;
}
function stop(id) { const t = read('tasks').find((x) => x.id === id); if (t) { agent.stop(t.convId); setTask(id, { status: 'stopped', finishedAt: Date.now() }); } }
const remove = (id) => write('tasks', read('tasks').filter((t) => t.id !== id));
// Tasks that were running when the app quit cannot still be running.
function init(o) {
  emit = o.emit; broadcast = o.broadcast;
  const l = read('tasks'); let dirty = false;
  for (const t of l) if (t.status === 'running' && !agent.isRunning(t.convId)) { t.status = 'interrupted'; dirty = true; }
  if (dirty) write('tasks', l);
  cleanup(store.getSettings().coworkRetentionDays);
}

// System prompt text for a Cowork conversation: what this mode is for, plus the Space's context.
function promptBlock(conv) {
  if (!conv?.cowork) return '';
  const sp = conv.cowork.spaceId && read('spaces').find((s) => s.id === conv.cowork.spaceId);
  let out = `\n\nThis is a Cowork task: general knowledge work for the user (documents, research, spreadsheets, organizing files), not a software project. Your working folder is ${conv.cwd}${conv.cowork.scratch ? ', a scratch workspace made for this task: write deliverables there and tell the user the file names' : ''}. Work autonomously, keep the user informed with short progress notes, and finish with a summary of what you produced and where it is.`;
  const mem = read('memory').slice(-40); if (mem.length) out += '\n\nWhat you remember about the user from past Cowork tasks:\n' + mem.map((m) => '- ' + m.text).join('\n');
  const pl = pluginList().filter((x) => x.enabled); if (pl.length) out += '\n\nPlugins switched on for Cowork:\n' + pl.map((x) => `- ${x.name}: ${x.description}${x.skills.length ? ' (skills: ' + x.skills.join(', ') + ')' : ''}${x.commands.length ? ' (commands: ' + x.commands.join(', ') + ')' : ''}`).join('\n');
  out += '\nFor documents, spreadsheets, slides and PDFs, load the matching skill (docx, xlsx, pptx, pdf) with use_skill first.';
  if (sp) {
    out += `\n\nSpace "${sp.name}":`;
    if (sp.instructions.trim()) out += `\nInstructions: ${sp.instructions.trim()}`;
    if (sp.folders.length) out += `\nFolders that belong to this Space (you may read them; ask before changing them):\n${sp.folders.map((f) => '- ' + f).join('\n')}`;
    if (sp.links.length) out += `\nReference links:\n${sp.links.map((u) => '- ' + u).join('\n')}`;
  }
  return out;
}

module.exports = { setEgress, setPolicy, egressCheck, policy, memList, memAdd, memRemove, pluginList, setPlugin, files, preview, absFile, toArtifact, branch, exportData, deleteAll, init, listSpaces, saveSpace, removeSpace, listTasks, start, stop, remove, cleanup, promptBlock, createScratch };
