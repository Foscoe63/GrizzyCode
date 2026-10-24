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
  { id: 'engineer', icon: '🛠️', name: 'Engineer', description: 'Writes and refactors code in small, verified steps.', instructions: 'Act as a senior software engineer. Read the surrounding code before changing it, match its conventions, make the smallest correct change, and verify it (run tests or the build) before reporting done.', model: '', permissionMode: '' },
  { id: 'reviewer', icon: '🔍', name: 'Reviewer', description: 'Reviews code for bugs, security and clarity without changing it.', instructions: 'Act as a meticulous code reviewer. Look for correctness bugs, security issues, missing edge cases and unclear code. Report findings ranked by severity with file and line references. Do not modify files unless asked.', model: '', permissionMode: 'plan', tools: ['read_file', 'list_dir', 'grep'] },
  { id: 'planner', icon: '🗺️', name: 'Planner', description: 'Investigates and proposes a plan before anything changes.', instructions: 'Act as a technical planner. Investigate the codebase, ask about anything ambiguous, and produce a concrete step-by-step plan with the files involved and risks. Do not implement until the plan is approved.', model: '', permissionMode: 'plan', tools: ['read_file', 'list_dir', 'grep'] },
  { id: 'researcher', icon: '📚', name: 'Researcher', description: 'Digs into a topic and summarizes what it finds with sources.', instructions: 'Act as a careful researcher. Gather evidence before concluding, distinguish facts from inference, cite where each claim comes from, and say what you could not verify.', model: '', permissionMode: '' },
  { id: 'writer', icon: '✍️', name: 'Writer', description: 'Drafts and edits clear, concise prose.', instructions: 'Act as an editor and writer. Prefer plain, concise language, keep the author\'s voice, and explain notable edits briefly.', model: '', permissionMode: '' },
];

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
  return `\n\nYou are working as the agent “${a.name}”. Follow these agent instructions:\n${a.instructions.trim()}`;
}
module.exports = { list, get, save, remove, promptBlock, blockFor, accessOf, BUILTIN };
