// Hooks: shell commands that run around tool calls, configured in <data>/tool-tool-hooks.json (Tools ▸ Open Hooks Config):
//   { "hooks": [ { "event": "PreToolUse" | "PostToolUse", "matcher": "write_file|edit_file", "command": "npx prettier --check \"$GC_FILE\"", "timeout": 30 } ] }
// The command gets the call as JSON on stdin ({event, tool, input, output?, cwd}) and GC_TOOL / GC_FILE / GC_CWD in its environment.
// PreToolUse: exit code 2 blocks the call and its stderr is returned to the model. PostToolUse: exit code 2 appends stderr to the result.
// Any other non-zero exit is ignored (logged). Local sessions only.
// Session events (no matcher; the payload is {event, cwd, ...}):
//   SessionStart      — the first message of a conversation ({prompt}). Exit 0: stdout is added to the model's context.
//   UserPromptSubmit  — every message the user sends ({prompt}). Exit 2 refuses the message and shows stderr; exit 0: stdout is added as context.
//   Stop              — the model has finished and is about to end its turn ({prompt, answer}). Exit 2 sends stderr back as a reason to carry on
//                       (at most twice a turn, so a hook that always objects cannot loop forever).
// Tool events carry the call's id ({id}, and GC_CALL_ID) so a PreToolUse and its PostToolUse can be matched up.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const extras = require('./extras');

const file = () => path.join(store.root(), 'tool-hooks.json');
function load() {
  try { const j = JSON.parse(fs.readFileSync(file(), 'utf8')); return (Array.isArray(j) ? j : j.hooks || []).filter((h) => h && h.command && /^((Pre|Post)ToolUse|Stop|UserPromptSubmit|SessionStart)$/.test(h.event)); } catch { return []; }
}
const matches = (h, tool) => { if (!h.matcher || h.matcher === '*') return true; try { return new RegExp('^(?:' + h.matcher + ')$').test(tool); } catch { return false; } };

function runOne(h, payload, cwd, signal) {
  return new Promise((resolve) => {
    const env = { GC_EVENT: payload.event || '', GC_CALL_ID: payload.id || '', GC_TOOL: payload.tool || '', GC_CWD: cwd || '', GC_FILE: payload.input?.path ? path.resolve(cwd || '.', String(payload.input.path)) : '' };
    let p; try { p = extras.spawnShell(h.command, cwd || process.env.HOME, env); } catch (e) { return resolve({ code: 1, err: e.message }); }
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    const kill = () => { try { p.kill('SIGKILL'); } catch {} };
    const t = setTimeout(() => { err += '\n[hook timed out]'; kill(); }, Math.min(120, Math.max(1, Number(h.timeout) || 30)) * 1000);
    signal?.addEventListener('abort', kill, { once: true });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out: out.slice(0, 4000), err: err.slice(0, 4000) }); });
    p.on('error', (e) => { clearTimeout(t); resolve({ code: 1, err: e.message }); });
    p.stdin.on('error', () => {}); p.stdin.end(JSON.stringify(payload));
  });
}

// -> { block: 'reason' } for a Pre hook that exited 2, { note: 'text' } for a Post hook that exited 2, else {}
async function run(event, tool, input, cwd, signal, output, callId) {
  const hs = load().filter((h) => h.event === event && matches(h, tool)); if (!hs.length) return {};
  const notes = [];
  for (const h of hs) {
    const r = await runOne(h, { event, tool, input, cwd, ...(callId ? { id: callId } : {}), ...(output === undefined ? {} : { output: String(output).slice(0, 20000) }) }, cwd, signal);
    if (r.code === 2) { const msg = (r.err || r.out || 'blocked by hook').trim(); if (event === 'PreToolUse') return { block: `Blocked by a hook: ${msg}` }; notes.push(msg); }
  }
  return notes.length ? { note: notes.join('\n') } : {};
}

// A session event -> { block: 'stderr' } when a hook exited 2, { context: 'stdout of the hooks that exited 0' } otherwise.
async function runEvent(event, payload, cwd, signal) {
  const hs = load().filter((h) => h.event === event); if (!hs.length) return {};
  const ctx = [];
  for (const h of hs) {
    const r = await runOne(h, { event, cwd, ...payload }, cwd, signal);
    if (r.code === 2) return { block: (r.err || r.out || `blocked by a ${event} hook`).trim() };
    if (r.code === 0 && r.out && r.out.trim()) ctx.push(r.out.trim());
  }
  return ctx.length ? { context: ctx.join('\n').slice(0, 8000) } : {};
}

module.exports = { file, load, run, runEvent, matches };
