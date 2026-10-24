// OAuth for remote (Streamable HTTP) connectors, following the MCP authorization flow: a 401 points at the server's protected-resource
// metadata, which names an authorization server; GrizzyCode registers itself there (dynamic client registration, or a client ID the user
// typed in), signs the user in through their browser with PKCE and a loopback redirect, and keeps the tokens sealed (keychain in the
// installed app) so the connector can send them and refresh them. Tokens are bound to the connector's URL.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const file = () => path.join(store.root(), 'mcp_oauth' + store.vault.tag() + '.json');
const readAll = () => { try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return {}; } };
const writeAll = (d) => { fs.mkdirSync(store.root(), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(d, null, 2), { mode: 0o600 }); };
const get = (name) => { const raw = readAll()[name]; if (!raw) return null; try { return JSON.parse(store.vault.open(raw)); } catch { return null; } };
const put = (name, rec) => { const d = readAll(); d[name] = store.vault.seal(JSON.stringify(rec)); writeAll(d); };
const remove = (name) => { const d = readAll(); if (name in d) { delete d[name]; writeAll(d); } };
const rename = (from, to) => { const d = readAll(); if (from in d && from !== to) { d[to] = d[from]; delete d[from]; writeAll(d); } };
const signedIn = (name, def) => { const r = get(name); return !!(r && r.access && (!def || r.resource === def.url)); };

// Endpoints named by a remote server are only followed over https (or http on this machine), never to a private network by redirect.
const okUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' || (x.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(x.hostname)); } catch { return false; } };
const jget = async (f, url) => { if (!okUrl(url)) return null; try { const r = await f(url, { signal: AbortSignal.timeout(10000), headers: { accept: 'application/json' } }); return r.ok ? await r.json() : null; } catch { return null; } };
const tail = (u) => (u.pathname === '/' ? '' : u.pathname);

async function discover(url, wwwAuth, f = fetch) {
  const u = new URL(url);
  const rm = (/resource_metadata="([^"]+)"/.exec(wwwAuth || '') || [])[1];
  let prm = null;
  for (const c of [rm, `${u.origin}/.well-known/oauth-protected-resource${tail(u)}`, `${u.origin}/.well-known/oauth-protected-resource`]) { if (!c) continue; prm = await jget(f, c); if (prm) break; }
  const issuer = (prm && prm.authorization_servers && prm.authorization_servers[0]) || u.origin, iu = new URL(issuer);
  let meta = null;
  for (const c of [`${iu.origin}/.well-known/oauth-authorization-server${tail(iu)}`, `${iu.origin}/.well-known/openid-configuration${tail(iu)}`, `${iu.origin}/.well-known/oauth-authorization-server`]) { const m = await jget(f, c); if (m && m.authorization_endpoint && m.token_endpoint) { meta = m; break; } }
  if (!meta) meta = { authorization_endpoint: `${iu.origin}/authorize`, token_endpoint: `${iu.origin}/token`, registration_endpoint: `${iu.origin}/register`, legacy: true }; // servers that predate metadata
  const scope = (/scope="([^"]+)"/.exec(wwwAuth || '') || [])[1] || (prm && prm.scopes_supported ? prm.scopes_supported.join(' ') : '');
  return { issuer, meta, resource: url, scope };
}

const b64 = (b) => b.toString('base64url');
const form = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString();
async function tokenCall(f, endpoint, body) {
  if (!okUrl(endpoint)) throw new Error('The sign-in server gave an unsafe token address.');
  const r = await f(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form(body), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) { const e = new Error(j.error_description || j.error || `Token request failed (HTTP ${r.status})`); e.code = j.error; throw e; }
  return j;
}
const recordOf = (prev, j, extra = {}) => ({ ...prev, ...extra, access: j.access_token, refresh: j.refresh_token || (prev && prev.refresh) || '', expiresAt: j.expires_in ? Date.now() + Number(j.expires_in) * 1000 : 0, scope: j.scope || (prev && prev.scope) || '' });

// A valid Authorization header value for this connector, refreshing an expiring token first. null when not signed in.
async function bearer(name, def, f = fetch) {
  let r = get(name); if (!r || !r.access || r.resource !== def.url) return null;
  if (r.expiresAt && r.expiresAt - 60000 < Date.now()) r = (await refresh(name, f)) || null;
  return r ? 'Bearer ' + r.access : null;
}
const refreshing = new Map();
function refresh(name, f = fetch) { // one refresh at a time per connector; a revoked grant signs the connector out
  if (refreshing.has(name)) return refreshing.get(name);
  const p = (async () => {
    const r = get(name); if (!r || !r.refresh) { remove(name); return null; }
    try { const j = await tokenCall(f, r.tokenEndpoint, { grant_type: 'refresh_token', refresh_token: r.refresh, client_id: r.clientId, client_secret: r.clientSecret, resource: r.resource }); const n = recordOf(r, j); put(name, n); return n; }
    catch (e) { if (e.code === 'invalid_grant' || !e.code) { remove(name); } return null; }
  })().finally(() => refreshing.delete(name));
  refreshing.set(name, p); return p;
}

