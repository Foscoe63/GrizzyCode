// MCP client: local stdio servers (JSON-RPC 2.0, newline-delimited) and remote Streamable-HTTP servers.
// Config is compatible with the common { "mcpServers": { name: { command, args, env, cwd } | { url, headers } } } shape;
// GrizzyCode adds an optional `disabled: true` per server, `disabledTools: [toolName]` (Blocked: hidden from the model) and
// `allowedTools: [toolName]` (Always allow: no approval prompt). Every other tool is "Needs approval".
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');
const mcpauth = require('./mcpauth');

const configPath = () => path.join(store.root(), 'mcp_config.json');
const servers = new Map(); // name -> entry
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const PROTOCOL = '2024-11-05';

function readConfig() {
  try { const c = JSON.parse(fs.readFileSync(configPath(), 'utf8')); return { mcpServers: {}, ...c }; } catch { return { mcpServers: {} }; }
}
function writeConfig(cfg) { fs.mkdirSync(store.root(), { recursive: true }); fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2)); }

// ---- PATH: apps launched from Finder get a minimal PATH, so `npx`, `uvx`, `node` would not be found ----
let loginPath = '';
function warmShellPath() {
  return new Promise((resolve) => {
    if (loginPath) return resolve(loginPath);
    execFile(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf %s "$PATH"'], { timeout: 6000 }, (e, out) => { if (!e && out) loginPath = out.trim().split('\n').pop(); resolve(loginPath); });
  });
}
function fullPath() {
  const extra = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.cargo/bin')];
  return [...new Set([...loginPath.split(':'), ...(process.env.PATH || '').split(':'), ...extra].filter(Boolean))].join(':');
}

// ---- validation ----
function validate(name, def) {
  if (!NAME_RE.test(name || '')) return 'Name must be 1–40 letters, numbers, "-" or "_", starting with a letter or number.';
  if (!def || typeof def !== 'object') return 'Missing server definition.';
  if (def.url) {
    try { const u = new URL(def.url); if (!/^https?:$/.test(u.protocol)) return 'URL must start with http:// or https://.'; } catch { return 'That URL is not valid.'; }
    return null;
  }
  if (!def.command || typeof def.command !== 'string' || !def.command.trim()) return 'Enter a command to run (or a URL for a remote server).';
  if (def.args && !Array.isArray(def.args)) return 'Arguments must be a list.';
  return null;
}

// ---- transports ----
function pushStderr(entry, d) {
  entry.stderr = ((entry.stderr || '') + d.toString()).slice(-2000);
  try { require('./logger').append('mcp.log', `[${entry.name}] ${require('./logger').scrub(d.toString().trimEnd())}`); } catch {}
}

function startStdio(entry, def) {
  let proc;
  try {
    proc = spawn(def.command, def.args || [], { env: { ...process.env, PATH: fullPath(), ...(def.env || {}) }, stdio: ['pipe', 'pipe', 'pipe'], cwd: def.cwd || undefined });
  } catch (e) { entry.status = 'error'; entry.error = String(e); return false; }
  entry.proc = proc;
  const failPending = (err) => { for (const p of entry.pending.values()) p.reject(err); entry.pending.clear(); };
  proc.stdin.on('error', () => {});
  proc.on('error', (e) => { entry.status = 'error'; entry.error = e.code === 'ENOENT' ? `Command not found: ${def.command}` : e.message; failPending(new Error(entry.error)); });
  proc.on('exit', (c) => {
    if (entry.status !== 'error') { entry.status = c ? 'error' : 'stopped'; if (c) entry.error = `Exited with code ${c}`; }
    for (const p of entry.pending.values()) p.reject(new Error('server exited')); entry.pending.clear();
  });
  proc.stderr.on('data', (d) => pushStderr(entry, d));
  proc.stdout.on('data', (d) => {
    entry.buf += d.toString();
    let i;
    while ((i = entry.buf.indexOf('\n')) >= 0) {
      const line = entry.buf.slice(0, i).trim(); entry.buf = entry.buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && entry.pending.has(msg.id)) {
          const p = entry.pending.get(msg.id); entry.pending.delete(msg.id);
          msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
        }
      } catch {}
    }
  });
  return true;
}

