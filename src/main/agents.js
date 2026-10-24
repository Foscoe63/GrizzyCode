// Agents: runtime profiles the user can pick per conversation or the model can delegate to. A profile is more than a persona: it fixes the
// tools on offer, a step budget, reasoning effort, guards on individual tool calls, completion gates (checked by GrizzyCode against what the
// agent actually did, not what it says) and a report contract. Grizzy (the Claude Code CLI) is the one built-in that is not a profile.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const access = require('./access');

const MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
const BUILTIN = [
  { id: 'general', icon: '🐻', name: 'GrizzyCode', description: 'The default assistant.', instructions: '', model: '', permissionMode: '' },
  { id: 'grizzy', icon: '🐻‍❄️', name: 'Grizzy', description: 'The real Claude Code CLI (needs `claude` installed and logged in).', instructions: '', model: 'grizzy:claude-code', permissionMode: '' },
  // Beyond a persona, each of these is a runtime profile: its own tool set, step budget, completion gates (the run is not allowed to
  // finish until they pass) and a report contract. `gates` are names from GATES below; `steps` is the delegated step budget.
  { id: 'engineer', icon: '🛠️', name: 'Engineer', description: 'Writes and refactors code in small, verified steps; will not finish an edit without running something to check it.', instructions: 'Act as a senior software engineer. Read the surrounding code before changing it, match its conventions, make the smallest correct change, and verify it (run tests or the build) before reporting done.', model: '', permissionMode: '', steps: 40, effort: 'medium', memory: true, guards: ['readBeforeEdit'], gates: ['evidence', 'verify'], report: 'Finish with: the files you changed and why, the command you ran to verify and its result, and anything left undone.' },
  { id: 'reviewer', icon: '🔍', name: 'Reviewer', description: 'Reviews code for bugs, security and clarity without changing it; must read the code and rank findings.', instructions: 'Act as a meticulous code reviewer. Look for correctness bugs, security issues, missing edge cases and unclear code. Report findings ranked by severity with file and line references. Do not modify files unless asked.', model: '', permissionMode: 'plan', tools: ['read_file', 'list_dir', 'grep'], steps: 20, effort: 'high', memory: true, gates: ['evidence', 'findings'], report: 'Finish with findings ranked Critical / High / Medium / Low / Nit, each as `path:line — problem — suggested fix`. If you found nothing, say "No issues found" and list what you checked.' },
  { id: 'planner', icon: '🗺️', name: 'Planner', description: 'Investigates the code first, then proposes a concrete numbered plan with files and risks.', instructions: 'Act as a technical planner. Investigate the codebase, ask about anything ambiguous, and produce a concrete step-by-step plan with the files involved and risks. Do not implement until the plan is approved.', model: '', permissionMode: 'plan', tools: ['read_file', 'list_dir', 'grep'], steps: 20, effort: 'high', gates: ['evidence', 'plan'], report: 'Finish with a numbered plan (each step names the files it touches), then a "Risks" section and an "Open questions" section.' },
  { id: 'researcher', icon: '📚', name: 'Researcher', description: 'Gathers evidence from files and the web (read-only), then reports findings with sources and what it could not verify.', instructions: 'Act as a careful researcher. Gather evidence before concluding, distinguish facts from inference, cite where each claim comes from, and say what you could not verify.', model: '', permissionMode: '', tools: ['read_file', 'list_dir', 'grep', 'web_fetch'], steps: 30, effort: 'medium', memory: true, gates: ['evidence', 'sources'], report: 'Finish with: the answer first, then the evidence (each claim with its source URL or path:line), then an "Unverified" section for anything you could not confirm.' },
  { id: 'writer', icon: '✍️', name: 'Writer', description: 'Drafts and edits prose in files (no shell or web); re-reads what it wrote before reporting.', instructions: 'Act as an editor and writer. Prefer plain, concise language, keep the author\'s voice, and explain notable edits briefly.', model: '', permissionMode: '', tools: ['read_file', 'list_dir', 'grep', 'write_file', 'edit_file'], steps: 15, guards: ['readBeforeEdit'], gates: ['readback'], report: 'Finish with the file(s) you wrote or edited and a short note on the notable edits.' },
];


