// Skills: folders containing SKILL.md with `name:` / `description:` frontmatter.
// `.skill` bundles are zip archives of such a folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const store = require('./store');

const dir = () => path.join(store.root(), 'skills');

function parse(file) {
  const t = fs.readFileSync(file, 'utf8');
  const m = t.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta = {}; let body = t;
  if (m) { body = m[2]; for (const l of m[1].split('\n')) { const k = l.match(/^(\w[\w-]*):\s*(.*)$/); if (k) meta[k[1]] = k[2].replace(/^["']|["']$/g, ''); } }
  return { meta, body };
}

// Skills that live in a project: <cwd>/.grizzycode/skills and the shared agentskills.io folder <cwd>/.agents/skills.
// They come from the repository, so they are text from a third party: loaded only when the model asks for them by id, and a project
// skill cannot shadow an installed one (the installed skill wins on an id clash, so a cloned repo cannot swap out your own skill).
const projectDirs = (cwd) => (cwd ? [path.join(cwd, '.grizzycode', 'skills'), path.join(cwd, '.agents', 'skills')] : []);
const SAFE_ID = /^[\w][\w.-]{0,63}$/;
function scan(root, extra) {
  const out = [];
  let names; try { names = fs.readdirSync(root); } catch { return out; }
  for (const d of names) {
    const f = path.join(root, d, 'SKILL.md');
    if (!SAFE_ID.test(d) || !fs.existsSync(f)) continue;
    try { const { meta } = parse(f); out.push({ id: d, name: meta.name || d, description: meta.description || '', path: f, ...extra }); } catch {}
  }
  return out;
}
function list(cwd) {
  fs.mkdirSync(dir(), { recursive: true });
  const out = scan(dir(), {});
  const have = new Set(out.map((k) => k.id));
  for (const root of projectDirs(cwd)) for (const k of scan(root, { project: true })) if (!have.has(k.id)) { have.add(k.id); out.push(k); }
  return out;
}

// fs.cpSync cannot read directories inside app.asar, so copy file by file.
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyTree(a, b); else fs.copyFileSync(a, b);
  }
}

// Seed the skills shipped with the app into the user's skills folder once; a skill the user later removes is not restored.
function seedBundled() {
  const src = path.join(__dirname, '..', '..', 'skills');
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dir(), { recursive: true });
  const marker = path.join(dir(), '.seeded.json');
  let seeded = []; try { seeded = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch {}
  for (const d of fs.readdirSync(src)) {
    if (seeded.includes(d) || !fs.existsSync(path.join(src, d, 'SKILL.md'))) continue;
    if (!fs.existsSync(path.join(dir(), d))) copyTree(path.join(src, d), path.join(dir(), d));
    seeded.push(d);
  }
  fs.writeFileSync(marker, JSON.stringify(seeded));
}

function read(id, cwd) {
  const base = path.basename(String(id));
  const installed = path.join(dir(), base, 'SKILL.md');
  if (fs.existsSync(installed)) return parse(installed).body;
  if (SAFE_ID.test(base)) for (const root of projectDirs(cwd)) { const f = path.join(root, base, 'SKILL.md'); if (fs.existsSync(f)) return parse(f).body; }
  return parse(installed).body; // same error as before for an unknown id
}

function importBundle(file) {
  fs.mkdirSync(dir(), { recursive: true });
  const st = fs.statSync(file);
  if (st.size > 30 * 1024 * 1024) throw new Error('Skill file is too large (30 MB max).');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-skill-'));
  try {
    if (st.isDirectory()) fs.cpSync(file, tmp, { recursive: true });
    else execFileSync('unzip', ['-q', '-o', file, '-d', tmp]);
    let root = tmp;
    if (!fs.existsSync(path.join(root, 'SKILL.md'))) {
      const sub = fs.readdirSync(tmp).find((x) => fs.existsSync(path.join(tmp, x, 'SKILL.md')));
      if (!sub) throw new Error('No SKILL.md found in bundle.');
      root = path.join(tmp, sub);
    }
    const { meta } = parse(path.join(root, 'SKILL.md'));
    const id = (meta.name || path.basename(root)).replace(/[^\w.-]/g, '-');
    fs.rmSync(path.join(dir(), id), { recursive: true, force: true });
    fs.cpSync(root, path.join(dir(), id), { recursive: true });
    return id;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

function remove(id) { fs.rmSync(path.join(dir(), path.basename(id)), { recursive: true, force: true }); }

// ---- Skill groups: a user-editable set of categories. Unassigned skills are placed by keyword; dragging a skill pins it to a group.
const gfile = () => path.join(store.root(), 'skill-groups.json');
const DEFAULT_GROUPS = [
  { id: 'testing', name: 'Testing & debugging', re: /\b(test|tdd|debug|verif|lint|qa)/i },
  { id: 'ui', name: 'UI & design', re: /\b(design|ui|ux|layout|icon|frontend|css|brand)/i },
  { id: 'swift', name: 'Swift & Apple', re: /\b(swift|swiftui|xcode|ios|macos|mac-app|appkit)/i },
  { id: 'planning', name: 'Planning & workflow', re: /\b(plan|brainstorm|workflow|flow|ship|start|build|research|improve|architecture|performance)/i },
  { id: 'git', name: 'Git & review', re: /\b(git|commit|review|pr|issue|merge|branch|repo)/i },
  { id: 'docs', name: 'Documents', re: /\b(docx|pdf|pptx|xlsx|readme|document|diagram|gif)/i },
  { id: 'other', name: 'Other', re: /./ },
];
function readGroups() { try { return JSON.parse(fs.readFileSync(gfile(), 'utf8')); } catch { return {}; } }
function groupState() {
  const st = readGroups();
  const custom = (st.custom || []).filter((g) => g && g.id && g.name);
  const groups = [...DEFAULT_GROUPS.filter((g) => g.id !== 'other').map(({ id, name }) => ({ id, name })), ...custom.map((g) => ({ ...g, custom: true })), { id: 'other', name: 'Other' }];
  const ids = new Set(groups.map((g) => g.id)), assign = st.assign || {};
  const items = list().map((k) => {
    let g = ids.has(assign[k.id]) ? assign[k.id] : null;
    if (!g) { const hay = `${k.id} ${k.name} ${k.description}`; g = DEFAULT_GROUPS.find((d) => d.id !== 'other' && d.re.test(k.id + ' ' + k.name)) ?.id || DEFAULT_GROUPS.find((d) => d.id !== 'other' && d.re.test(hay))?.id || 'other'; }
    return { ...k, group: g, pinned: !!assign[k.id] };
  });
  return { groups, skills: items, collapsed: st.collapsed || {} };
}
// patch: { assign: {skillId: groupId}, collapsed: {groupId: bool}, addGroup: name, removeGroup: id }
function updateGroups(patch = {}) {
  const st = readGroups(); st.assign = st.assign || {}; st.collapsed = st.collapsed || {}; st.custom = st.custom || [];
  if (patch.assign) for (const [k, g] of Object.entries(patch.assign)) st.assign[path.basename(k)] = String(g);
  if (patch.collapsed) Object.assign(st.collapsed, patch.collapsed);
  if (patch.addGroup) { const name = String(patch.addGroup).trim().slice(0, 40); if (name) st.custom.push({ id: 'g' + Date.now().toString(36), name }); }
  if (patch.removeGroup) { st.custom = st.custom.filter((g) => g.id !== patch.removeGroup); for (const k of Object.keys(st.assign)) if (st.assign[k] === patch.removeGroup) delete st.assign[k]; }
  fs.writeFileSync(gfile(), JSON.stringify(st, null, 2));
  return groupState();
}

module.exports = { groupState, updateGroups, seedBundled, list, read, importBundle, remove, dir };
