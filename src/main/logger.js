// Plain-text logs under the app's log folder (shown by Settings → Developer). Never writes API keys.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let base = null;
const dirPath = () => (base ||= app.getPath('logs'));
function append(file, text) {
  try { fs.mkdirSync(dirPath(), { recursive: true }); const f = path.join(dirPath(), file); try { if (fs.statSync(f).size > 2 * 1024 * 1024) fs.renameSync(f, f + '.1'); } catch {} fs.appendFileSync(f, `${new Date().toISOString()} ${text}\n`); } catch {}
}
function tail(file, n = 60) { try { return fs.readFileSync(path.join(dirPath(), file), 'utf8').split('\n').slice(-n).join('\n'); } catch { return ''; } }
const scrub = (t) => String(t).replace(/sk-(ant|or)-[A-Za-z0-9_-]{6,}/g, 'sk-$1-…').replace(/(authorization:\s*bearer\s+)\S+/gi, '$1…');
function init() {
  for (const lvl of ['error', 'warn']) { const orig = console[lvl].bind(console); console[lvl] = (...a) => { orig(...a); append('main.log', `${lvl.toUpperCase()} ${scrub(a.map((x) => (x instanceof Error ? x.stack : typeof x === 'string' ? x : JSON.stringify(x))).join(' '))}`); }; }
  process.on('uncaughtException', (e) => append('main.log', 'UNCAUGHT ' + scrub(e.stack || e)));
  process.on('unhandledRejection', (e) => append('main.log', 'UNHANDLED ' + scrub(e?.stack || e)));
}
module.exports = { init, append, tail, dir: dirPath, scrub };
