// Built-in Google connectors: Gmail, Calendar, Sheets, Docs and Drive, talking to Google's REST APIs directly (no MCP server in between).
// Authorization works like GrizzyBot's: the user brings their own Google Cloud OAuth client (Client ID + Secret), and one browser sign-in
// (PKCE, fixed loopback redirect http://127.0.0.1:8765) unlocks all five apps. Client and tokens are kept sealed (keychain in the installed app).
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const PORT = 8765;
const REDIRECT = `http://127.0.0.1:${PORT}`;
const ENDPOINTS = { auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', revoke: 'https://oauth2.googleapis.com/revoke', userinfo: 'https://www.googleapis.com/oauth2/v2/userinfo', api: 'https://www.googleapis.com' };
const BASE_SCOPES = ['openid', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'];
const APPS = {
  gmail: { label: 'Gmail', scopes: ['https://www.googleapis.com/auth/gmail.modify'] },
  'google-calendar': { label: 'Google Calendar', scopes: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events'] },
  'google-sheets': { label: 'Google Sheets', scopes: ['https://www.googleapis.com/auth/spreadsheets'] },
  'google-docs': { label: 'Google Docs', scopes: ['https://www.googleapis.com/auth/documents'] },
  'google-drive': { label: 'Google Drive', scopes: ['https://www.googleapis.com/auth/drive'] },
};
const isApp = (name) => Object.prototype.hasOwnProperty.call(APPS, name);
const allScopes = () => [...new Set([...BASE_SCOPES, ...Object.values(APPS).flatMap((a) => a.scopes)])];

const SETUP = [
  { title: 'Open Google Cloud Console', body: 'Sign in with the Google account that owns your Gmail and Calendar, then create a project (or pick one). One project covers every Google app in GrizzyCode.', link: 'https://console.cloud.google.com/' },
  { title: 'Enable the APIs', body: 'APIs & Services → Library. Enable the Gmail, Google Calendar, Google Sheets, Google Docs and Google Drive APIs (skip any you will not use).', link: 'https://console.cloud.google.com/apis/library' },
  { title: 'Configure the consent screen', body: 'APIs & Services → OAuth consent screen. User type External (or Internal for a Workspace). While the app is in Testing, add your own Google account under Test users.', link: 'https://console.cloud.google.com/apis/credentials/consent' },
  { title: 'Create the OAuth client', body: `Credentials → Create credentials → OAuth client ID. Choose Desktop app (or Web application) and add ${REDIRECT} (no trailing slash) as an Authorized redirect URI.`, link: 'https://console.cloud.google.com/apis/credentials' },
  { title: 'Paste the Client ID and Secret here', body: 'Save them, then sign in. A redirect_uri_mismatch error means the redirect URI above is missing from the client.' },
];

// ---- sealed state: { clientId, clientSecret, token: { access, refresh, expiresAt, scope, email } } ----
const file = () => path.join(store.root(), 'google_oauth' + store.vault.tag() + '.json');
function load() { try { return JSON.parse(store.vault.open(JSON.parse(fs.readFileSync(file(), 'utf8')).sealed)); } catch { return {}; } }
function save(s) { fs.mkdirSync(store.root(), { recursive: true }); fs.writeFileSync(file(), JSON.stringify({ sealed: store.vault.seal(JSON.stringify(s)) }), { mode: 0o600 }); }
const clean = (v) => String(v || '').trim();

function client() { const s = load(); return { clientId: s.clientId || '', hasSecret: !!s.clientSecret, redirectUri: REDIRECT, steps: SETUP }; }
function setClient({ clientId, clientSecret } = {}) {
  const s = load(), id = clean(clientId), secret = clean(clientSecret);
  if (id && id !== s.clientId) delete s.token; // a token only works with the client that issued it
  if (id) s.clientId = id;
  if (secret) s.clientSecret = secret;
  if (!s.clientId || !s.clientSecret) return { error: 'Enter both the Client ID and the Client secret.' };
  save(s); return { ok: true, ...client() };
}
const signedIn = () => { const t = load().token; return !!(t && (t.access || t.refresh)); };
const account = () => load().token?.email || '';
const configured = () => { const s = load(); return !!(s.clientId && s.clientSecret); };
const state = () => (signedIn() ? 'signed-in' : 'required');

// ---- OAuth ----
const b64 = (b) => b.toString('base64url');
const form = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString();
async function tokenCall(f, body) {
  const r = await f(ENDPOINTS.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form(body), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) { const e = new Error(j.error_description || j.error || `Token request failed (HTTP ${r.status})`); e.code = j.error; throw e; }
  return j;
}
const tokenOf = (prev, j) => ({ ...prev, access: j.access_token, refresh: j.refresh_token || prev?.refresh || '', expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000, scope: j.scope || prev?.scope || '' });
const nice = (m) => (/redirect_uri/i.test(m) ? `Google rejected the redirect URI. In Cloud Console → your OAuth client → Authorized redirect URIs, add exactly ${REDIRECT} (no trailing slash), save, wait a minute and try again.` : m);

let flow = null;
const cancel = () => { if (flow) flow.cancel(); };
const PAGE = (t, m) => `<!doctype html><meta charset="utf-8"><title>GrizzyCode</title><body style="font:16px -apple-system,system-ui;display:grid;place-items:center;height:90vh;color:#333"><div style="text-align:center"><h2>${t}</h2><p>${m}</p></div>`;

// Sign in once for every Google app. `open(url)` shows the authorization page (the system browser in the app, a fake one in tests).
async function signIn({ open, fetch: f = fetch, timeoutMs = 3 * 60 * 1000, port = PORT } = {}) {
  const s = load();
  if (!s.clientId || !s.clientSecret) return { ok: false, error: 'Add a Google Client ID and Client secret first (Google settings).' };
  cancel();
  const redirect = `http://127.0.0.1:${port}`;
  const verifier = b64(crypto.randomBytes(48)), st = b64(crypto.randomBytes(16)), challenge = b64(crypto.createHash('sha256').update(verifier).digest());
  let timer, done;
  const result = new Promise((res) => { done = res; });
  const srv = http.createServer();
  const finish = (r) => { clearTimeout(timer); if (flow && flow.srv === srv) flow = null; try { srv.close(); srv.closeAllConnections?.(); } catch {} done(r); };
  flow = { srv, cancel: () => finish({ ok: false, error: 'Cancelled' }) };
  srv.on('request', async (req, res) => {
    const u = new URL(req.url, redirect);
    const reply = (code, t, m) => { res.statusCode = code; res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(PAGE(t, m)); };
    if (u.searchParams.get('state') !== st) return reply(400, 'Sign-in failed', 'The response did not match this sign-in. Close this tab and try again.');
    if (u.searchParams.get('error')) { reply(400, 'Sign-in was not completed', 'You can close this tab.'); return finish({ ok: false, error: `Google sign-in denied (${u.searchParams.get('error')}).` }); }
    const code = u.searchParams.get('code'); if (!code) return reply(400, 'Sign-in failed', 'No code was returned.');
    try {
      const j = await tokenCall(f, { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: s.clientId, client_secret: s.clientSecret, code_verifier: verifier });
      const t = tokenOf(null, j);
      try { const r = await f(ENDPOINTS.userinfo, { headers: { authorization: 'Bearer ' + t.access }, signal: AbortSignal.timeout(15000) }); if (r.ok) t.email = (await r.json()).email || ''; } catch {}
      save({ ...load(), token: t });
      reply(200, 'You’re signed in', 'GrizzyCode can now use your Google apps. You can close this tab.'); finish({ ok: true, email: t.email || '' });
    } catch (e) { reply(400, 'Sign-in failed', 'GrizzyCode could not finish signing in. You can close this tab.'); finish({ ok: false, error: nice(e.message) }); }
  });
  const listening = await new Promise((res) => { srv.once('error', (e) => res(e)); srv.listen(port, '127.0.0.1', () => res(null)); });
  if (listening) { finish({ ok: false, error: listening.code === 'EADDRINUSE' ? `Port ${port} is in use. Quit whatever is using it, then try again.` : 'Could not start the local sign-in listener: ' + listening.message }); return result; }
  timer = setTimeout(() => finish({ ok: false, error: `Timed out waiting for Google. If the browser showed redirect_uri_mismatch, add exactly ${redirect} under Authorized redirect URIs for this client.` }), timeoutMs);
  const au = new URL(ENDPOINTS.auth);
  for (const [k, v] of Object.entries({ client_id: s.clientId, redirect_uri: redirect, response_type: 'code', scope: allScopes().join(' '), access_type: 'offline', prompt: 'consent', state: st, code_challenge: challenge, code_challenge_method: 'S256' })) au.searchParams.set(k, v);
  try { await open(au.toString()); } catch (e) { finish({ ok: false, error: 'Could not open the browser: ' + e.message }); }
  return result;
}

async function signOut({ fetch: f = fetch } = {}) {
  const s = load(), t = s.token; delete s.token; save(s);
  if (t && (t.refresh || t.access)) { try { await f(ENDPOINTS.revoke, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ token: t.refresh || t.access }), signal: AbortSignal.timeout(10000) }); } catch {} }
}