// Streamable HTTP: POST each JSON-RPC message; the reply is JSON or an SSE stream containing the response.
async function httpSend(entry, msg, timeout, retried = false) {
  const def = entry.def;
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(def.headers || {}) };
  const own = Object.keys(def.headers || {}).some((k) => k.toLowerCase() === 'authorization'); // a header the user typed wins over OAuth
  if (!own) { const b = await mcpauth.bearer(entry.name, def); if (b) headers.authorization = b; }
  if (entry.sessionId) headers['mcp-session-id'] = entry.sessionId;
  if (entry.initialized) headers['mcp-protocol-version'] = PROTOCOL;
  const res = await fetch(def.url, { method: 'POST', headers, body: JSON.stringify(msg), signal: AbortSignal.timeout(timeout) });
  const sid = res.headers.get('mcp-session-id'); if (sid) entry.sessionId = sid;
  if (msg.id == null) { if (!res.ok && res.status !== 202) throw new Error(`HTTP ${res.status}`); return null; }
  if (res.status === 401 && !own && !retried && mcpauth.signedIn(entry.name, def) && await mcpauth.refresh(entry.name)) return httpSend(entry, msg, timeout, true); // the token went stale: refresh once and retry
  if (res.status === 401 && !own) { const e = new Error('Sign-in required'); e.authRequired = true; throw e; }
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(res.status === 401 || res.status === 403 ? `Not authorized (HTTP ${res.status}). Check the headers.` : `HTTP ${res.status} ${t.slice(0, 200)}`); }
  let reply;
  if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
    const dec = new TextDecoder(); let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (!data) continue;
        try { const m = JSON.parse(data); if (m.id === msg.id) { reply = m; break; } } catch {}
      }
      if (reply) break;
    }
  } else reply = await res.json();
  if (!reply) throw new Error('No response from server');
  if (reply.error) throw new Error(reply.error.message);
  return reply.result;
}

function rpc(entry, method, params, timeout = 30000) {
  if (entry.kind === 'http') return httpSend(entry, { jsonrpc: '2.0', id: entry.nextId++, method, params }, timeout);
  return new Promise((resolve, reject) => {
    const id = entry.nextId++;
    const t = setTimeout(() => { entry.pending.delete(id); reject(new Error(method + ' timed out')); }, timeout);
    entry.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    try { entry.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); } catch (e) { clearTimeout(t); entry.pending.delete(id); reject(e); }
  });
}
async function notify(entry, method) {
  if (entry.kind === 'http') return httpSend(entry, { jsonrpc: '2.0', method }, 15000).catch(() => {});
  try { entry.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); } catch {}
}

