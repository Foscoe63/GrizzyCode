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

// ---- Tasks ----
const listTasks = () => read('tasks').sort((a, b) => b.createdAt - a.createdAt);
function setTask(id, patch) { const l = read('tasks'); const t = l.find((x) => x.id === id); if (t) { Object.assign(t, patch); write('tasks', l); } }
function start({ prompt, folder, spaceId, permissionMode }) {
  prompt = String(prompt || '').trim(); if (!prompt) throw new Error('Describe the task first.');
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
  if (sp) {
    out += `\n\nSpace "${sp.name}":`;
    if (sp.instructions.trim()) out += `\nInstructions: ${sp.instructions.trim()}`;
    if (sp.folders.length) out += `\nFolders that belong to this Space (you may read them; ask before changing them):\n${sp.folders.map((f) => '- ' + f).join('\n')}`;
    if (sp.links.length) out += `\nReference links:\n${sp.links.map((u) => '- ' + u).join('\n')}`;
  }
  return out;
}

module.exports = { init, listSpaces, saveSpace, removeSpace, listTasks, start, stop, remove, cleanup, promptBlock, createScratch };
