// Sidebar features that run without the user watching: scheduled tasks, dispatched background sessions, and artifact extraction.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const agent = require('./agent');

let emit = () => {}, broadcast = () => {};
const file = (n) => path.join(store.root(), n + '.json');
const read = (n) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch { return []; } };
const write = (n, v) => { fs.mkdirSync(store.root(), { recursive: true }); fs.writeFileSync(file(n), JSON.stringify(v, null, 2)); broadcast('features:update', n); };

// Unattended runs cannot answer approval prompts: anything the permission mode does not already allow is denied.
const unattended = (after) => (ev) => {
  if (ev.type === 'approval') { agent.answer(ev.approvalId, 'deny'); return; }
  emit(ev); after?.(ev);
};

// ---------------- schedules ----------------
function computeNext(s, from = Date.now()) {
  if (s.every === 'interval') return from + Math.max(1, Number(s.minutes) || 60) * 60000;
  const [h, m] = (s.time || '09:00').split(':').map(Number);
  const d = new Date(from); d.setHours(h || 0, m || 0, 0, 0);
  const ok = (x) => (s.every === 'weekdays' ? ![0, 6].includes(x.getDay()) : true);
  while (d.getTime() <= from || !ok(d)) { d.setDate(d.getDate() + 1); d.setHours(h || 0, m || 0, 0, 0); }
  return d.getTime();
}
const listSchedules = () => read('schedules');
function saveSchedule(p) {
  const l = listSchedules();
  const rec = { id: p.id || crypto.randomUUID(), name: (p.name || '').trim() || 'Untitled task', prompt: p.prompt || '', mode: p.mode === 'code' ? 'code' : 'chat', cwd: p.mode === 'code' ? p.cwd || null : null,
    permissionMode: p.permissionMode === 'bypassPermissions' ? 'bypassPermissions' : 'acceptEdits', every: ['interval', 'daily', 'weekdays'].includes(p.every) ? p.every : 'daily',
    minutes: Math.max(1, Number(p.minutes) || 60), time: /^\d{1,2}:\d{2}$/.test(p.time) ? p.time : '09:00', enabled: p.enabled !== false, lastRun: 0, lastStatus: '', lastConvId: null };
  const i = l.findIndex((x) => x.id === rec.id);
  if (i >= 0) { Object.assign(rec, { lastRun: l[i].lastRun, lastStatus: l[i].lastStatus, lastConvId: l[i].lastConvId }); l[i] = rec; } else l.push(rec);
  rec.nextRun = computeNext(rec); write('schedules', l); return rec;
}
const removeSchedule = (id) => write('schedules', listSchedules().filter((x) => x.id !== id));
const running = new Set();
async function runSchedule(id) {
  const l = listSchedules(); const s = l.find((x) => x.id === id);
  if (!s || running.has(id) || !s.prompt.trim()) return null;
  running.add(id);
  const c = store.newConversation({ mode: s.mode, cwd: s.cwd, permissionMode: s.mode === 'code' ? s.permissionMode : undefined });
  const finish = (status) => { running.delete(id); const cur = listSchedules(); const t = cur.find((x) => x.id === id); if (t) { t.lastRun = Date.now(); t.lastStatus = status; t.lastConvId = c.id; t.nextRun = computeNext(t); write('schedules', cur); } };
  s.lastRun = Date.now(); s.lastConvId = c.id; s.lastStatus = 'running'; write('schedules', l);
  agent.send(c.id, s.prompt, unattended((ev) => { if (ev.type === 'done') finish('ok'); else if (ev.type === 'error') finish('error: ' + ev.message); }), [], { title: `⏰ ${s.name}` });
  return c.id;
}
function tick() {
  const now = Date.now();
  for (const s of listSchedules()) if (s.enabled && s.nextRun <= now && !running.has(s.id)) runSchedule(s.id);
}