const refreshing = { p: null };
function refresh(f = fetch) { // one refresh at a time; a revoked grant signs Google out
  if (refreshing.p) return refreshing.p;
  refreshing.p = (async () => {
    const s = load(), t = s.token;
    if (!t || !t.refresh || !s.clientId || !s.clientSecret) { delete s.token; save(s); return null; }
    try { const j = await tokenCall(f, { grant_type: 'refresh_token', refresh_token: t.refresh, client_id: s.clientId, client_secret: s.clientSecret }); const n = tokenOf(t, j); save({ ...s, token: n }); return n; }
    catch (e) { if (e.code === 'invalid_grant') { delete s.token; save(s); } return null; }
  })().finally(() => { refreshing.p = null; });
  return refreshing.p;
}
async function bearer(f = fetch) {
  let t = load().token; if (!t) return null;
  if (!t.access || t.expiresAt - 60000 < Date.now()) t = await refresh(f);
  return t ? 'Bearer ' + t.access : null;
}

// ---- REST ----
const REAL_API = ENDPOINTS.api;
const target = (url) => (url.startsWith('http') ? (ENDPOINTS.api === REAL_API ? url : url.replace(/^https:\/\/[a-z]+\.googleapis\.com/, ENDPOINTS.api)) : ENDPOINTS.api + url); // tests point ENDPOINTS.api at a mock
const hint = (status, msg) => {
  if (status === 401) return 'Google sign-in expired — sign in again from Settings → Connectors.';
  if (status === 403 && /has not been used|is disabled|accessNotConfigured/i.test(msg)) return 'That API is not enabled for your Google Cloud project (APIs & Services → Library).';
  if (status === 403 && /insufficient|scope/i.test(msg)) return 'This sign-in is missing a required permission — sign out and sign in again to re-consent.';
  if (status === 403) return 'Access denied by Google.';
  if (status === 429) return 'Rate limited by Google — wait a moment and retry.';
  return '';
};
async function api(method, url, { body, raw, f = fetch, retried = false } = {}) {
  const auth = await bearer(f); if (!auth) throw new Error('Not signed in to Google. Sign in from Settings → Connectors.');
  const headers = { authorization: auth, accept: 'application/json' };
  let payload; if (raw) { payload = raw.body; headers['content-type'] = raw.type; } else if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  const r = await f(target(url), { method, headers, body: payload, signal: AbortSignal.timeout(60000) });
  if (r.status === 401 && !retried && await refresh(f)) return api(method, url, { body, raw, f, retried: true });
  const text = await r.text();
  if (!r.ok) { let m = text; try { m = JSON.parse(text).error?.message || text; } catch {} const h = hint(r.status, text); throw new Error(`Google HTTP ${r.status}: ${String(m).replace(/\s+/g, ' ').slice(0, 300)}${h ? ' — ' + h : ''}`); }
  if (r.status === 204 || !text) return {};
  try { return JSON.parse(text); } catch { return { text }; }
}
const getText = async (url, f = fetch) => { // export / media downloads return the file, not JSON
  const auth = await bearer(f); if (!auth) throw new Error('Not signed in to Google.');
  const r = await f(target(url), { headers: { authorization: auth }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`Google HTTP ${r.status}: ${(await r.text()).replace(/\s+/g, ' ').slice(0, 200)}`);
  return r.text();
};

// ---- helpers ----
const q = encodeURIComponent;
const MAX_OUT = 30000;
const cap = (t) => (t.length > MAX_OUT ? t.slice(0, MAX_OUT) + `\n… (${t.length - MAX_OUT} more characters not shown)` : t);
const idOf = (s) => { s = clean(s); const m = /\/d\/([\w-]+)/.exec(s); return m ? m[1] : s; };
const need = (a, ...keys) => { for (const k of keys) if (a[k] == null || a[k] === '') throw new Error(`Missing required argument: ${k}`); };
const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,;]/)).map((x) => String(x).trim()).filter(Boolean);
const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const dateOnly = (s) => /^\d{4}-\d{2}-\d{2}$/.test(clean(s));
const mapPool = async (items, n, fn) => { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } })); return out; };

