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

function list() {
  fs.mkdirSync(dir(), { recursive: true });
  const out = [];
  for (const d of fs.readdirSync(dir())) {
    const f = path.join(dir(), d, 'SKILL.md');
    if (!fs.existsSync(f)) continue;
    try { const { meta } = parse(f); out.push({ id: d, name: meta.name || d, description: meta.description || '', path: f }); } catch {}
  }
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

function read(id) { return parse(path.join(dir(), path.basename(id), 'SKILL.md')).body; }

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

module.exports = { seedBundled, list, read, importBundle, remove, dir };
