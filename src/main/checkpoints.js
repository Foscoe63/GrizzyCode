// File checkpoints behind "Rewind": before the model's first change to a file in a turn, its previous contents are saved so
// rewinding to an earlier message can put the file back. Shell commands are not tracked (their side effects can't be undone).
const fs = require('fs');
const path = require('path');
const store = require('./store');

const MAX_FILE = 5 * 1024 * 1024, KEEP_TURNS = 60;
const dir = (convId) => path.join(store.root(), 'checkpoints', String(convId).replace(/[^\w-]/g, ''));
const file = (convId, turn) => path.join(dir(convId), turn + '.json');

function record(convId, turn, abs) {
  try {
    const f = file(convId, turn); fs.mkdirSync(dir(convId), { recursive: true });
    const cp = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { files: [] };
    if (cp.files.some((x) => x.path === abs)) return;
    let entry = { path: abs, existed: false, content: null, skipped: null };
    try {
      const st = fs.statSync(abs);
      if (st.isFile()) { entry.existed = true; if (st.size > MAX_FILE) entry.skipped = 'too large'; else entry.content = fs.readFileSync(abs).toString('base64'); }
    } catch {}
    cp.files.push(entry); fs.writeFileSync(f, JSON.stringify(cp));
    prune(convId);
  } catch {}
}
const turns = (convId) => { try { return fs.readdirSync(dir(convId)).filter((n) => /^\d+\.json$/.test(n)).map((n) => parseInt(n, 10)).sort((a, b) => a - b); } catch { return []; } };
function prune(convId) { const t = turns(convId); for (const n of t.slice(0, Math.max(0, t.length - KEEP_TURNS))) { try { fs.rmSync(file(convId, n)); } catch {} } }

// Undo every recorded change made at message index >= turn, newest first. Returns what happened per file.
function restore(convId, turn) {
  const out = { restored: 0, removed: 0, skipped: [] };
  for (const n of turns(convId).filter((x) => x >= turn).reverse()) {
    let cp; try { cp = JSON.parse(fs.readFileSync(file(convId, n), 'utf8')); } catch { continue; }
    for (const e of [...cp.files].reverse()) {
      try {
        if (!e.existed) { if (fs.existsSync(e.path)) { fs.rmSync(e.path); out.removed++; } }
        else if (e.content != null) { fs.mkdirSync(path.dirname(e.path), { recursive: true }); fs.writeFileSync(e.path, Buffer.from(e.content, 'base64')); out.restored++; }
        else out.skipped.push(e.path + (e.skipped ? ` (${e.skipped})` : ''));
      } catch (err) { out.skipped.push(`${e.path} (${err.message})`); }
    }
    try { fs.rmSync(file(convId, n)); } catch {}
  }
  return out;
}
// Files a rewind to `turn` would touch (for the confirmation text).
function preview(convId, turn) {
  const set = new Set();
  for (const n of turns(convId).filter((x) => x >= turn)) { try { for (const e of JSON.parse(fs.readFileSync(file(convId, n), 'utf8')).files) set.add(e.path); } catch {} }
  return [...set];
}
function discard(convId, turn) { for (const n of turns(convId).filter((x) => x >= turn)) { try { fs.rmSync(file(convId, n)); } catch {} } }
const drop = (convId) => { try { fs.rmSync(dir(convId), { recursive: true, force: true }); } catch {} };

module.exports = { record, restore, preview, discard, drop, turns };
