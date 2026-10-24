// Grizzy: runs the real Claude Code CLI through the Agent Client Protocol (JSON-RPC over stdio) using
// `npx -y @zed-industries/claude-code-acp`, and maps its session updates onto the same events agent.js emits.
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const store = require('./store');
const mods = require('./mods/host');
const mcp = require('./mcp');
const agents = require('./agents');
const access = require('./access');

const NAME = 'Grizzy';
const PREFIX = 'grizzy:';
const isGrizzy = (m) => String(m || '').startsWith(PREFIX);

const procs = new Map();     // convId -> { child, sessionId, pending, nextId, buf, cwd }
const runs = new Map();      // convId -> { emit, approvals:Set }
const approvals = new Map(); // approvalId -> { resolve, options }

function shellEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT; // lets Grizzy start even when GrizzyCode itself was launched from a Claude Code session
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', `${process.env.HOME}/.local/bin`, `${process.env.HOME}/.claude/local`];
  env.PATH = [...extra, env.PATH || ''].join(':');
  return env;
}

function write(p, msg) { p.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n'); }
function call(p, method, params) {
  return new Promise((resolve, reject) => { const id = p.nextId++; p.pending.set(id, { resolve, reject }); write(p, { id, method, params }); });
}

function textOf(c) {
  if (!c) return '';
  if (Array.isArray(c)) return c.map(textOf).join('');
  if (c.type === 'text') return c.text || '';
  if (c.type === 'content') return textOf(c.content);
  if (c.type === 'diff') return `${c.path}\n${c.newText || ''}`;
  return '';
}

function onUpdate(convId, u) {
  const r = runs.get(convId); if (!r) return;
  const { emit } = r;
  switch (u.sessionUpdate) {
    case 'agent_message_chunk': { const t = textOf(u.content); if (t) emit({ type: 'text', convId, delta: t }); break; }
    case 'tool_call': emit({ type: 'tool_call', convId, id: u.toolCallId, name: u.title || u.kind || 'tool', input: u.rawInput || {} }); if (u.status === 'completed' || u.status === 'failed') emit({ type: 'tool_result', convId, id: u.toolCallId, output: textOf(u.content).slice(0, 4000) }); break;
    case 'tool_call_update':
      if (u.status === 'completed' || u.status === 'failed') emit({ type: 'tool_result', convId, id: u.toolCallId, output: ((u.status === 'failed' ? 'ERROR: ' : '') + textOf(u.content)).slice(0, 4000) });
      break;
    case 'usage_update': if (typeof u.used === 'number') r.ctxUsed = u.used; if (typeof u.size === 'number') r.ctxSize = u.size; break;
    case 'plan': if (Array.isArray(u.entries)) emit({ type: 'info', convId, text: 'Plan: ' + u.entries.map((e) => `${e.status === 'completed' ? '✓' : '•'} ${e.content}`).join(' ') }); break;
    default: break; // agent_thought_chunk, user_message_chunk, available_commands_update, …
  }
}

function onMessage(convId, p, m) {
  if (m.id !== undefined && !m.method) { // response to one of our requests
    const w = p.pending.get(m.id); if (!w) return; p.pending.delete(m.id);
    m.error ? w.reject(new Error(m.error.message || 'ACP error')) : w.resolve(m.result); return;
  }
  if (m.method === 'session/update') return onUpdate(convId, m.params.update);
  if (m.method === 'session/request_permission') {
    const r = runs.get(convId);
    if (!r) return write(p, { id: m.id, result: { outcome: { outcome: 'cancelled' } } });
    const tc = m.params.toolCall || {}, options = m.params.options || [], approvalId = randomUUID();
    const blocked = access.checkAcp(p.access || [], tc, p.cwd); // the agent's own limits are answered without asking
    if (blocked) {
      const no = options.find((o) => o.kind === 'reject_once') || options.find((o) => o.kind === 'reject_always');
      r.emit({ type: 'info', convId, text: `Declined ${tc.title || tc.kind || 'a tool call'}: ${blocked}` });
      return write(p, { id: m.id, result: { outcome: no ? { outcome: 'selected', optionId: no.optionId } : { outcome: 'cancelled' } } });
    }
    approvals.set(approvalId, { convId, options, respond: (outcome) => write(p, { id: m.id, result: { outcome } }) });
    r.emit({ type: 'approval', convId, approvalId, name: tc.title || tc.kind || 'tool', input: tc.rawInput || { command: tc.title || '' } });
    return;
  }
  if (m.id !== undefined) write(p, { id: m.id, error: { code: -32601, message: 'Method not found: ' + m.method } }); // fs/terminal not advertised
}

// 'grizzy:claude-code' = the CLI's own default model; 'grizzy:<anthropic model id>' pins that model via ANTHROPIC_MODEL.
const modelOf = (m) => { const id = String(m || '').slice(PREFIX.length); return id && id !== 'claude-code' ? id : ''; };

// Connectors the agent may use, in ACP's mcpServers shape. With no connector limit nothing is passed, so the CLI keeps its own setup.
function mcpFor(lists) {
  const sets = lists.map((a) => a.connectors).filter(Boolean); if (!sets.length) return [];
  const kv = (o) => Object.entries(o || {}).map(([name, value]) => ({ name, value: String(value) }));
  return Object.entries(mcp.readConfig().mcpServers || {}).filter(([n, d]) => !d.disabled && sets.every((s) => s.includes(n)))
    .map(([name, d]) => (d.url ? { type: 'http', name, url: d.url, headers: kv(d.headers) } : { name, command: d.command, args: d.args || [], env: kv(d.env) }));
}

async function ensure(convId, cwd, model, lists = []) {
  const servers = mcpFor(lists), denied = access.cliDenied(lists), key = JSON.stringify([servers, denied]);
  const have = procs.get(convId); if (have && have.cwd === cwd && have.model === model && have.key === key && !have.child.killed) { have.access = lists; return have; }
  if (have) have.child.kill();
  const child = spawn('npx', ['-y', '@zed-industries/claude-code-acp'], { cwd, env: { ...shellEnv(), ...(model ? { ANTHROPIC_MODEL: model } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
  const p = { child, pending: new Map(), nextId: 1, buf: '', cwd, model, key, access: lists, sessionId: null, stderr: '' };
  procs.set(convId, p);
  child.stdout.on('data', (d) => {
    p.buf += d; let i;
    while ((i = p.buf.indexOf('\n')) >= 0) { const line = p.buf.slice(0, i).trim(); p.buf = p.buf.slice(i + 1); if (!line) continue; try { onMessage(convId, p, JSON.parse(line)); } catch {} }
  });
  child.stderr.on('data', (d) => { p.stderr = (p.stderr + d).slice(-2000); });
  child.on('error', (e) => { for (const w of p.pending.values()) w.reject(e); });
  child.on('exit', () => { for (const w of p.pending.values()) w.reject(new Error('Claude Code exited. ' + p.stderr.trim().split('\n').pop())); p.pending.clear(); if (procs.get(convId) === p) procs.delete(convId); });
  await call(p, 'initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
  p.sessionId = (await call(p, 'session/new', { cwd, mcpServers: servers, ...(denied.length ? { _meta: { claudeCode: { options: { disallowedTools: denied } } } } : {}) })).sessionId;
  return p;
}

async function send(convId, userText, emit, model) {
  const conv = store.getConversation(convId);
  conv.messages.push({ role: 'user', content: userText });
  if (conv.messages.length === 1) conv.title = userText.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New conversation';
  store.saveConversation(conv);
  emit({ type: 'start', convId, title: conv.title });
  let text = '', cancelled = false;
  const sink = (ev) => { if (ev.type === 'text') text += ev.delta; emit(ev); };
  const turnId = randomUUID(), t0 = Date.now(), run = { emit: sink };
  runs.set(convId, run);
  mods.setSession({ convId, cwd: conv.cwd || '' });
  await mods.turnStart({ text: userText, turnId });
  try {
    const p = await ensure(convId, conv.cwd || process.env.HOME, modelOf(model || conv.model), [agents.accessOf(agents.get(conv.agentId))]);
    // The CLI may report token usage on the prompt result; when it does not, estimate (about 4 characters a token) so mods still see the turn.
    await mods.turnStep({ turnId, index: 0, model: model || conv.model, messageCount: conv.messages.length }, async () => {
      const res = await call(p, 'session/prompt', { sessionId: p.sessionId, prompt: [{ type: 'text', text: userText }] });
      cancelled = res?.stopReason === 'cancelled';
      const u = res?.usage || res?._meta?.usage || null;
      if (u) return { input_tokens: u.inputTokens ?? u.input_tokens ?? 0, output_tokens: u.outputTokens ?? u.output_tokens ?? 0, cache_read_input_tokens: u.cachedReadTokens ?? u.cache_read_input_tokens ?? 0, cache_creation_input_tokens: u.cachedWriteTokens ?? u.cache_creation_input_tokens ?? 0 };
      return { input_tokens: Math.ceil(userText.length / 4), output_tokens: Math.ceil(text.length / 4), cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    });
    if (run.ctxUsed) { const l = store.getConversation(convId); l.ctx = { used: run.ctxUsed, max: run.ctxSize || null, model: model || conv.model, at: Date.now() }; store.saveConversation(l); emit({ type: 'usage', convId, usage: l.usage || { in: 0, out: 0, cr: 0, cw: 0 }, last: { in: 0, out: 0, cr: 0, cw: 0 }, ctx: l.ctx }); }
    emit({ type: 'done', convId });
  } catch (e) {
    emit({ type: runs.get(convId)?.stopped ? 'done' : 'error', convId, message: hasCli() ? e.message : `${e.message}\n${SETUP_NOTE}` });
  } finally {
    const stopped = !!runs.get(convId)?.stopped;
    runs.delete(convId);
    const l = store.getConversation(convId); l.messages.push({ role: 'assistant', content: [{ type: 'text', text: text || (cancelled ? '(stopped)' : '') }] }); l.title = conv.title; store.saveConversation(l);
    mods.turnComplete({ answer: text, durationMs: Date.now() - t0, isAborted: cancelled || stopped, turnId, reason: cancelled || stopped ? 'aborted' : 'answer' }).catch(() => {});
  }
}

function answer(approvalId, decision) {
  const a = approvals.get(approvalId); if (!a) return false;
  approvals.delete(approvalId);
  const pick = (kinds) => a.options.find((o) => kinds.includes(o.kind));
  const o = decision === 'once' ? pick(['allow_once']) : decision === 'session' ? pick(['allow_always', 'allow_once']) : pick(['reject_once', 'reject_always']);
  a.respond(o ? { outcome: 'selected', optionId: o.optionId } : { outcome: 'cancelled' });
  return true;
}

function stop(convId) {
  const p = procs.get(convId), r = runs.get(convId); if (r) r.stopped = true;
  for (const [id, a] of approvals) if (a.convId === convId) { a.respond({ outcome: 'cancelled' }); approvals.delete(id); }
  if (p?.sessionId) write(p, { method: 'session/cancel', params: { sessionId: p.sessionId } });
}
const isRunning = (convId) => runs.has(convId);
const kill = (convId) => { procs.get(convId)?.child.kill(); procs.delete(convId); };

const SETUP_NOTE = 'Grizzy needs the Claude Code CLI on this computer (install: npm i -g @anthropic-ai/claude-code, then run `claude /login`) and Node/npx.';
const hasCli = () => shellEnv().PATH.split(':').some((d) => { try { require('fs').accessSync(d + '/claude', require('fs').constants.X_OK); return true; } catch { return false; } });

const catalogGroup = () => ({ id: 'grizzy', label: NAME, hasKey: true, needsKey: false, note: hasCli() ? undefined : SETUP_NOTE, models: [{ value: PREFIX + 'claude-code', id: 'claude-code', name: `${NAME} (Claude Code CLI)`, ctx: 200000 },
  ...require('./providerdefs').BUILTINS.find((b) => b.id === 'anthropic').fallback.map((id) => ({ value: PREFIX + id, id, name: `${NAME} · ${id}`, ctx: 200000 }))] });

module.exports = { NAME, PREFIX, isGrizzy, send, answer, stop, isRunning, kill, catalogGroup };