// ---------------- dispatch ----------------
const listDispatch = () => read('dispatch').sort((a, b) => b.createdAt - a.createdAt);
function setTask(id, patch) { const l = read('dispatch'); const t = l.find((x) => x.id === id); if (t) { Object.assign(t, patch); write('dispatch', l); } }
function startDispatch({ prompt, cwd, permissionMode }) {
  if (!prompt?.trim() || !cwd) throw new Error('A prompt and a folder are required.');
  const pm = permissionMode === 'bypassPermissions' ? 'bypassPermissions' : permissionMode === 'plan' ? 'plan' : 'acceptEdits';
  const c = store.newConversation({ mode: 'code', cwd, permissionMode: pm });
  const t = { id: crypto.randomUUID(), prompt: prompt.trim(), cwd, permissionMode: pm, convId: c.id, status: 'running', createdAt: Date.now(), finishedAt: 0, error: '' };
  const l = read('dispatch'); l.push(t); write('dispatch', l);
  agent.send(c.id, t.prompt, unattended((ev) => {
    if (ev.type === 'done') setTask(t.id, { status: 'done', finishedAt: Date.now() });
    else if (ev.type === 'error') setTask(t.id, { status: 'failed', finishedAt: Date.now(), error: ev.message });
  }));
  return t;
}
function stopDispatch(id) { const t = read('dispatch').find((x) => x.id === id); if (t) { agent.stop(t.convId); setTask(id, { status: 'stopped', finishedAt: Date.now() }); } }
const removeDispatch = (id) => write('dispatch', read('dispatch').filter((x) => x.id !== id));

// ---------------- artifacts: substantial code produced in conversations ----------------
const PREVIEW = new Set(['html', 'svg']);
const SKIP = new Set(['bash', 'sh', 'zsh', 'shell', 'console', 'text', 'txt', 'diff', 'log', '']);
const EXT = { js: 'js', jsx: 'jsx', ts: 'ts', tsx: 'tsx', py: 'python', html: 'html', svg: 'svg', css: 'css', json: 'json', md: 'markdown', swift: 'swift', rs: 'rust', go: 'go', java: 'java', sh: 'bash', yml: 'yaml', yaml: 'yaml', c: 'c', cpp: 'cpp', rb: 'ruby' };
function listArtifacts() {
  const out = [];
  for (const m of store.listConversations(true)) {
    let c; try { c = store.getConversation(m.id); } catch { continue; }
    c.messages.forEach((msg, mi) => {
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return;
      msg.content.forEach((b, bi) => {
        const base = { convId: c.id, title: c.title, updatedAt: c.updatedAt };
        if (b.type === 'text') {
          let n = 0; for (const x of b.text.matchAll(/```([\w+-]*)\n([\s\S]*?)```/g)) {
            const lang = x[1].toLowerCase(), code = x[2], lines = code.split('\n').length;
            if (!PREVIEW.has(lang) && (SKIP.has(lang) || lines < 8)) continue;
            out.push({ ...base, id: `${c.id}:${mi}:${bi}:${n++}`, name: `${lang || 'code'} snippet`, lang: lang || 'text', code, lines, preview: PREVIEW.has(lang) });
          }
        } else if (b.type === 'tool_use' && b.name === 'write_file' && b.input?.content) {
          const ext = path.extname(b.input.path || '').slice(1).toLowerCase();
          out.push({ ...base, id: `${c.id}:${mi}:${bi}`, name: path.basename(b.input.path || 'file'), lang: EXT[ext] || ext || 'text', code: b.input.content, lines: b.input.content.split('\n').length, preview: PREVIEW.has(ext) });
        }
      });
    });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200);
}

let timer = null;
function init(o) {
  ({ emit, broadcast } = o);
  const l = read('dispatch'); let dirty = false;
  for (const t of l) if (t.status === 'running') { t.status = 'interrupted'; dirty = true; }
  if (dirty) write('dispatch', l);
  const s = read('schedules'); let sd = false; for (const t of s) if (t.lastStatus === 'running') { t.lastStatus = 'interrupted'; sd = true; }
  if (sd) write('schedules', s);
  timer = setInterval(tick, 20000); setTimeout(tick, 3000);
}
const stop = () => clearInterval(timer);

module.exports = { init, stop, computeNext, listSchedules, saveSchedule, removeSchedule, runSchedule, tick, listDispatch, startDispatch, stopDispatch, removeDispatch, listArtifacts };
