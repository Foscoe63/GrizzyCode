// Agents: named personas (instructions + optional model and permission mode) the user can pick per conversation.
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
  { id: 'engineer', icon: '🛠️', name: 'Engineer', description: 'Writes and refactors code in small, verified steps; will not finish an edit without running something to check it.', instructions: 'Act as a senior software engineer. Read the surrounding code before changing it, match its conventions, make the smallest correct change, and verify it (run tests or the build) before reporting done.', model: '', permissionMode: '', steps: 40, gates: ['evidence', 'verify'], report: 'Finish with: the files you changed and why, the command you ran to verify and its result, and anything left undone.' },
  { id: 'reviewer', icon: '🔍', name: 'Reviewer', description: 'Reviews code for bugs, security and clarity without changing it; must read the code and rank findings.', instructions: 'Act as a meticulous code reviewer. Look for correctness bugs, security issues, missing edge cases and unclear code. Report findings ranked by severity with file and line references. Do not modify files unless asked.', model: '', permissionMode: 'plan', tools: ['read_file', 'list_dir', 'grep'], steps: 20, gates: ['evidence', 'findings'], report: 'Finish with findings ranked Critical / High / Medium / Low / Nit, each as `path:line — problem — suggested fix`. If you found nothing, say "No issues found" and list what you checked.' },
  { id: 'planner', icon: '🗺️', name: 'Planner', description: 'Investigates the code first, then proposes a concrete numbered plan with files and risks.', instructions: 'Act as a technical planner. Investigate the codebase, ask about anything ambiguous, and produce a concrete step-by-step plan with the files involved and risks. Do not implement until the plan is approved.', model: '', permissionMode: 'plan', tools: ['read_file', 'list_dir', 'grep'], steps: 20, gates: ['evidence', 'plan'], report: 'Finish with a numbered plan (each step names the files it touches), then a "Risks" section and an "Open questions" section.' },
  { id: 'researcher', icon: '📚', name: 'Researcher', description: 'Gathers evidence from files and the web (read-only), then reports findings with sources and what it could not verify.', instructions: 'Act as a careful researcher. Gather evidence before concluding, distinguish facts from inference, cite where each claim comes from, and say what you could not verify.', model: '', permissionMode: '', tools: ['read_file', 'list_dir', 'grep', 'web_fetch'], steps: 30, gates: ['evidence', 'sources'], report: 'Finish with: the answer first, then the evidence (each claim with its source URL or path:line), then an "Unverified" section for anything you could not confirm.' },
  { id: 'writer', icon: '✍️', name: 'Writer', description: 'Drafts and edits prose in files (no shell or web); re-reads what it wrote before reporting.', instructions: 'Act as an editor and writer. Prefer plain, concise language, keep the author\'s voice, and explain notable edits briefly.', model: '', permissionMode: '', tools: ['read_file', 'list_dir', 'grep', 'write_file', 'edit_file'], steps: 15, gates: ['readback'], report: 'Finish with the file(s) you wrote or edited and a short note on the notable edits.' },
];


// ---- Completion gates: a delegated (or persona'd) run may not finish until these pass ----
// `st` = { calls: [{ name, input }] (successful calls, in order), text: the final reply, can: Set of tool names on offer, nudges }.
// Each gate returns '' when satisfied, else the message sent back to the agent instead of letting it finish.
const EDITS = ['write_file', 'edit_file'], LOOKS = ['read_file', 'list_dir', 'grep', 'web_fetch'];
const lastIdx = (calls, names) => { for (let i = calls.length - 1; i >= 0; i--) if (names.includes(calls[i].name)) return i; return -1; };
const looked = (st) => st.calls.some((c) => LOOKS.includes(c.name) || c.name.startsWith('mcp__'));
const GATES = {
  evidence: (st) => (looked(st) ? '' : 'You have not looked at anything yet. Use your tools to read the relevant files or sources before you report.'),
  verify: (st) => {
    const i = lastIdx(st.calls, EDITS);
    if (i < 0 || !st.can.has('bash') || st.calls.slice(i + 1).some((c) => c.name === 'bash')) return '';
    return 'You changed files but have not verified the result since. Run the project\'s tests, build or linter with bash (or another direct check), fix what fails, then report. If nothing can be run, say exactly why.';
  },
  findings: (st) => (/no issues/i.test(st.text) || (/\b(critical|high|medium|low|nit)\b/i.test(st.text) && /[\w./-]+:\d+/.test(st.text)) ? '' : 'Your report must rank findings (Critical / High / Medium / Low / Nit) with `path:line` references, or say "No issues found". Rewrite it in that form.'),
  plan: (st) => ((st.text.match(/^\s*(?:\d+[.)]|[-*])\s+\S/gm) || []).length >= 3 && /risk/i.test(st.text) ? '' : 'Your plan must be a numbered list of concrete steps (naming the files each touches) followed by a Risks section. Rewrite it in that form.'),
  sources: (st) => {
    const web = st.calls.some((c) => c.name === 'web_fetch');
    if (web && !/https?:\/\//.test(st.text)) return 'You fetched web pages but cited no URLs. Cite the source URL for each claim.';
    if (!web && !/[\w./-]+:\d+|https?:\/\//.test(st.text)) return 'Cite where each claim comes from (path:line or URL).';
    return /unverified|could not verify|couldn't verify|not verified/i.test(st.text) ? '' : 'Add an "Unverified" section: what you could not confirm (write "Nothing" if everything was confirmed).';
  },
  readback: (st) => {
    const i = lastIdx(st.calls, EDITS);
    return i < 0 || st.calls.slice(i + 1).some((c) => c.name === 'read_file') ? '' : 'Re-read the file you just wrote or edited with read_file and check it says what you intend before you report.';
  },
};
const MAX_NUDGES = 2, FIRST_RUN_ONLY = ['evidence', 'findings', 'plan', 'sources']; // a follow-up message is a conversation, not a fresh report
const gateState = (can) => ({ calls: [], text: '', can: can instanceof Set ? can : new Set(can), nudges: 0 });
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
function promptBlock(id) { const a = get(id); return a && a.enabled ? blockFor(a) : ''; }
// The persona text for a given agent definition (also used for delegated agents, whose saved copy may outlive the agent).
function blockFor(a) {
  if (!a || !String(a.instructions || '').trim()) return '';
  const rep = String(a.report || '').trim();
  return `\n\nYou are working as the agent “${a.name}”. Follow these agent instructions:\n${a.instructions.trim()}${rep ? `\n\nReport format: ${rep}` : ''}${(a.gates || []).length ? '\n\nYou cannot finish until your report meets this format and your work is verified; an incomplete report is sent back to you.' : ''}`;
}
module.exports = { list, get, save, remove, promptBlock, blockFor, accessOf, BUILTIN, gate, gateState, GATES };