// ---- Completion gates: a delegated (or persona'd) run may not finish until these pass ----
// `st` = { calls: [{ name, input }] (successful calls, in order), text: the final reply, can: Set of tool names on offer, nudges }.
// Each gate returns '' when satisfied, else the message sent back to the agent instead of letting it finish.
const EDITS = ['write_file', 'edit_file'], LOOKS = ['read_file', 'list_dir', 'grep', 'web_fetch'];
const lastIdx = (calls, names) => { for (let i = calls.length - 1; i >= 0; i--) if (names.includes(calls[i].name)) return i; return -1; };
const looked = (st) => st.calls.some((c) => LOOKS.includes(c.name) || c.name.startsWith('mcp__'));
// A shell call that ended non-zero or timed out (the bash tool appends "[exit N]" for those).
const failedRun = (c) => /\[exit (?!0\b)\d+\]|\[timed out/.test(c.out || '');
const CODE_EXT = 'js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|zsh|json|md|css|scss|html|yml|yaml|toml|vue|svelte|sql|txt';
// path:line references in a report that point at nothing: the file is missing, or the line is past its end. Only checked for local
// sessions with a known folder, and only for code-like extensions so "localhost:8080" or "example.com:443" are never mistaken for files.
function badRefs(st) {
  if (!st.cwd || st.ssh) return [];
  const seen = new Set(), bad = [], re = new RegExp(`(?<![\\w/.~-])((?:~|\\.{1,2})?/?[\\w@.+-]+(?:/[\\w@.+-]+)*\\.(?:${CODE_EXT})):(\\d+)(?:-\\d+)?`, 'g');
  let m;
  while ((m = re.exec(st.text)) && seen.size < 40) {
    const key = m[1] + ':' + m[2]; if (seen.has(key)) continue; seen.add(key);
    const abs = path.resolve(st.cwd, m[1].startsWith('~') ? path.join(require('os').homedir(), m[1].slice(1)) : m[1]);
    try { if (fs.readFileSync(abs, 'utf8').split('\n').length < Number(m[2])) bad.push(key + ' (the file has fewer lines)'); } catch { bad.push(key + ' (no such file)'); }
  }
  return bad;
}
const hasRef = (t) => new RegExp(`[\\w./-]+\\.(?:${CODE_EXT}):\\d+`).test(t);
const GATES = {
  evidence: (st) => (looked(st) ? '' : 'You have not looked at anything yet. Use your tools to read the relevant files or sources before you report.'),
  verify: (st) => {
    const i = lastIdx(st.calls, EDITS);
    if (i < 0 || !st.can.has('bash')) return '';
    const runs = st.calls.slice(i + 1).filter((c) => c.name === 'bash');
    if (!runs.length) return 'You changed files but have not verified the result since. Run the project\'s tests, build or linter with bash (or another direct check), fix what fails, then report. If nothing can be run, say exactly why.';
    const last = runs[runs.length - 1];
    return failedRun(last) && !/\b(fail|still|could not|couldn't|unable|error)\b/i.test(st.text) ? 'Your last check failed (see its exit code). Fix the problem and run it again, or say plainly in your report that it still fails and why.' : '';
  },
  findings: (st) => {
    if (!(/no issues/i.test(st.text) || (/\b(critical|high|medium|low|nit)\b/i.test(st.text) && hasRef(st.text)))) return 'Your report must rank findings (Critical / High / Medium / Low / Nit) with `path:line` references, or say "No issues found". Rewrite it in that form.';
    const bad = badRefs(st);
    return bad.length ? `Some references in your report do not exist: ${bad.slice(0, 6).join('; ')}. Check them with read_file or grep and correct the report.` : '';
  },
  plan: (st) => ((st.text.match(/^\s*(?:\d+[.)]|[-*])\s+\S/gm) || []).length >= 3 && /risk/i.test(st.text) ? '' : 'Your plan must be a numbered list of concrete steps (naming the files each touches) followed by a Risks section. Rewrite it in that form.'),
  sources: (st) => {
    const fetched = st.calls.filter((c) => c.name === 'web_fetch').map((c) => String(c.input?.url || '').replace(/[#/]+$/, ''));
    const cited = [...new Set((st.text.match(/https?:\/\/[^\s)\]>"'`]+/g) || []).map((u) => u.replace(/[.,;:!?]+$/, '').replace(/[#/]+$/, '')))];
    if (fetched.length && !cited.length) return 'You fetched web pages but cited no URLs. Cite the source URL for each claim.';
    const unfetched = cited.filter((u) => !fetched.some((f) => f === u || f.startsWith(u) || u.startsWith(f)));
    if (cited.length && unfetched.length && fetched.length + (st.can.has('web_fetch') ? 1 : 0) > 0 && !st.calls.some((c) => c.name.startsWith('mcp__'))) return `You cite URLs you never fetched: ${unfetched.slice(0, 4).join(', ')}. Fetch them with web_fetch or remove the claims that rest on them.`;
    if (!fetched.length && !hasRef(st.text) && !cited.length) return 'Cite where each claim comes from (path:line or URL).';
    const bad = badRefs(st); if (bad.length) return `Some references in your report do not exist: ${bad.slice(0, 6).join('; ')}. Check them and correct the report.`;
    return /unverified|could not verify|couldn't verify|not verified/i.test(st.text) ? '' : 'Add an "Unverified" section: what you could not confirm (write "Nothing" if everything was confirmed).';
  },
  readback: (st) => {
    const i = lastIdx(st.calls, EDITS);
    return i < 0 || st.calls.slice(i + 1).some((c) => c.name === 'read_file') ? '' : 'Re-read the file you just wrote or edited with read_file and check it says what you intend before you report.';
  },
};
// Human-readable names for the editor.
const GATE_INFO = {
  evidence: 'Must look at files or sources before reporting',
  verify: 'After editing, must run a check (tests/build) and it must not be failing',
  findings: 'Report must rank findings with path:line references that exist',
  plan: 'Report must be a numbered plan with a Risks section',
  sources: 'Cited URLs must have been fetched, cited files must exist, and an Unverified section is required',
  readback: 'After editing, must re-read what it wrote',
};
// Guards run before an individual tool call and can refuse it. readBeforeEdit: an existing file is only changed after this run read it.
const GUARD_INFO = { readBeforeEdit: 'Existing files must be read before they are edited or overwritten' };
const GUARDS = {
  readBeforeEdit: (call, run, cwd) => {
    if (!EDITS.includes(call.name) || !call.input?.path || !run?.read) return '';
    const abs = path.resolve(cwd || require('os').homedir(), call.input.path);
    return fs.existsSync(abs) && !run.read.has(abs) ? `Read ${call.input.path} with read_file before changing it, so the edit is based on what is really there.` : '';
  },
};
const guardState = (def) => ({ guards: (def && def.guards) || [], read: new Set(), agentId: def && def.memory ? def.id : '' }); // agentId is only set when the agent keeps notes
function guard(run, call, cwd) { for (const g of (run && run.guards) || []) { const m = GUARDS[g] && GUARDS[g](call, run, cwd); if (m) return m; } return ''; }
// Remember what the agent has seen or written (called after a tool call succeeds).
function noteCall(run, call, cwd) {
  if (!run || !call.input?.path || !['read_file', ...EDITS].includes(call.name)) return;
  run.read.add(path.resolve(cwd || require('os').homedir(), call.input.path));
}
// What actually happened in a run, recorded by GrizzyCode from the tool calls themselves (not from the agent's own account of them).
function ledger(st) {
  const files = [...new Set(st.calls.filter((c) => EDITS.includes(c.name) && c.input?.path).map((c) => c.input.path))];
  const runs = st.calls.filter((c) => c.name === 'bash');
  if (!files.length && !runs.length && !st.errors) return '';
  const lines = [];
  if (files.length) lines.push(`Changed: ${files.slice(0, 12).join(', ')}${files.length > 12 ? ` (+${files.length - 12} more)` : ''}`);
  for (const c of runs.slice(-4)) lines.push(`Ran: \`${String(c.input?.command || '').replace(/\s+/g, ' ').slice(0, 80)}\` → ${failedRun(c) ? 'failed' : 'ok'}`);
  if (st.errors) lines.push(`Tool errors: ${st.errors}`);
  return '\n\n[Run record by GrizzyCode]\n' + lines.map((l) => '- ' + l).join('\n');
}
const MAX_NUDGES = 2, FIRST_RUN_ONLY = ['evidence', 'findings', 'plan', 'sources']; // a follow-up message is a conversation, not a fresh report
const gateState = (can, extra = {}) => ({ calls: [], text: '', can: can instanceof Set ? can : new Set(can), nudges: 0, errors: 0, ...extra });
function gate(def, st) {
  if (!def || st.nudges >= MAX_NUDGES) return '';
  for (const g of def.gates || []) { if (st.followUp && FIRST_RUN_ONLY.includes(g)) continue; const m = GATES[g] && GATES[g](st); if (m) { st.nudges++; return m; } }
  return '';
}

const file = () => path.join(store.root(), 'agents.json');
// Saved file: { overrides: { [builtinId]: fields }, custom: [agent], hidden: [builtinId] }
function load() { try { const j = JSON.parse(fs.readFileSync(file(), 'utf8')); return { overrides: j.overrides || {}, custom: Array.isArray(j.custom) ? j.custom : [] }; } catch { return { overrides: {}, custom: [] }; } }
const write = (d) => { fs.mkdirSync(store.root(), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(d, null, 2)); };

function list() {
  const d = load();
  return [...BUILTIN.map((b) => ({ ...b, ...(d.overrides[b.id] || {}), id: b.id, builtin: true, modified: !!d.overrides[b.id] })), ...d.custom.map((c) => ({ ...c, builtin: false }))]
    .map((a) => ({ ...a, enabled: a.enabled !== false }));
}
const get = (id) => (id ? list().find((a) => a.id === id) : null);

function clean(p) {
  return {
    name: String(p.name || '').trim().slice(0, 40),
    icon: String(p.icon || '').trim().slice(0, 4),
    description: String(p.description || '').trim().slice(0, 200),
    instructions: String(p.instructions || '').slice(0, 12000),
    model: String(p.model || '').trim().slice(0, 120),
    permissionMode: MODES.includes(p.permissionMode) ? p.permissionMode : '',
    ...access.clean(p), // connectors, tools, paths
    ...(['low', 'medium', 'high'].includes(p.effort) ? { effort: p.effort } : p.effort === '' ? { effort: '' } : {}),
    ...(typeof p.memory === 'boolean' ? { memory: p.memory } : {}),
    ...(Array.isArray(p.guards) ? { guards: p.guards.filter((g) => GUARDS[g]) } : {}),
    ...(p.steps ? { steps: Math.max(1, Math.min(100, Number(p.steps) || 25)) } : {}),
    ...(Array.isArray(p.gates) ? { gates: p.gates.filter((g) => GATES[g]) } : {}),
    ...(p.report != null ? { report: String(p.report).slice(0, 1000) } : {}),
    enabled: p.enabled !== false,
  };
}
// The access limits of an agent definition (or of nobody, which is unrestricted).
const accessOf = (a) => access.clean(a || {});
function save(p) {
  const f = clean(p); if (!f.name) return { error: 'Give the agent a name.' };
  const d = load(), builtin = BUILTIN.find((b) => b.id === p.id);
  if (builtin) d.overrides[builtin.id] = f;
  else {
    const rec = { ...f, id: p.id || crypto.randomUUID(), updatedAt: Date.now() }; const i = d.custom.findIndex((x) => x.id === rec.id);
    if (i >= 0) d.custom[i] = rec; else d.custom.push(rec);
  }
  write(d); return { ok: true, agents: list() };
}
// Custom agents are deleted; built-in ones go back to their defaults.
function remove(id) {
  const d = load(); delete d.overrides[id]; d.custom = d.custom.filter((x) => x.id !== id); write(d);
  if (store.getSettings().activeAgent === id) store.saveSettings({ activeAgent: '' });
  return list();
}
// ---- Memory: notes an agent keeps across conversations, scoped to the folder it was working in (so one project's habits never leak into another) ----
const memFile = (id) => path.join(store.root(), 'agent-memory', path.basename(String(id)) + '.json');
const MAX_NOTES = 40;
function memLoad(id) { try { const j = JSON.parse(fs.readFileSync(memFile(id), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } }
function memWrite(id, d) { fs.mkdirSync(path.dirname(memFile(id)), { recursive: true }); fs.writeFileSync(memFile(id), JSON.stringify(d, null, 2)); }
const scopeOf = (cwd) => String(cwd || '');
const notes = (id, cwd) => memLoad(id)[scopeOf(cwd)] || [];
function addNote(id, cwd, text) {
  text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 400); if (!text) return { error: 'Nothing to save.' };
  const d = memLoad(id), k = scopeOf(cwd), list = d[k] || [];
  if (list.some((n) => n.text.toLowerCase() === text.toLowerCase())) return { ok: true, duplicate: true, notes: list };
  d[k] = [...list, { id: crypto.randomUUID().slice(0, 8), text, at: Date.now() }].slice(-MAX_NOTES); memWrite(id, d); return { ok: true, notes: d[k] };
}
function forgetNote(id, cwd, ref) { // by note id or by exact text
  const d = memLoad(id), k = scopeOf(cwd), list = d[k] || [], keep = list.filter((n) => n.id !== ref && n.text !== ref);
  if (keep.length === list.length) return { error: 'No such note.' };
  if (keep.length) d[k] = keep; else delete d[k]; memWrite(id, d); return { ok: true, notes: keep };
}
// Every scope, for the settings screen: [{ scope, notes }]
const allNotes = (id) => Object.entries(memLoad(id)).map(([scope, list]) => ({ scope, notes: list }));
function clearNotes(id, scope) { const d = memLoad(id); if (scope == null) { try { fs.unlinkSync(memFile(id)); } catch {} } else { delete d[scope]; memWrite(id, d); } return allNotes(id); }
const memoryBlock = (a, cwd) => {
  if (!a || !a.memory) return '';
  const list = notes(a.id, cwd);
  return `\n\nYou keep notes across conversations (agent_note save / forget). Save only durable, reusable facts about this ${cwd ? 'project' : 'user'} that you had to discover (conventions, commands that work, pitfalls); never secrets or one-off details. Notes can be out of date, so check them against the code before relying on them.${list.length ? '\nYour notes for this ' + (cwd ? 'project' : 'user') + ':\n' + list.map((n) => `- [${n.id}] ${n.text}`).join('\n') : '\n(No notes yet.)'}`;
};
function promptBlock(id, cwd) { const a = get(id); return a && a.enabled ? blockFor(a, cwd) : ''; }
// The persona text for a given agent definition (also used for delegated agents, whose saved copy may outlive the agent).
function blockFor(a, cwd) {
  if (!a) return '';
  if (!String(a.instructions || '').trim()) return memoryBlock(a, cwd);
  const rep = String(a.report || '').trim();
  return `\n\nYou are working as the agent “${a.name}”. Follow these agent instructions:\n${a.instructions.trim()}${rep ? `\n\nReport format: ${rep}` : ''}${(a.guards || []).map((g) => GUARD_INFO[g]).filter(Boolean).length ? '\n\nRules enforced on your tool calls: ' + a.guards.map((g) => GUARD_INFO[g]).filter(Boolean).join('; ') + '. A call that breaks one is refused.' : ''}${memoryBlock(a, cwd)}${(a.gates || []).length ? '\n\nYou cannot finish until your report meets this format and your work is verified; GrizzyCode checks the report against what you actually did (cited files and lines must exist, checks must have run) and sends an incomplete one back to you.' : ''}`;
}
module.exports = { list, get, save, remove, promptBlock, blockFor, accessOf, BUILTIN, gate, gateState, GATES, GATE_INFO, GUARD_INFO, guardState, guard, noteCall, ledger, badRefs, notes, addNote, forgetNote, allNotes, clearNotes };
