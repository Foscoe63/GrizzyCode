// Secrets the agent asked the user for with request_secret. The model never receives a value: it learns that NAME is saved, shell
// commands then see $NAME in their environment (extras.spawnShell), and tool results that echo a value are redacted before the model
// reads them. Values are sealed like the API keys (macOS keychain when installed, a 0600 key file for dev runs); names are not secret.
const fs = require('fs');
const path = require('path');
const store = { root: () => require('./store').root(), get vault() { return require('./store').vault; } }; // loaded on use, so redact() and isValidName() work without Electron (tests)

const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const MIN_REDACT = 6; // shorter values would redact ordinary words out of every result
const file = () => path.join(store.root(), `agent-secrets${store.vault.tag()}.json`);
const isValidName = (n) => NAME_RE.test(String(n || ''));

function load() { try { const j = JSON.parse(fs.readFileSync(file(), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } }
function names() { return Object.keys(load()).sort(); }
function value(name) { const b = load()[name]; if (!b) return null; try { return store.vault.open(b); } catch { return null; } }
function has(name) { return value(name) !== null; }
function save(name, v) {
  if (!isValidName(name) || !v) return false;
  const all = load(); all[name] = store.vault.seal(String(v));
  fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(all), { mode: 0o600 });
  return true;
}
function remove(name) { const all = load(); delete all[name]; fs.writeFileSync(file(), JSON.stringify(all), { mode: 0o600 }); }
// Saved secrets as environment variables; a variable the caller sets itself wins.
function env() { const out = {}; for (const n of names()) { const v = value(n); if (v) out[n] = v; } return out; }
// text with every saved value replaced by [secret NAME], longest first so a value containing another is not left half visible.
function redact(text, list) {
  let out = String(text == null ? '' : text);
  const secrets = list || names().map((n) => [n, value(n)]).filter(([, v]) => v);
  for (const [n, v] of [...secrets].sort((a, b) => b[1].length - a[1].length)) if (v.length >= MIN_REDACT && out.includes(v)) out = out.split(v).join(`[secret ${n}]`);
  return out;
}

module.exports = { isValidName, names, has, save, remove, env, redact };
