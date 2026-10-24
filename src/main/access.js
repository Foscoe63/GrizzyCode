// Per-agent access: which built-in tools, connectors and folders an agent may use.
// connectors / tools: null = no restriction, [] = none. paths: [] = no restriction.
// Several access lists can apply at once (a delegated agent gets its parent's and its own); a call must pass every one.
const fs = require('fs');
const os = require('os');
const path = require('path');

const BUILTIN = ['read_file', 'list_dir', 'grep', 'write_file', 'edit_file', 'bash', 'web_fetch'];
const PATH_TOOLS = ['read_file', 'list_dir', 'grep', 'write_file', 'edit_file'];
const connectorOf = (name) => (/^mcp__(.+?)__/.exec(name) || [])[1] || '';

const strList = (v, max, len) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim().slice(0, len)).filter(Boolean))].slice(0, max) : null);
function clean(p = {}) {
  const tools = strList(p.tools, BUILTIN.length, 40);
  return { connectors: strList(p.connectors, 100, 80), tools: tools && tools.filter((t) => BUILTIN.includes(t)), paths: strList(p.paths, 50, 500) || [] };
}
const isOpen = (a) => !a || (a.connectors == null && a.tools == null && !(a.paths || []).length);

const home = (p) => (p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
// Resolve symlinks of the nearest existing ancestor, so a link inside an allowed folder cannot lead out of it.
function real(p) {
  const rest = [];
  for (let cur = p; ; cur = path.dirname(cur)) {
    try { return path.join(fs.realpathSync(cur), ...rest.reverse()); } catch { if (path.dirname(cur) === cur) return p; rest.push(path.basename(cur)); }
  }
}
const within = (root, target) => target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

// Does this one access list allow the tool by name? (Internal tools such as exit_plan_mode or use_skill are never restricted.)
function allowsName(a, name) {
  if (isOpen(a)) return true;
  if (name.startsWith('mcp__')) return a.connectors == null || a.connectors.includes(connectorOf(name));
  if (!BUILTIN.includes(name)) return true;
  if (a.tools != null && !a.tools.includes(name)) return false;
  return !(name === 'bash' && a.paths.length); // a shell can reach any folder, so a folder scope switches it off
}
const keep = (lists, defs) => defs.filter((d) => lists.every((a) => allowsName(a, d.name)));

// null when the call may go ahead, else the reason it may not (shown to the model as the tool error).
function check(lists, name, input, cwd) {
  for (const a of lists) {
    if (isOpen(a)) continue;
    if (!allowsName(a, name)) return name === 'bash' && a.paths.length && (a.tools == null || a.tools.includes('bash')) ? 'This agent is limited to certain folders, so it cannot run shell commands.' : `This agent is not allowed to use ${name}.`;
    if (a.paths.length && PATH_TOOLS.includes(name)) {
      const base = cwd || os.homedir(), target = real(path.resolve(base, home(String((input && input.path) || '.'))));
      if (!a.paths.some((r) => within(real(path.resolve(base, home(r))), target))) return `This agent may only use files inside: ${a.paths.join(', ')}.`;
    }
  }
  return null;
}

// A line for the system prompt so the agent plans around its limits instead of bumping into them.
function promptBlock(lists) {
  const bits = [];
  for (const a of lists) {
    if (isOpen(a)) continue;
    if (a.paths.length) bits.push(`file tools only work inside: ${a.paths.join(', ')} (no shell)`);
    if (a.tools != null) bits.push(`built-in tools allowed: ${a.tools.join(', ') || 'none'}`);
    if (a.connectors != null) bits.push(`connectors allowed: ${a.connectors.join(', ') || 'none'}`);
  }
  return bits.length ? `\n\nAccess limits for this agent: ${[...new Set(bits)].join('; ')}. Calls outside them fail.` : '';
}

// Claude Code CLI tool names (for Grizzy) matching each built-in tool.
const CLI = { read_file: ['Read'], list_dir: ['LS', 'Glob'], grep: ['Grep'], write_file: ['Write', 'NotebookEdit'], edit_file: ['Edit', 'MultiEdit'], bash: ['Bash'], web_fetch: ['WebFetch', 'WebSearch'] };
const cliDenied = (lists) => [...new Set(BUILTIN.filter((n) => !lists.every((a) => allowsName(a, n))).flatMap((n) => CLI[n]))];

// Map an ACP permission request onto our tool names and check it.
const ACP_KIND = { read: 'read_file', search: 'grep', edit: 'write_file', delete: 'write_file', move: 'write_file', execute: 'bash', fetch: 'web_fetch' };
function checkAcp(lists, tc = {}, cwd) {
  const title = String(tc.title || ''), name = title.startsWith('mcp__') ? title.split(/\s/)[0] : ACP_KIND[tc.kind];
  if (!name) return null;
  const raw = tc.rawInput || {}, input = { path: (tc.locations && tc.locations[0] && tc.locations[0].path) || raw.file_path || raw.path || raw.notebook_path || '.' };
  return check(lists, name, input, cwd);
}

module.exports = { BUILTIN, clean, isOpen, keep, check, promptBlock, cliDenied, checkAcp, connectorOf };
