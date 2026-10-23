// Terminal pane backend: one real pty (node-pty) per session id, so interactive programs and TUIs work.
const path = require('path');
const fs = require('fs');
const os = require('os');

let pty = null;
try { pty = require('node-pty'); } catch (e) { console.error('node-pty unavailable:', e.message); }

const sessions = new Map(); // id -> { cwd, proc, cols, rows }

// Resolve the spawn-helper path inside app.asar.unpacked when packaged.
const shellOf = () => { try { const c = require('./store').getSettings().shellPath; if (c && fs.existsSync(c)) return c; } catch {} return process.env.SHELL || '/bin/zsh'; };

function open(id, baseCwd, send, size = {}, ssh = null) {
  let st = sessions.get(id);
  if (st?.proc) return { ok: true, reused: true };
  if (!pty) { send({ type: 'data', data: 'Terminal unavailable: node-pty failed to load.\r\n' }); return { ok: false }; }
  const cwd = st?.cwd || (ssh?.host ? baseCwd : baseCwd && fs.existsSync(baseCwd) ? baseCwd : os.homedir());
  const cols = size.cols || 80, rows = size.rows || 24;
  if (ssh?.host) {
    const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
    const proc = pty.spawn('ssh', ['-t', ssh.host, `cd ${q(baseCwd || '~')} && exec "$SHELL" -l`], { name: 'xterm-256color', cols, rows, cwd: os.homedir(), env: { ...process.env, TERM: 'xterm-256color' } });
    st = { cwd, proc, cols, rows }; sessions.set(id, st);
    proc.onData((data) => send({ type: 'data', data }));
    proc.onExit(({ exitCode }) => { if (sessions.get(id) === st) st.proc = null; send({ type: 'exit', code: exitCode }); });
    return { ok: true };
  }
  const proc = pty.spawn(shellOf(), ['-l'], { name: 'xterm-256color', cols, rows, cwd, env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } });
  st = { cwd, proc, cols, rows };
  sessions.set(id, st);
  proc.onData((data) => send({ type: 'data', data }));
  proc.onExit(({ exitCode }) => { if (sessions.get(id) === st) st.proc = null; send({ type: 'exit', code: exitCode }); });
  return { ok: true };
}
const input = (id, data) => { try { sessions.get(id)?.proc?.write(data); } catch {} };
const resize = (id, cols, rows) => {
  const st = sessions.get(id); if (!st?.proc || !(cols > 0 && rows > 0)) return;
  try { st.proc.resize(cols, rows); st.cols = cols; st.rows = rows; } catch {}
};
// Kept for callers that run a single command: types it into the pty.
function run(id, baseCwd, command, send) { open(id, baseCwd, send); input(id, command + '\r'); }
const kill = (id) => { const st = sessions.get(id); if (st?.proc) { try { st.proc.kill(); } catch {} st.proc = null; } };
const killAll = () => { for (const id of sessions.keys()) kill(id); sessions.clear(); };
const cwdOf = (id, base) => sessions.get(id)?.cwd || base;
const available = () => !!pty;
module.exports = { open, input, resize, run, kill, killAll, cwdOf, available };
