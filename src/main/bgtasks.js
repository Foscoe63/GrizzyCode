// Background shell tasks: long-running commands (dev servers, watchers, test runs) started by the model with bash { background: true }.
// The model reads their output with task_output and stops them with task_stop; the user sees and stops them from the Tasks panel.
const extras = require('./extras');

const tasks = new Map();      // id -> task
let seq = 0, notify = () => {};
const MAX_BUF = 200000;

const setNotifier = (fn) => { notify = fn || (() => {}); };
const view = (t) => ({ id: t.id, convId: t.convId, command: t.command, cwd: t.cwd, status: t.status, code: t.code, startedAt: t.startedAt, endedAt: t.endedAt || null, bytes: t.buf.length });

function start(convId, command, cwd) {
  const id = 'bg' + (++seq);
  const t = { id, convId, command, cwd, status: 'running', code: null, startedAt: Date.now(), buf: '', p: null };
  tasks.set(id, t);
  let p;
  try { p = extras.spawnShell(command, cwd, {}, { detached: true }); } catch (e) { tasks.delete(id); throw e; }
  t.p = p;
  const add = (d) => { t.buf += d; if (t.buf.length > MAX_BUF) t.buf = '…[earlier output dropped]\n' + t.buf.slice(-MAX_BUF); };
  p.stdout.on('data', add); p.stderr.on('data', add);
  const end = (code, why) => {
    if (t.status !== 'running') return;
    t.status = t.stopping ? 'stopped' : (code === 0 ? 'done' : 'failed'); t.code = code; t.endedAt = Date.now(); if (why) add(`\n[${why}]`);
    notify({ type: 'bgtask', convId, task: view(t) });
  };
  p.on('close', (code) => end(code));
  p.on('error', (e) => end(1, 'could not start: ' + e.message));
  notify({ type: 'bgtask', convId, task: view(t) });
  return view(t);
}
const get = (id) => tasks.get(String(id));
const list = (convId) => [...tasks.values()].filter((t) => !convId || t.convId === convId).map(view);
function output(id, tail = 8000) {
  const t = get(id); if (!t) return null;
  const n = Math.max(200, Math.min(60000, Number(tail) || 8000));
  return { ...view(t), output: t.buf.length > n ? '…' + t.buf.slice(-n) : t.buf };
}
function stop(id) {
  const t = get(id); if (!t) return null;
  if (t.status === 'running') {
    t.stopping = true;
    const kill = (sig) => { try { process.kill(-t.p.pid, sig); } catch { try { t.p.kill(sig); } catch {} } };
    kill('SIGTERM'); setTimeout(() => { if (t.status === 'running') kill('SIGKILL'); }, 3000).unref?.();
  }
  return view(t);
}
const stopAll = (convId) => { for (const t of tasks.values()) if (!convId || t.convId === convId) stop(t.id); };
const clearFinished = (convId) => { for (const [id, t] of tasks) if (t.status !== 'running' && (!convId || t.convId === convId)) tasks.delete(id); };

module.exports = { start, get, list, output, stop, stopAll, clearFinished, setNotifier };