function rawMail({ to, cc, bcc, subject, body, html }) {
  const enc = (s) => (/[^\x00-\x7f]/.test(s) ? `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=` : s);
  const h = [`To: ${to.join(', ')}`]; if (cc.length) h.push(`Cc: ${cc.join(', ')}`); if (bcc.length) h.push(`Bcc: ${bcc.join(', ')}`);
  h.push(`Subject: ${enc(subject)}`, 'MIME-Version: 1.0', `Content-Type: text/${html ? 'html' : 'plain'}; charset=UTF-8`);
  return Buffer.from(h.join('\r\n') + '\r\n\r\n' + body).toString('base64url');
}
function mailArgs(a) {
  const to = list(a.to), cc = list(a.cc), bcc = list(a.bcc);
  if (!to.length) throw new Error('No recipient. Pass "to".');
  for (const x of [...to, ...cc, ...bcc]) if (!x.includes('@')) throw new Error(`${x} is not an email address.`);
  const body = String(a.html || a.body || ''); if (!body) throw new Error('The message has no body.');
  return { to, cc, bcc, subject: String(a.subject || ''), body, html: !!a.html };
}
const header = (msg, n) => (msg.payload?.headers || []).find((h) => h.name.toLowerCase() === n.toLowerCase())?.value || '';
function bodyOf(part) { // prefer text/plain; fall back to tag-stripped HTML
  const find = (p, type) => { if (p.mimeType === type && p.body?.data) return Buffer.from(p.body.data, 'base64url').toString('utf8'); for (const c of p.parts || []) { const r = find(c, type); if (r) return r; } return ''; };
  const plain = find(part, 'text/plain'); if (plain) return plain;
  return find(part, 'text/html').replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();
}
const when = (t) => (t?.dateTime || t?.date || '');
const evLine = (e) => `[${e.id}] ${when(e.start)} → ${when(e.end)} · ${e.summary || '(no title)'}${e.location ? ' @ ' + e.location : ''}${e.attendees?.length ? ' · with ' + e.attendees.map((x) => x.email).join(', ') : ''}`;
function eventBody(a, creating) {
  const b = {};
  if (a.summary != null) b.summary = String(a.summary);
  if (a.description != null) b.description = String(a.description);
  if (a.location != null) b.location = String(a.location);
  if (a.attendees != null) b.attendees = list(a.attendees).map((email) => ({ email }));
  if (a.start) {
    const allDay = dateOnly(a.start), zone = clean(a.timeZone) || tz();
    const stamp = (v) => (dateOnly(v) ? { date: clean(v) } : { dateTime: clean(v), ...(/[zZ]|[+-]\d\d:?\d\d$/.test(clean(v)) ? {} : { timeZone: zone }) });
    b.start = stamp(a.start);
    if (a.end) b.end = stamp(a.end);
    else if (creating) { const d = new Date(allDay ? clean(a.start) + 'T00:00:00Z' : a.start); if (isNaN(d)) throw new Error(`Cannot read start time "${a.start}". Use ISO 8601, e.g. 2026-03-04T15:00:00.`); b.end = allDay ? { date: new Date(d.getTime() + 864e5).toISOString().slice(0, 10) } : { dateTime: new Date(d.getTime() + 36e5).toISOString() }; }
  } else if (a.end) b.end = dateOnly(a.end) ? { date: clean(a.end) } : { dateTime: clean(a.end), timeZone: clean(a.timeZone) || tz() };
  return b;
}
function docText(doc) {
  const out = []; const walk = (els) => { for (const el of els || []) { if (el.paragraph) out.push((el.paragraph.elements || []).map((e) => e.textRun?.content || '').join('')); else if (el.table) for (const r of el.table.tableRows || []) for (const c of r.tableCells || []) walk(c.content); } };
  walk(doc.body?.content); return out.join('');
}
const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-yaml|x-sh))/;
const mimeFor = (name) => ({ md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html', htm: 'text/html', js: 'text/javascript', css: 'text/css', xml: 'text/xml' }[path.extname(name).slice(1).toLowerCase()] || 'text/plain');

// ---- tools ----
const RO = { readOnlyHint: true }, WR = { readOnlyHint: false, destructiveHint: false }, DEL = { readOnlyHint: false, destructiveHint: true };
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const TOOLS = {
  gmail: [
    { name: 'search_messages', description: 'Search Gmail with Gmail search syntax (from:, subject:, is:unread, newer_than:7d, …). Returns id, date, sender and subject.', annotations: RO, inputSchema: { type: 'object', properties: { query: str('Gmail search query; empty lists the newest mail'), maxResults: num('Default 10, max 50') } },
      run: async (a, f) => {
        const r = await api('GET', `/gmail/v1/users/me/messages?q=${q(a.query || '')}&maxResults=${Math.min(+a.maxResults || 10, 50)}`, { f });
        if (!r.messages?.length) return `No Gmail messages for "${a.query || ''}".`;
        const rows = await mapPool(r.messages, 5, (m) => api('GET', `/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`, { f }));
        return rows.map((m) => `[${m.id}] ${header(m, 'Date')} · ${header(m, 'From')} · ${header(m, 'Subject') || '(no subject)'}\n    ${(m.snippet || '').slice(0, 160)}`).join('\n');
      } },
    { name: 'read_message', description: 'Read one Gmail message by id (from search_messages): headers and text body.', annotations: RO, inputSchema: { type: 'object', properties: { id: str('Message id') }, required: ['id'] },
      run: async (a, f) => { need(a, 'id'); const m = await api('GET', `/gmail/v1/users/me/messages/${q(a.id)}?format=full`, { f }); return cap(`From: ${header(m, 'From')}\nTo: ${header(m, 'To')}\nDate: ${header(m, 'Date')}\nSubject: ${header(m, 'Subject')}\n\n${bodyOf(m.payload || {})}`); } },
    { name: 'create_draft', description: 'Save a draft email in Gmail without sending it.', annotations: WR, inputSchema: { type: 'object', properties: { to: str('Recipient(s), comma separated'), cc: str('Cc'), bcc: str('Bcc'), subject: str('Subject'), body: str('Plain-text body'), html: str('HTML body (used instead of body)') }, required: ['to'] },
      run: async (a, f) => { const r = await api('POST', '/gmail/v1/users/me/drafts', { body: { message: { raw: rawMail(mailArgs(a)) } }, f }); if (!r.id) throw new Error('Gmail returned no draft id, so nothing was saved.'); return `Draft saved (id ${r.id}).`; } },
    { name: 'send_message', description: 'Send an email from the signed-in Gmail account. This sends immediately.', annotations: DEL, inputSchema: { type: 'object', properties: { to: str('Recipient(s), comma separated'), cc: str('Cc'), bcc: str('Bcc'), subject: str('Subject'), body: str('Plain-text body'), html: str('HTML body (used instead of body)') }, required: ['to', 'body'] },
      run: async (a, f) => { const r = await api('POST', '/gmail/v1/users/me/messages/send', { body: { raw: rawMail(mailArgs(a)) }, f }); if (!r.id) throw new Error('Gmail returned no message id, so nothing was sent.'); return `Sent (message id ${r.id}).`; } },
  ],
  'google-calendar': [
    { name: 'list_calendars', description: 'List the calendars on the account with their ids.', annotations: RO, inputSchema: { type: 'object', properties: {} },
      run: async (a, f) => { const r = await api('GET', '/calendar/v3/users/me/calendarList?maxResults=250', { f }); return (r.items || []).map((c) => `${c.id} · ${c.summary}${c.primary ? ' (primary)' : ''}`).join('\n') || 'No calendars.'; } },
    { name: 'list_events', description: 'List calendar events in a time window (default: the next 7 days), soonest first. Each line starts with [eventId].', annotations: RO, inputSchema: { type: 'object', properties: { calendarId: str('Calendar id; default primary'), timeMin: str('ISO 8601 start, default now'), timeMax: str('ISO 8601 end, default 7 days out'), query: str('Free-text filter'), maxResults: num('Default 25, max 250') } },
      run: async (a, f) => {
        const min = a.timeMin ? new Date(a.timeMin) : new Date(), max = a.timeMax ? new Date(a.timeMax) : new Date(min.getTime() + 7 * 864e5);
        if (isNaN(min) || isNaN(max)) throw new Error('timeMin/timeMax must be ISO 8601 dates.');
        const r = await api('GET', `/calendar/v3/calendars/${q(a.calendarId || 'primary')}/events?singleEvents=true&orderBy=startTime&timeMin=${q(min.toISOString())}&timeMax=${q(max.toISOString())}&maxResults=${Math.min(+a.maxResults || 25, 250)}${a.query ? '&q=' + q(a.query) : ''}`, { f });
        return (r.items || []).map(evLine).join('\n') || `No events between ${min.toISOString()} and ${max.toISOString()}.`;
      } },
    { name: 'create_event', description: 'Create a calendar event. start/end are ISO 8601 (2026-03-04T15:00:00) or a date (2026-03-04) for an all-day event; end defaults to one hour (or one day) after start.', annotations: WR, inputSchema: { type: 'object', properties: { summary: str('Title'), start: str('Start'), end: str('End'), timeZone: str('IANA zone for times without an offset; default this computer’s'), attendees: str('Attendee emails, comma separated'), location: str('Location'), description: str('Notes'), calendarId: str('Default primary') }, required: ['summary', 'start'] },
      run: async (a, f) => { need(a, 'summary', 'start'); const r = await api('POST', `/calendar/v3/calendars/${q(a.calendarId || 'primary')}/events`, { body: eventBody(a, true), f }); if (!r.id) throw new Error('Google returned no event id, so the event was not created.'); return `Created [${r.id}] ${r.summary} · ${when(r.start)}${r.htmlLink ? '\n' + r.htmlLink : ''}`; } },
    { name: 'update_event', description: 'Change fields of an existing event (id from list_events). Only the fields you pass change.', annotations: WR, inputSchema: { type: 'object', properties: { eventId: str('Event id'), calendarId: str('Default primary'), summary: str('Title'), start: str('Start'), end: str('End'), timeZone: str('IANA zone'), attendees: str('Replaces the attendee list'), location: str('Location'), description: str('Notes') }, required: ['eventId'] },
      run: async (a, f) => { need(a, 'eventId'); const r = await api('PATCH', `/calendar/v3/calendars/${q(a.calendarId || 'primary')}/events/${q(a.eventId)}`, { body: eventBody(a, false), f }); return `Updated [${r.id}] ${r.summary || ''} · ${when(r.start)}`; } },
    { name: 'delete_event', description: 'Delete a calendar event by id (from list_events). Guests are not notified unless they were invited.', annotations: DEL, inputSchema: { type: 'object', properties: { eventId: str('Event id'), calendarId: str('Default primary') }, required: ['eventId'] },
      run: async (a, f) => { need(a, 'eventId'); await api('DELETE', `/calendar/v3/calendars/${q(a.calendarId || 'primary')}/events/${q(a.eventId)}`, { f }); return `Deleted event ${a.eventId}.`; } },
  ],
  'google-sheets': [
    { name: 'read_range', description: 'Read cells from a spreadsheet. spreadsheetId may be the id or a full URL; range is A1 notation (default A1:Z200).', annotations: RO, inputSchema: { type: 'object', properties: { spreadsheetId: str('Spreadsheet id or URL'), range: str('e.g. Sheet1!A1:C10') }, required: ['spreadsheetId'] },
      run: async (a, f) => { need(a, 'spreadsheetId'); const r = await api('GET', `https://sheets.googleapis.com/v4/spreadsheets/${q(idOf(a.spreadsheetId))}/values/${q(a.range || 'A1:Z200')}`, { f }); return cap((r.values || []).map((row) => row.join('\t')).join('\n') || 'No values in that range.'); } },
    { name: 'append_rows', description: 'Append rows after the last row of a table in a spreadsheet.', annotations: WR, inputSchema: { type: 'object', properties: { spreadsheetId: str('Spreadsheet id or URL'), range: str('Where the table starts, e.g. Sheet1!A1 (default A1)'), values: { type: 'array', items: { type: 'array', items: {} }, description: 'Rows, each an array of cell values' } }, required: ['spreadsheetId', 'values'] },
      run: async (a, f) => { need(a, 'spreadsheetId'); if (!Array.isArray(a.values) || !a.values.length) throw new Error('values must be a non-empty array of rows.'); const r = await api('POST', `https://sheets.googleapis.com/v4/spreadsheets/${q(idOf(a.spreadsheetId))}/values/${q(a.range || 'A1')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { body: { values: a.values }, f }); return `Appended ${r.updates?.updatedRows ?? a.values.length} row(s) at ${r.updates?.updatedRange || 'the end of the table'}.`; } },
    { name: 'update_range', description: 'Overwrite a range of cells with the given values.', annotations: DEL, inputSchema: { type: 'object', properties: { spreadsheetId: str('Spreadsheet id or URL'), range: str('A1 range, e.g. Sheet1!B2:C3'), values: { type: 'array', items: { type: 'array', items: {} }, description: 'Rows of cell values' } }, required: ['spreadsheetId', 'range', 'values'] },
      run: async (a, f) => { need(a, 'spreadsheetId', 'range'); if (!Array.isArray(a.values) || !a.values.length) throw new Error('values must be a non-empty array of rows.'); const r = await api('PUT', `https://sheets.googleapis.com/v4/spreadsheets/${q(idOf(a.spreadsheetId))}/values/${q(a.range)}?valueInputOption=USER_ENTERED`, { body: { range: a.range, values: a.values }, f }); return `Updated ${r.updatedCells ?? '?'} cell(s) in ${r.updatedRange || a.range}.`; } },
  ],
  'google-docs': [
    { name: 'create_document', description: 'Create a new Google Doc with a title and optional plain-text body. Returns its link.', annotations: WR, inputSchema: { type: 'object', properties: { title: str('Document title'), body: str('Initial text') }, required: ['title'] },
      run: async (a, f) => { need(a, 'title'); const d = await api('POST', 'https://docs.googleapis.com/v1/documents', { body: { title: String(a.title) }, f }); if (!d.documentId) throw new Error('Google returned no document id.'); if (a.body) await api('POST', `https://docs.googleapis.com/v1/documents/${q(d.documentId)}:batchUpdate`, { body: { requests: [{ insertText: { location: { index: 1 }, text: String(a.body) } }] }, f }); return `Created "${a.title}" (${d.documentId})\nhttps://docs.google.com/document/d/${d.documentId}/edit`; } },
    { name: 'read_document', description: 'Read the text of a Google Doc (id or URL).', annotations: RO, inputSchema: { type: 'object', properties: { documentId: str('Document id or URL') }, required: ['documentId'] },
      run: async (a, f) => { need(a, 'documentId'); const d = await api('GET', `https://docs.googleapis.com/v1/documents/${q(idOf(a.documentId))}`, { f }); return cap(`# ${d.title}\n\n${docText(d)}`); } },
    { name: 'append_text', description: 'Append text to the end of a Google Doc.', annotations: WR, inputSchema: { type: 'object', properties: { documentId: str('Document id or URL'), text: str('Text to add') }, required: ['documentId', 'text'] },
      run: async (a, f) => { need(a, 'documentId', 'text'); const id = idOf(a.documentId); await api('POST', `https://docs.googleapis.com/v1/documents/${q(id)}:batchUpdate`, { body: { requests: [{ insertText: { endOfSegmentLocation: {}, text: String(a.text) } }] }, f }); return `Appended ${String(a.text).length} characters.\nhttps://docs.google.com/document/d/${id}/edit`; } },
  ],
  'google-drive': [
    { name: 'search_files', description: 'Search Drive. Plain words search file contents and names; Drive query syntax (name contains \'x\', mimeType = …) is passed through. Returns id, name and type.', annotations: RO, inputSchema: { type: 'object', properties: { query: str('Search text or Drive query'), maxResults: num('Default 10, max 50') }, required: ['query'] },
      run: async (a, f) => {
        need(a, 'query'); const t = String(a.query).trim(), raw = /\b(contains|=|!=|in parents)\b/.test(t);
        const drive = raw ? t : `fullText contains '${t.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
        const r = await api('GET', `/drive/v3/files?q=${q(`(${drive}) and trashed = false`)}&pageSize=${Math.min(+a.maxResults || 10, 50)}&fields=files(id,name,mimeType,modifiedTime,webViewLink)`, { f });
        return (r.files || []).map((x) => `[${x.id}] ${x.name} · ${x.mimeType.replace('application/vnd.google-apps.', 'google-')} · ${x.modifiedTime || ''}`).join('\n') || `No Drive files for "${t}".`;
      } },
    { name: 'read_file', description: 'Read a Drive file as text. Google Docs/Slides are exported as text, Sheets as CSV; other text files are downloaded. Binary files return metadata only.', annotations: RO, inputSchema: { type: 'object', properties: { fileId: str('File id or URL') }, required: ['fileId'] },
      run: async (a, f) => {
        need(a, 'fileId'); const id = idOf(a.fileId), m = await api('GET', `/drive/v3/files/${q(id)}?fields=id,name,mimeType,size,webViewLink`, { f });
        const g = m.mimeType.startsWith('application/vnd.google-apps.');
        if (g && /\.(document|presentation)$/.test(m.mimeType)) return cap(await getText(`/drive/v3/files/${q(id)}/export?mimeType=text/plain`, f));
        if (g && /spreadsheet$/.test(m.mimeType)) return cap(await getText(`/drive/v3/files/${q(id)}/export?mimeType=text/csv`, f));
        if (!g && TEXT_MIME.test(m.mimeType)) return cap(await getText(`/drive/v3/files/${q(id)}?alt=media`, f));
        return `${m.name} is ${m.mimeType}${m.size ? ` (${m.size} bytes)` : ''}; its content cannot be shown as text.\n${m.webViewLink || ''}`;
      } },
    { name: 'upload_file', description: 'Upload a text file to Drive, optionally into a folder.', annotations: WR, inputSchema: { type: 'object', properties: { name: str('File name, e.g. notes.md'), content: str('File text'), mimeType: str('Optional; inferred from the name'), folderId: str('Optional parent folder id') }, required: ['name', 'content'] },
      run: async (a, f) => {
        need(a, 'name'); if (a.content == null) throw new Error('Missing required argument: content');
        const type = clean(a.mimeType) || mimeFor(a.name), meta = { name: String(a.name), mimeType: type, ...(clean(a.folderId) ? { parents: [clean(a.folderId)] } : {}) }, bd = 'grizzycode-upload-boundary';
        const body = `--${bd}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${bd}\r\nContent-Type: ${type}; charset=UTF-8\r\n\r\n${String(a.content)}\r\n--${bd}--\r\n`;
        const r = await api('POST', '/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', { raw: { type: `multipart/related; boundary=${bd}`, body }, f });
        if (!r.id) throw new Error('Drive returned no file id, so nothing was uploaded.'); return `Uploaded ${r.name} (${r.id})${r.webViewLink ? '\n' + r.webViewLink : ''}`;
      } },
  ],
};

const toolList = (app) => (TOOLS[app] || []).map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }));
async function callTool(app, tool, args, { fetch: f = fetch } = {}) {
  const t = (TOOLS[app] || []).find((x) => x.name === tool); if (!t) throw new Error(`Unknown ${APPS[app]?.label || app} tool: ${tool}`);
  if (!signedIn()) throw new Error('Not signed in to Google. Sign in from Settings → Connectors.');
  return t.run(args || {}, f);
}

module.exports = { APPS, ENDPOINTS, REDIRECT, isApp, allScopes, client, setClient, configured, signedIn, account, state, signIn, signOut, cancel, refresh, bearer, toolList, callTool, rawMail, eventBody, docText };
