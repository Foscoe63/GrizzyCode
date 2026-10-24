// Built-in tools for Code mode, plus skill access. Risky tools require approval.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const skills = require('./skills');
const memory = require('./memory');
const extras = require('./extras');
const bg = require('./bgtasks');

const MAX_OUT = 30000;
const clip = (s) => (s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n…[truncated ${s.length - MAX_OUT} chars]` : s);

const defs = [
  { name: 'read_file', kind: 'read', description: 'Read a UTF-8 text file. Optional 1-based line offset and limit.', risky: false,
    input_schema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, required: ['path'] } },
  { name: 'list_dir', kind: 'read', description: 'List entries of a directory.', risky: false,
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'grep', kind: 'read', description: 'Search files recursively for a regex (uses ripgrep if installed, else grep).', risky: false,
    input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
  { name: 'write_file', kind: 'edit', description: 'Create or overwrite a file with the given content.', risky: true,
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'edit_file', kind: 'edit', description: 'Replace one exact occurrence of old_string with new_string in a file.', risky: true,
    input_schema: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] } },
  { name: 'bash', kind: 'exec', description: 'Run a shell command in the working directory (zsh). 120s timeout. Set background:true for long-running commands (dev servers, watchers, slow test runs): it returns a task id at once and the command keeps running; read it with task_output and end it with task_stop.', risky: true,
    input_schema: { type: 'object', properties: { command: { type: 'string' }, background: { type: 'boolean', description: 'Run without waiting; returns a task id' } }, required: ['command'] } },
  { name: 'task_output', kind: 'read', description: 'Read the latest output and status of a background task started with bash background:true. Without an id, lists this session\'s background tasks.', risky: false,
    input_schema: { type: 'object', properties: { id: { type: 'string' }, tail: { type: 'integer', description: 'How many trailing characters to return (default 8000)' } } } },
  { name: 'task_stop', kind: 'read', description: 'Stop a background task started with bash background:true.', risky: false,
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'add_followup', kind: 'read', description: 'Put a task on the user\'s follow-up list instead of doing it now. Use it for work you noticed that is out of scope for the current request (a bug elsewhere, a refactor, a missing test). One short title and a self-contained description; the user can start it as its own session later.', risky: false,
    input_schema: { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string' } }, required: ['title'] } },
];
const planTool = { name: 'exit_plan_mode', description: 'In plan mode: present your finished implementation plan (markdown) for the user to approve. Call this when the plan is ready instead of making changes.', risky: false,
  input_schema: { type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'] } };
const skillTool = { name: 'use_skill', description: 'Load the full instructions of an installed skill by id.', risky: false,
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } };

const webTool = { name: 'web_fetch', kind: 'exec', description: 'Fetch a public web page or API (http/https) and return its text. Private and local addresses are blocked.', risky: true,
  input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } };
const memoryTool = { name: 'save_memory', kind: 'read', description: 'Save one short fact about the user that should be remembered in future conversations (preferences, projects, names). Only save durable facts the user shared.', risky: false,
  input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } };

// Agents: delegate work to a named agent (its own conversation, run to completion) and talk to agents that already exist.
// Execution lives in agent.js; both are 'read' kind because the agent's own tool calls are what get approved.
const MAX_AGENT_DEPTH = 2; // the main agent is depth 0; an agent at depth >= 2 cannot delegate further
const delegateTool = { name: 'delegate_agent', kind: 'read', description: 'Hand a self-contained task to another agent (see the agent list in the system prompt). It works independently with its own context and tools and returns a final report plus an agent id. Several delegate_agent calls in one turn run in parallel. Give it everything it needs: it cannot see this conversation.', risky: false,
  input_schema: { type: 'object', properties: { agent: { type: 'string', description: 'Agent id or name' }, task: { type: 'string', description: 'Complete instructions for the task and what to report back' } }, required: ['agent', 'task'] } };
const messageTool = { name: 'message_agent', kind: 'read', description: 'Send a message to an agent started earlier (by its id) and get its reply. Use it to ask follow-ups, correct course, or pass one agent\'s findings to another. An agent that is busy cannot be messaged.', risky: false,
  input_schema: { type: 'object', properties: { id: { type: 'string', description: 'Agent id returned by delegate_agent' }, message: { type: 'string' } }, required: ['id', 'message'] } };
const AGENT_TOOLS = [delegateTool.name, messageTool.name];

// caps: the capability settings (capShell, capEdit, capWeb, capSkills, capAgents, memoryEnabled && memoryAuto); omitted = defaults.
// opts.depth: how deep the calling agent is (0 = the main agent); opts.sub: a delegated agent, which never presents a plan.
function publicDefs(mode, permissionMode, caps = {}, opts = {}) {
  const on = (k, d = true) => (caps[k] === undefined ? d : !!caps[k]);
  let list = mode === 'code' ? (permissionMode === 'plan' ? defs.filter((d) => d.kind === 'read') : defs) : [];
  list = list.filter((d) => (d.kind !== 'exec' || on('capShell')) && (d.kind !== 'edit' || on('capEdit')));
  const out = [...list];
  if (mode === 'code' && permissionMode === 'plan' && !opts.sub) out.push(planTool);
  if (on('capAgents')) { if ((opts.depth || 0) < MAX_AGENT_DEPTH) out.push(delegateTool); out.push(messageTool); }
  if (on('capWeb', false) && permissionMode !== 'plan') out.push(webTool);
  if (on('memoryEnabled') && on('memoryAuto')) out.push(memoryTool);
  if (on('capSkills') && skills.list().length) out.push(skillTool);
  return out.map(({ risky, kind, ...t }) => t);
}
// 'read' | 'edit' | 'exec'
const kindOf = (name) => defs.find((d) => d.name === name)?.kind || (name === 'web_fetch' ? 'exec' : name.startsWith('mcp__') ? 'exec' : 'read');

// ---- SSH sessions: every file/shell tool runs on the remote host through the system ssh client ----
const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
const sshArgs = (host) => ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ControlMaster=auto', '-o', 'ControlPersist=60', '-o', `ControlPath=${path.join(require('os').tmpdir(), 'gc-ssh-%C')}`, host];
function sshExec(host, command, stdin, signal) {
  return new Promise((resolve, reject) => {
    const p = spawn('ssh', [...sshArgs(host), command]);
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    const kill = () => { try { p.kill('SIGKILL'); } catch {} };
    const t = setTimeout(() => { err += '\n[timed out after 120s]'; kill(); }, 120000);
    signal?.addEventListener('abort', kill, { once: true });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
    p.stdin.on('error', () => {}); p.stdin.end(stdin ?? '');
  });
}
const remotePath = (cwd, p) => (p && p.startsWith('/') ? p : `${cwd.replace(/\/$/, '')}/${p || '.'}`);
async function runRemote(name, input, host, cwd, signal) {
  const rp = (p) => remotePath(cwd, p);
  const ok = async (cmd, stdin) => { const r = await sshExec(host, cmd, stdin, signal); if (r.code) throw new Error((r.err || r.out).trim() || `remote exit ${r.code}`); return r.out; };
  switch (name) {
    case 'read_file': {
      const off = Math.max(1, input.offset || 1), end = input.limit ? off + input.limit - 1 : '$';
      return clip(await ok(`awk -v s=${off} -v e=${end === '$' ? 1e12 : end} 'NR>=s && NR<=e {print NR "\t" $0}' ${shq(rp(input.path))}`));
    }
    case 'list_dir': return (await ok(`ls -1Ap ${shq(rp(input.path))}`)).trim();
    case 'write_file': await ok(`mkdir -p "$(dirname ${shq(rp(input.path))})" && cat > ${shq(rp(input.path))}`, input.content); return `Wrote ${input.content.length} chars to ${rp(input.path)} on ${host}`;
    case 'edit_file': {
      const f = rp(input.path); const t = await ok(`cat ${shq(f)}`);
      const n = t.split(input.old_string).length - 1;
      if (n !== 1) throw new Error(n ? `old_string matches ${n} times; must be unique` : 'old_string not found');
      await ok(`cat > ${shq(f)}`, t.replace(input.old_string, () => input.new_string)); return `Edited ${f} on ${host}`;
    }
    case 'grep': return clip((await sshExec(host, `cd ${shq(cwd)} && ((command -v rg >/dev/null && rg -n --max-count 200 -e ${shq(input.pattern)} ${shq(rp(input.path))}) || grep -rnE ${shq(input.pattern)} ${shq(rp(input.path))} | head -200)`, '', signal)).out);
    case 'bash': { const r = await sshExec(host, `cd ${shq(cwd)} && ${input.command}`, '', signal); return clip(r.out + r.err) + (r.code ? `\n[exit ${r.code}]` : ''); }
    default: throw new Error('Unknown tool ' + name);
  }
}

function run(name, input, cwd, signal, ssh, ctx = {}) {
  if (ssh?.host && name === 'bash' && input.background) return Promise.resolve('ERROR: background tasks are not supported in SSH sessions.');
  if (ssh?.host && !['use_skill', 'save_memory', 'web_fetch', 'task_output', 'task_stop', 'add_followup'].includes(name)) return runRemote(name, input, ssh.host, cwd, signal);
  const abs = (p) => path.resolve(cwd || process.env.HOME, p || '.');
  switch (name) {
    case 'read_file': {
      const lines = fs.readFileSync(abs(input.path), 'utf8').split('\n');
      const off = Math.max(0, (input.offset || 1) - 1);
      const sl = lines.slice(off, input.limit ? off + input.limit : undefined);
      return clip(sl.map((l, i) => `${off + i + 1}\t${l}`).join('\n'));
    }
    case 'list_dir':
      return fs.readdirSync(abs(input.path), { withFileTypes: true }).map((e) => e.name + (e.isDirectory() ? '/' : '')).join('\n');
    case 'write_file':
      fs.mkdirSync(path.dirname(abs(input.path)), { recursive: true });
      fs.writeFileSync(abs(input.path), input.content);
      return `Wrote ${input.content.length} chars to ${abs(input.path)}`;
    case 'edit_file': {
      const f = abs(input.path); const t = fs.readFileSync(f, 'utf8');
      const n = t.split(input.old_string).length - 1;
      if (n !== 1) throw new Error(n ? `old_string matches ${n} times; must be unique` : 'old_string not found');
      fs.writeFileSync(f, t.replace(input.old_string, () => input.new_string));
      return 'Edited ' + f;
    }
    case 'grep':
      return sh(`(command -v rg >/dev/null && rg -n --max-count 200 -e "$GC_PAT" "$GC_DIR") || grep -rnE "$GC_PAT" "$GC_DIR" | head -200`, cwd, signal, { GC_PAT: input.pattern, GC_DIR: abs(input.path) });
    case 'bash': {
      if (!input.background) return sh(input.command, cwd, signal);
      const v = bg.start(ctx.convId || '', input.command, cwd);
      return `Started background task ${v.id}. It keeps running; use task_output with id "${v.id}" to read its output and task_stop to end it.`;
    }
    case 'task_output': {
      if (!input.id) { const l = bg.list(ctx.convId); return l.length ? l.map((v) => `${v.id}  ${v.status}${v.code != null ? ' (exit ' + v.code + ')' : ''}  ${v.command.slice(0, 100)}`).join('\n') : 'No background tasks.'; }
      const r = bg.output(input.id, input.tail); if (!r) return `ERROR: no background task ${input.id}.`;
      return `[${r.id} ${r.status}${r.code != null ? ', exit ' + r.code : ''}] ${r.command}\n${r.output || '(no output yet)'}`;
    }
    case 'task_stop': { const r = bg.stop(input.id); return r ? `Stopping ${r.id} (${r.status}).` : `ERROR: no background task ${input.id}.`; }
    case 'add_followup': { const r = ctx.addFollowup ? ctx.addFollowup(String(input.title || '').slice(0, 120), String(input.detail || '').slice(0, 4000)) : null; return r ? `Added to the follow-up list: ${r.title}` : 'ERROR: could not add a follow-up here.'; }
    case 'use_skill': return skills.read(input.id);
    case 'save_memory': { const r = memory.add(input.text, 'model'); return r.error || (r.duplicate ? 'Already remembered.' : 'Saved to memory.'); }
    case 'web_fetch': return webFetch(input.url, signal);
    default: throw new Error('Unknown tool ' + name);
  }
}

function sh(command, cwd, signal, env = {}) {
  return new Promise((resolve) => {
    const p = extras.spawnShell(command, cwd, env);
    let out = '';
    const add = (d) => { out += d; };
    p.stdout.on('data', add); p.stderr.on('data', add);
    const kill = () => { try { p.kill('SIGKILL'); } catch {} };
    const t = setTimeout(() => { out += '\n[timed out after 120s]'; kill(); }, 120000);
    signal?.addEventListener('abort', kill, { once: true });
    p.on('close', (code) => { clearTimeout(t); resolve(clip(out) + (code ? `\n[exit ${code}]` : '')); });
    p.on('error', (e) => { clearTimeout(t); resolve('ERROR: ' + e.message); });
  });
}

// ---- web_fetch: public http(s) only; resolves DNS and refuses private, loopback and link-local targets (also after redirects) ----
const dns = require('dns').promises;
const net = require('net');
function isPrivateIp(ip) {
  if (net.isIPv6(ip)) { const l = ip.toLowerCase(); return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || (l.startsWith('::ffff:') && isPrivateIp(l.slice(7))); }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
async function assertPublic(u) {
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https URLs can be fetched.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('Local addresses are blocked.');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('Private or local addresses are blocked.');
}
const htmlToText = (h) => h.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<\/(p|div|section|article|h[1-6]|ul|ol|table|blockquote|pre)>/gi, '\n\n').replace(/<\/(li|tr)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
async function webFetch(url, signal) {
  let u; try { u = new URL(url); } catch { throw new Error('That is not a valid URL.'); }
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(u);
    const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]), headers: { 'user-agent': 'GrizzyCode/1.0 (+web_fetch)', accept: 'text/html,text/plain,application/json,*/*;q=0.5' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { u = new URL(res.headers.get('location'), u); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (!/text\/|json|xml|javascript/.test(type)) throw new Error(`Unsupported content type: ${type || 'unknown'}`);
    const body = (await res.text()).slice(0, 400000);
    const text = /html/.test(type) ? htmlToText(body) : body;
    return clip(`URL: ${u}\n\n${text}`);
  }
  throw new Error('Too many redirects.');
}

module.exports = { AGENT_TOOLS, MAX_AGENT_DEPTH, publicDefs, kindOf, run, sshArgs, isPrivateIp, htmlToText };
