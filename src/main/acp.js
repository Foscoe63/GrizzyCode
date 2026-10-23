// Grizzy: runs the real Claude Code CLI through the Agent Client Protocol (JSON-RPC over stdio) using
// `npx -y @zed-industries/claude-code-acp`, and maps its session updates onto the same events agent.js emits.
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const store = require('./store');

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
    approvals.set(approvalId, { convId, options, respond: (outcome) => write(p, { id: m.id, result: { outcome } }) });
    r.emit({ type: 'approval', convId, approvalId, name: tc.title || tc.kind || 'tool', input: tc.rawInput || { command: tc.title || '' } });
    return;
  }
  if (m.id !== undefined) write(p, { id: m.id, error: { code: -32601, message: 'Method not found: ' + m.method } }); // fs/terminal not advertised
}

// 'grizzy:claude-code' = the CLI's own default model; 'grizzy:<anthropic model id>' pins that model via ANTHROPIC_MODEL.
const modelOf = (m) => { const id = String(m || '').slice(PREFIX.length); return id && id !== 'claude-code' ? id : ''; };

async function ensure(convId, cwd, model) {
  const have = procs.get(convId); if (have && have.cwd === cwd && have.model === model && !have.child.killed) return have;
  if (have) have.child.kill();
  const child = spawn('npx', ['-y', '@zed-industries/claude-code-acp'], { cwd, env: { ...shellEnv(), ...(model ? { ANTHROPIC_MODEL: model } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
  const p = { child, pending: new Map(), nextId: 1, buf: '', cwd, model, sessionId: null, stderr: '' };
  procs.set(convId, p);
  child.stdout.on('data', (d) => {
    p.buf += d; let i;
    while ((i = p.buf.indexOf('\n')) >= 0) { const line = p.buf.slice(0, i).trim(); p.buf = p.buf.slice(i + 1); if (!line) continue; try { onMessage(convId, p, JSON.parse(line)); } catch {} }
  });
  child.stderr.on('data', (d) => { p.stderr = (p.stderr + d).slice(-2000); });
  child.on('error', (e) => { for (const w of p.pending.values()) w.reject(e); });
  child.on('exit', () => { for (const w of p.pending.values()) w.reject(new Error('Claude Code exited. ' + p.stderr.trim().split('\n').pop())); p.pending.clear(); if (procs.get(convId) === p) procs.delete(convId); });
  await call(p, 'initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
  p.sessionId = (await call(p, 'session/new', { cwd, mcpServers: [] })).sessionId;
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
  runs.set(convId, { emit: sink });
  try {
    const p = await ensure(convId, conv.cwd || process.env.HOME, modelOf(model || conv.model));
    const res = await call(p, 'session/prompt', { sessionId: p.sessionId, prompt: [{ type: 'text', text: userText }] });
    cancelled = res?.stopReason === 'cancelled';
    emit({ type: 'done', convId });
  } catch (e) {
    emit({ type: runs.get(convId)?.stopped ? 'done' : 'error', convId, message: hasCli() ? e.message : `${e.message}\n${SETUP_NOTE}` });
  } finally {
    runs.delete(convId);
    const l = store.getConversation(convId); l.messages.push({ role: 'assistant', content: [{ type: 'text', text: text || (cancelled ? '(stopped)' : '') }] }); l.title = conv.title; store.saveConversation(l);
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
