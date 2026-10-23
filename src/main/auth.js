// Browser sign-in.
//  - OpenRouter: real OAuth (authorization code + PKCE S256). The system browser signs the user in and redirects to a
//    one-shot loopback server; the code is exchanged for a per-user API key. No password ever reaches this app.
//  - Anthropic: the Console has no third-party OAuth, so we open the keys page and offer to use a key the user copied.
const http = require('http');
const crypto = require('crypto');
const { clipboard, shell } = require('electron');
const store = require('./store');

const OR_BASE = 'https://openrouter.ai';
const CONSOLE_KEYS = 'https://console.anthropic.com/settings/keys';
const b64url = (b) => b.toString('base64url');
const KEY_RE = /^sk-ant-[A-Za-z0-9_-]{20,}$/;

// Store a provider key. It becomes the default endpoint only when no default key exists; either way the picker gains that
// provider's models and, as an explicit "I just signed in with this" action, the default model switches to it.
function grant(id, key, { account, models = [], base }) {
  const cur = store.getSettings();
  const patch = { keys: { [id]: key }, account };
  if (!cur.hasKey) Object.assign(patch, id === 'openrouter' ? { provider: 'openai', baseUrl: base + '/api/v1' } : { provider: 'anthropic', baseUrl: '' }, { apiKey: key });
  if (id === 'openrouter' && models.length) { patch.models = cur.hasKey ? cur.models : models; patch.model = 'openrouter:' + (models.includes(cur.model.replace(/^openrouter:/, '')) ? cur.model.replace(/^openrouter:/, '') : models[0]); }
  if (id === 'anthropic') patch.model = cur.model && !/^openrouter:/.test(cur.model) ? cur.model.replace(/^anthropic:/, '') : 'claude-sonnet-5-5';
  store.saveSettings(patch);
}

let pending = null; // { server, timer, finish }

const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>GrizzyCode</title><style>body{font:16px -apple-system,system-ui,sans-serif;background:#f9f9f7;color:#20201f;display:grid;place-items:center;height:100vh;margin:0}main{max-width:420px;text-align:center}h1{font:400 26px Georgia,serif}p{color:#6b6a65}@media(prefers-color-scheme:dark){body{background:#20201f;color:#f0efec}p{color:#a5a49a}}</style><main><h1>${title}</h1><p>${body}</p></main>`;

function cancel() { if (pending) pending.finish({ ok: false, error: 'Cancelled' }); }

// Starts the flow and resolves when the user finishes (or it times out / is cancelled).
function signInOpenRouter({ open = (u) => shell.openExternal(u), timeoutMs = 10 * 60 * 1000, base = OR_BASE } = {}) {
  cancel();
  return new Promise((resolve) => {
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    const server = http.createServer();
    let done = false;
    const finish = (r) => {
      if (done) return; done = true; clearTimeout(timer); pending = null;
      try { server.close(); server.closeAllConnections?.(); } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'Sign-in timed out. Try again.' }), timeoutMs);
    pending = { finish };
    server.on('request', async (req, res) => {
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const html = (code, t, b) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(page(t, b)); };
      if (u.searchParams.get('state') !== state) { html(400, 'Sign-in failed', 'The response did not match this sign-in request. Close this tab and try again from GrizzyCode.'); return; }
      const code = u.searchParams.get('code');
      if (!code) { html(400, 'Sign-in cancelled', 'No authorization was granted. You can close this tab.'); finish({ ok: false, error: 'Authorization was not granted.' }); return; }
      try {
        const r = await fetch(base + '/api/v1/auth/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.key) throw new Error(j.error?.message || j.message || `OpenRouter returned ${r.status}`);
        const models = await orModels(base, j.key);
        grant('openrouter', j.key, { account: { method: 'openrouter', at: Date.now() }, models, base });
        html(200, 'You’re signed in', 'You can close this tab and return to GrizzyCode.');
        finish({ ok: true, method: 'openrouter' });
      } catch (e) { html(500, 'Sign-in failed', 'GrizzyCode could not finish signing in. Return to the app for details.'); finish({ ok: false, error: e.message }); }
    });
    server.on('error', (e) => finish({ ok: false, error: 'Could not start the local callback: ' + e.message }));
    server.listen(0, '127.0.0.1', () => {
      const cb = `http://localhost:${server.address().port}/callback`;
      const url = `${base}/auth?${new URLSearchParams({ callback_url: cb, code_challenge: challenge, code_challenge_method: 'S256', state, key_label: 'GrizzyCode' })}`;
      Promise.resolve(open(url)).catch((e) => finish({ ok: false, error: 'Could not open the browser: ' + e.message }));
    });
  });
}