const flows = new Map();
function cancel(name) { const fl = flows.get(name); if (fl) fl.cancel(); }
const PAGE = (t, m) => `<!doctype html><meta charset="utf-8"><title>GrizzyCode</title><body style="font:16px -apple-system,system-ui;display:grid;place-items:center;height:90vh;color:#333"><div style="text-align:center"><h2>${t}</h2><p>${m}</p></div>`;

// Sign a connector in. `open(url)` shows the authorization page (the system browser in the app, a fake one in tests).
async function signIn(name, def, { open, fetch: f = fetch, timeoutMs = 5 * 60 * 1000 } = {}) {
  if (!def || !def.url) return { ok: false, error: 'Only remote (URL) connectors sign in with OAuth.' };
  if (!okUrl(def.url)) return { ok: false, error: 'The connector URL must use https.' };
  cancel(name);
  let probe;
  try { probe = await f(def.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'GrizzyCode', version: '1' } } }), signal: AbortSignal.timeout(15000) }); }
  catch (e) { return { ok: false, error: 'Could not reach the connector: ' + e.message }; }
  if (probe.status !== 401 && probe.status !== 403) return { ok: false, error: probe.ok ? 'This connector does not ask for a sign-in.' : `The connector answered HTTP ${probe.status}.` };
  const found = await discover(def.url, probe.headers.get('www-authenticate'), f);
  const { meta } = found;
  if (!okUrl(meta.authorization_endpoint) || !okUrl(meta.token_endpoint)) return { ok: false, error: 'The connector’s sign-in server gave unsafe addresses.' };

  let cancelled = false, done;
  const result = new Promise((res) => { done = res; });
  const srv = http.createServer(); let timer;
  const finish = (r) => { clearTimeout(timer); flows.delete(name); try { srv.close(); srv.closeAllConnections?.(); } catch {} done(r); };
  flows.set(name, { cancel: () => { cancelled = true; finish({ ok: false, error: 'Cancelled' }); } });
  await new Promise((res, rej) => { srv.once('error', rej); srv.listen(0, '127.0.0.1', res); }).catch((e) => finish({ ok: false, error: 'Could not start the local sign-in listener: ' + e.message }));
  if (cancelled) return result;
  const redirect = `http://127.0.0.1:${srv.address().port}/callback`;

  // Who GrizzyCode is to this server: a client ID the user supplied, else dynamic registration.
  let client = def.oauth && def.oauth.clientId ? { id: def.oauth.clientId, secret: def.oauth.clientSecret || '' } : null;
  if (!client && meta.registration_endpoint && okUrl(meta.registration_endpoint)) {
    try {
      const r = await f(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ client_name: 'GrizzyCode', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }), signal: AbortSignal.timeout(15000) });
      const j = await r.json().catch(() => ({})); if (r.ok && j.client_id) client = { id: j.client_id, secret: j.client_secret || '' };
    } catch {}
  }
  if (!client) { finish({ ok: false, error: 'This server does not allow apps to register themselves. Create an OAuth app there (redirect URI http://127.0.0.1) and enter its client ID in the connector settings.' }); return result; }

  const verifier = b64(crypto.randomBytes(48)), state = b64(crypto.randomBytes(16)), challenge = b64(crypto.createHash('sha256').update(verifier).digest());
  srv.on('request', async (req, res) => {
    const u = new URL(req.url, redirect);
    if (u.pathname !== '/callback') { res.statusCode = 404; return res.end(); }
    const reply = (code, t, m) => { res.statusCode = code; res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(PAGE(t, m)); };
    if (u.searchParams.get('state') !== state) return reply(400, 'Sign-in failed', 'The response did not match this sign-in. Close this tab and try again.');
    if (u.searchParams.get('error')) { reply(400, 'Sign-in was not completed', 'You can close this tab.'); return finish({ ok: false, error: u.searchParams.get('error_description') || u.searchParams.get('error') }); }
    const code = u.searchParams.get('code'); if (!code) return reply(400, 'Sign-in failed', 'No code was returned.');
    try {
      const j = await tokenCall(f, meta.token_endpoint, { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: client.id, client_secret: client.secret, code_verifier: verifier, resource: def.url });
      put(name, recordOf(null, j, { resource: def.url, issuer: found.issuer, tokenEndpoint: meta.token_endpoint, clientId: client.id, clientSecret: client.secret, at: Date.now() }));
      reply(200, 'You’re signed in', 'You can close this tab and return to GrizzyCode.'); finish({ ok: true });
    } catch (e) { reply(400, 'Sign-in failed', 'GrizzyCode could not finish signing in. You can close this tab.'); finish({ ok: false, error: e.message }); }
  });
  timer = setTimeout(() => finish({ ok: false, error: 'Sign-in timed out' }), timeoutMs);
  const au = new URL(meta.authorization_endpoint);
  for (const [k, v] of Object.entries({ response_type: 'code', client_id: client.id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state, resource: def.url, scope: found.scope })) if (v) au.searchParams.set(k, v);
  try { await open(au.toString()); } catch (e) { finish({ ok: false, error: 'Could not open the browser: ' + e.message }); }
  return result;
}

module.exports = { signIn, cancel, bearer, refresh, remove, rename, signedIn, discover, get, okUrl };