function makeEntry(name, def) {
  return { name, def, kind: def.url ? 'http' : 'stdio', tools: [], status: 'starting', error: null, stderr: '', pending: new Map(), nextId: 1, buf: '', sessionId: null, initialized: false };
}
function startServer(name, def, { register = true } = {}) {
  const entry = makeEntry(name, def);
  if (register) servers.set(name, entry);
  if (entry.kind === 'stdio' && !startStdio(entry, def)) { entry.ready = Promise.resolve(); return entry; }
  entry.ready = (async () => {
    await rpc(entry, 'initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'GrizzyCode', version: require('electron').app?.getVersion?.() || '0' } }, 20000);
    entry.initialized = true;
    await notify(entry, 'notifications/initialized');
    const r = await rpc(entry, 'tools/list', {});
    entry.tools = r.tools || [];
    entry.status = 'running';
  })().catch((e) => { if (e.authRequired) entry.authRequired = true; if (entry.status !== 'error') { entry.status = 'error'; entry.error = e.message; } });
  return entry;
}
function stopEntry(e) {
  try { e.proc?.kill(); } catch {}
  if (e.kind === 'http' && e.sessionId) fetch(e.def.url, { method: 'DELETE', headers: { 'mcp-session-id': e.sessionId, ...(e.def.headers || {}) }, signal: AbortSignal.timeout(3000) }).catch(() => {});
}

async function startAll() {
  stopAll();
  await warmShellPath();
  const cfg = readConfig();
  await Promise.all(Object.entries(cfg.mcpServers || {}).filter(([, d]) => !d.disabled).map(([n, d]) => startServer(n, d).ready));
}
function stopAll() { for (const e of servers.values()) stopEntry(e); servers.clear(); }
function stopServer(name) { const e = servers.get(name); if (e) { stopEntry(e); servers.delete(name); } }

// ---- management used by the Connectors settings tab ----
// Approval policy of one tool: 'block' | 'allow' | 'ask'. Tool annotations (readOnlyHint) only decide how the tools are grouped and what plan mode may use.
const policyIn = (def, tool) => ((def?.disabledTools || []).includes(tool) ? 'block' : (def?.allowedTools || []).includes(tool) ? 'allow' : 'ask');
const toolInfo = (t, def = {}) => ({ name: t.name, description: (t.description || '').slice(0, 200), enabled: policyIn(def, t.name) !== 'block', policy: policyIn(def, t.name), readOnly: t.annotations?.readOnlyHint === true, annotated: !!t.annotations && ('readOnlyHint' in t.annotations || 'destructiveHint' in t.annotations) });
const offTools = (e) => e.def?.disabledTools || [];
function list() {
  const cfg = readConfig().mcpServers || {};
  return Object.entries(cfg).map(([name, def]) => {
    const e = servers.get(name);
    return { name, def, type: def.url ? 'http' : 'stdio', disabled: !!def.disabled, status: def.disabled ? 'disabled' : e?.status || 'stopped', error: e?.error || null, stderr: e?.stderr || '', tools: (e?.tools || []).map((t) => toolInfo(t, def)), auth: def.url ? { state: mcpauth.signedIn(name, def) ? 'signed-in' : e?.authRequired ? 'required' : 'none', clientId: def.oauth?.clientId || '' } : null };
  });
}
// Save (add or edit, with optional rename) and (re)start just that server.
async function saveServer({ name, def, oldName }) {
  name = (name || '').trim();
  const err = validate(name, def); if (err) return { error: err };
  const cfg = readConfig(); cfg.mcpServers ||= {};
  if (name !== oldName && cfg.mcpServers[name]) return { error: `A connector named "${name}" already exists.` };
  const prevCfg = cfg.mcpServers[oldName || name];
  if (oldName && oldName !== name) { delete cfg.mcpServers[oldName]; stopServer(oldName); mcpauth.rename(oldName, name); }
  if (prevCfg?.url && prevCfg.url !== def.url) mcpauth.remove(name); // a token is only good for the address it was issued for
  const clean = { ...def }; for (const k of Object.keys(clean)) if (clean[k] == null || clean[k] === '' || (Array.isArray(clean[k]) && !clean[k].length) || (k === 'env' || k === 'headers') && !Object.keys(clean[k] || {}).length) delete clean[k];
  if (prevCfg?.disabled && def.disabled === undefined) clean.disabled = true;
  if (prevCfg?.disabledTools?.length && def.disabledTools === undefined) clean.disabledTools = prevCfg.disabledTools;
  if (prevCfg?.allowedTools?.length && def.allowedTools === undefined) clean.allowedTools = prevCfg.allowedTools;
  cfg.mcpServers[name] = clean; writeConfig(cfg);
  stopServer(name);
  if (!clean.disabled) await startServer(name, clean).ready;
  return { ok: true, servers: list() };
}
async function removeServer(name) { const cfg = readConfig(); delete (cfg.mcpServers || {})[name]; writeConfig(cfg); stopServer(name); mcpauth.remove(name); return list(); }
// OAuth sign-in / sign-out for a remote connector (`open` shows the authorization page in the browser).
async function signIn(name, opts) {
  const def = readConfig().mcpServers?.[name]; if (!def) return { ok: false, error: 'No such connector.', servers: list() };
  const r = await mcpauth.signIn(name, def, opts); if (r.ok && !def.disabled) { stopServer(name); await startServer(name, def).ready; }
  return { ...r, servers: list() };
}
async function signOut(name) { mcpauth.remove(name); const d = readConfig().mcpServers?.[name]; if (d && !d.disabled) { stopServer(name); await startServer(name, d).ready; } return list(); }
async function setDisabled(name, disabled) {
  const cfg = readConfig(); const d = cfg.mcpServers?.[name]; if (!d) return list();
  if (disabled) d.disabled = true; else delete d.disabled;
  writeConfig(cfg); stopServer(name);
  if (!disabled) await startServer(name, d).ready;
  return list();
}
// Set the policy of one tool, or of several at once, without restarting the server.
function setToolPolicy(name, tools, policy) {
  if (!['allow', 'ask', 'block'].includes(policy)) return list();
  const cfg = readConfig(); const d = cfg.mcpServers?.[name]; if (!d) return list();
  const off = new Set(d.disabledTools || []), on = new Set(d.allowedTools || []);
  for (const t of [].concat(tools)) { off.delete(t); on.delete(t); if (policy === 'block') off.add(t); else if (policy === 'allow') on.add(t); }
  if (off.size) d.disabledTools = [...off]; else delete d.disabledTools;
  if (on.size) d.allowedTools = [...on]; else delete d.allowedTools;
  writeConfig(cfg);
  const e = servers.get(name); if (e) e.def = d;
  return list();
}
// Older on/off switch: on means "needs approval" unless the tool was already always-allowed.
function setToolEnabled(name, tool, enabled) {
  const d = readConfig().mcpServers?.[name]; if (!d) return list();
  return setToolPolicy(name, tool, enabled ? ((d.allowedTools || []).includes(tool) ? 'allow' : 'ask') : 'block');
}
// By full tool name (mcp__server__tool): the policy and whether the tool says it only reads.
function lookup(fullName) { const [, server, ...rest] = String(fullName).split('__'); const e = servers.get(server); const tool = rest.join('__'); return { e, tool, t: e?.tools.find((x) => x.name === tool) }; }
const policyOf = (fullName) => { const { e, tool } = lookup(fullName); return e ? policyIn(e.def, tool) : 'ask'; };
const isReadOnly = (fullName) => lookup(fullName).t?.annotations?.readOnlyHint === true;
async function restartServer(name) {
  const d = readConfig().mcpServers?.[name]; if (!d) return list();
  stopServer(name); if (!d.disabled) await startServer(name, d).ready; return list();
}
// Try a definition without saving it: start, list tools, stop.
async function testServer(def) {
  const err = validate('test', def); if (err) return { ok: false, error: err };
  await warmShellPath();
  const e = startServer('test', def, { register: false });
  await e.ready;
  const out = e.status === 'running' ? { ok: true, tools: e.tools.map((t) => toolInfo(t, def)) } : { ok: false, error: e.authRequired ? 'This server needs you to sign in. Save the connector, then choose Sign in.' : e.error || 'Could not start', stderr: e.stderr, ...(e.authRequired ? { authRequired: true } : {}) };
  stopEntry(e); return out;
}
// Accepts a full config ({mcpServers}), a bare map of servers, or one server definition (needs `name`).
function parseImport(text, name) {
  let j; try { j = JSON.parse(text); } catch (e) { return { error: 'Not valid JSON: ' + e.message }; }
  let map;
  if (j && typeof j === 'object' && j.mcpServers && typeof j.mcpServers === 'object') map = j.mcpServers;
  else if (j && (j.command || j.url)) { if (!name) return { error: 'Give the connector a name first.' }; map = { [name]: j }; }
  else if (j && typeof j === 'object' && Object.values(j).length && Object.values(j).every((v) => v && typeof v === 'object' && (v.command || v.url))) map = j;
  else return { error: 'Expected {"mcpServers": {...}} or a server with "command" or "url".' };
  for (const [n, d] of Object.entries(map)) { const e = validate(n, d); if (e) return { error: `${n}: ${e}` }; }
  return { map };
}
async function importJson(text, { overwrite = false, name } = {}) {
  const p = parseImport(text, name); if (p.error) return p;
  const cfg = readConfig(); cfg.mcpServers ||= {};
  const added = [], skipped = [];
  for (const [n, d] of Object.entries(p.map)) { if (cfg.mcpServers[n] && !overwrite) { skipped.push(n); continue; } cfg.mcpServers[n] = d; added.push(n); }
  writeConfig(cfg);
  for (const n of added) { stopServer(n); if (!cfg.mcpServers[n].disabled) await startServer(n, cfg.mcpServers[n]).ready; }
  return { ok: true, added, skipped, servers: list() };
}

function status() { return [...servers.values()].map((e) => ({ name: e.name, status: e.status, error: e.error, tools: e.tools.map((t) => t.name) })); }

function toolDefs() {
  const out = [];
  for (const e of servers.values()) if (e.status === 'running') for (const t of e.tools) {
    if (offTools(e).includes(t.name)) continue;
    out.push({ name: `mcp__${e.name}__${t.name}`, description: `[${e.name}] ${t.description || ''}`.slice(0, 1000), input_schema: t.inputSchema || { type: 'object', properties: {} } });
  }
  return out;
}

async function callTool(fullName, args) {
  const [, server, ...rest] = fullName.split('__');
  const e = servers.get(server);
  if (!e || e.status !== 'running') throw new Error(`MCP server ${server} not running`);
  if (offTools(e).includes(rest.join('__'))) throw new Error(`Tool ${rest.join('__')} is disabled in settings`);
  const r = await rpc(e, 'tools/call', { name: rest.join('__'), arguments: args }, 120000);
  const text = (r.content || []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return r.isError ? 'ERROR: ' + text : text;
}

module.exports = { readConfig, writeConfig, startAll, stopAll, status, toolDefs, callTool, configPath, list, saveServer, removeServer, signIn, signOut, cancelSignIn: mcpauth.cancel, setDisabled, setToolEnabled, setToolPolicy, policyOf, isReadOnly, restartServer, testServer, importJson, parseImport, validate, warmShellPath, fullPath };