// Claude models first, newest-looking ids first; the list is read live so no ids are hard-coded.
async function orModels(base, key) {
  try {
    const r = await fetch(base + '/api/v1/models', { headers: { authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(8000) });
    const ids = ((await r.json()).data || []).map((m) => m.id).filter((id) => /^anthropic\/claude/.test(id) && !/:batch$/.test(id));
    return ids.sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).slice(0, 8);
  } catch { return []; }
}

// Direct API key: verify it with OpenRouter first, then store it with the OpenRouter provider settings.
async function saveOpenRouterKey(key, base = OR_BASE) {
  key = String(key || '').trim();
  if (!/^sk-or-[A-Za-z0-9_-]{10,}$/.test(key)) return { ok: false, error: 'That doesn’t look like an OpenRouter key (it starts with sk-or-).' };
  try {
    const r = await fetch(base + '/api/v1/key', { headers: { authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(10000) });
    if (r.status === 401 || r.status === 403) return { ok: false, error: 'OpenRouter rejected this key. Check it was copied completely and is not disabled.' };
    if (!r.ok) return { ok: false, error: `OpenRouter returned ${r.status}.` };
  } catch (e) { return { ok: false, error: 'Could not reach OpenRouter: ' + e.message }; }
  const models = await orModels(base, key);
  grant('openrouter', key, { account: { method: 'openrouter-key', at: Date.now() }, models, base });
  return { ok: true };
}

const openAnthropicConsole = () => shell.openExternal(CONSOLE_KEYS);
const hint = (k) => k.slice(0, 7) + '…' + k.slice(-4);
// Looks (only on request) for an Anthropic key on the clipboard; never returns the key itself to the renderer.
const clip = async () => String((await clipboard.readText()) || '').trim(); // Electron 44 may return a promise
async function peekAnthropicKey() { const t = await clip(); return KEY_RE.test(t) ? { found: true, hint: hint(t) } : { found: false }; }
async function useAnthropicKey() {
  const t = await clip();
  if (!KEY_RE.test(t)) return { ok: false, error: 'No Anthropic API key found on the clipboard.' };
  grant('anthropic', t, { account: { method: 'anthropic-key', at: Date.now() } });
  if ((await clip()) === t) await clipboard.clear(); // don't leave the secret on the clipboard
  return { ok: true, hint: hint(t) };
}
function signOut() {
  cancel(); const cur = store.getSettings();
  const prefixed = (() => { const i = String(cur.model).indexOf(':'); return i > 0 && !!require('./providers').get(cur.model.slice(0, i), cur); })();
  store.saveSettings({ apiKey: '', account: null, keys: Object.fromEntries(Object.keys(cur.providerKeys || {}).map((id) => [id, ''])), ...(prefixed ? { model: 'claude-sonnet-5-5' } : {}) });
  return store.getSettings();
}
// Remove one provider's key (and the default key too when the default endpoint is that provider).
function removeProvider(id) {
  const cur = store.getSettings(); const patch = { keys: { [id]: '' } };
  if (store.defaultProviderId(cur) === id) { patch.apiKey = ''; patch.account = null; }
  if (String(cur.model).startsWith(id + ':')) patch.model = 'claude-sonnet-5-5';
  store.saveSettings(patch); return store.getSettings();
}
const status = () => { const s = store.getSettings(); return { signedIn: !!s.hasKey, method: s.account?.method || (s.hasKey ? 'manual' : null), provider: s.provider, baseUrl: s.baseUrl }; };

module.exports = { removeProvider, saveOpenRouterKey, signInOpenRouter, cancel, openAnthropicConsole, peekAnthropicKey, useAnthropicKey, signOut, status };
