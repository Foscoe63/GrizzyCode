// Plugins: a folder or archive bundling skills (skills/*/SKILL.md), connectors (.mcp.json) and slash commands (commands/*.md).
const fs = require('fs');
const path = require('path');
const store = require('./store');
const skills = require('./skills');
const mcp = require('./mcp');
const arc = require('./archive');

const regFile = () => path.join(store.root(), 'plugins.json');
const dir = () => path.join(store.root(), 'plugins');
const list = () => { try { const l = JSON.parse(fs.readFileSync(regFile(), 'utf8')); return Array.isArray(l) ? l : []; } catch { return []; } };
const writeReg = (l) => { fs.mkdirSync(store.root(), { recursive: true }); fs.writeFileSync(regFile(), JSON.stringify(l, null, 2)); return l; };
const slug = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const MARK = ['.claude-plugin/plugin.json', 'plugin.json', 'skills', '.mcp.json', 'commands'];

function frontmatter(t) {
  const m = t.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/); const meta = {}; let body = t;
  if (m) { body = m[2]; for (const l of m[1].split('\n')) { const k = l.match(/^(\w[\w-]*):\s*(.*)$/); if (k) meta[k[1]] = k[2].replace(/^["']|["']$/g, ''); } }
  return { meta, body: body.trim() };
}
// Read a plugin folder (no side effects) into { name, version, description, skills, servers, commands }.
function read(rootDir, fallbackName) {
  let manifest = {};
  for (const f of ['.claude-plugin/plugin.json', 'plugin.json']) { try { manifest = JSON.parse(fs.readFileSync(path.join(rootDir, f), 'utf8')); break; } catch {} }
  const name = slug(manifest.name || fallbackName || path.basename(rootDir)) || 'plugin';
  const sk = []; const sd = path.join(rootDir, 'skills');
  if (fs.existsSync(sd)) for (const d of fs.readdirSync(sd, { withFileTypes: true })) if (d.isDirectory() && fs.existsSync(path.join(sd, d.name, 'SKILL.md'))) sk.push(d.name);
  let servers = {}; try { const j = JSON.parse(fs.readFileSync(path.join(rootDir, '.mcp.json'), 'utf8')); servers = j.mcpServers || j; } catch {}
  const cmds = []; const cd = path.join(rootDir, 'commands');
  if (fs.existsSync(cd)) for (const f of fs.readdirSync(cd)) if (f.endsWith('.md')) { const { meta, body } = frontmatter(fs.readFileSync(path.join(cd, f), 'utf8')); cmds.push({ name: slug(f.slice(0, -3)), description: meta.description || '', prompt: body.slice(0, 20000) }); }
  return { name, version: String(manifest.version || ''), description: String(manifest.description || ''), skills: sk, servers, commands: cmds };
}
function open(src) {
  const st = fs.statSync(src); let tmp = null, rootDir = src;
  if (!st.isDirectory()) { tmp = arc.extractToTemp(src, { prefix: 'gc-plugin-' }); rootDir = arc.root(tmp, MARK); }
  const info = read(rootDir, path.basename(src).replace(/\.[^.]+$/, ''));
  return { info, rootDir, tmp };
}
const summary = (i) => ({ name: i.name, version: i.version, description: i.description, skills: i.skills, servers: Object.entries(i.servers).map(([n, d]) => ({ name: `${i.name}-${slug(n)}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40), run: d.url || [d.command, ...(d.args || [])].join(' ') })), commands: i.commands.map((c) => `/${i.name}:${c.name}`) });

// What installing would do, for the confirmation dialog. Nothing is written.
function inspect(src) {
  let o; try { o = open(src); } catch (e) { return { error: e.message }; }
  try { const i = o.info; if (!i.skills.length && !Object.keys(i.servers).length && !i.commands.length) return { error: 'This folder has no skills, connectors or commands to install.' }; return { ok: true, ...summary(i) }; }
  finally { if (o.tmp) fs.rmSync(o.tmp, { recursive: true, force: true }); }
}
async function install(src) {
  let o; try { o = open(src); } catch (e) { return { error: e.message }; }
  try {
    const i = o.info; if (!i.skills.length && !Object.keys(i.servers).length && !i.commands.length) return { error: 'This folder has no skills, connectors or commands to install.' };
    if (list().some((p) => p.name === i.name)) await remove(i.name); // reinstall replaces
    const dest = path.join(dir(), i.name); fs.rmSync(dest, { recursive: true, force: true }); arc.copyTree(o.rootDir, dest);
    const skillIds = [];
    for (const d of i.skills) { const id = `${i.name}-${slug(d)}`; fs.rmSync(path.join(skills.dir(), id), { recursive: true, force: true }); arc.copyTree(path.join(o.rootDir, 'skills', d), path.join(skills.dir(), id)); skillIds.push(id); }
    const serverNames = []; const errors = [];
    for (const [n, d] of Object.entries(i.servers)) {
      const name = `${i.name}-${slug(n)}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40);
      const r = await mcp.saveServer({ name, def: d, oldName: mcp.readConfig().mcpServers?.[name] ? name : undefined });
      if (r.error) errors.push(`${n}: ${r.error}`); else serverNames.push(name);
    }
    const rec = { name: i.name, version: i.version, description: i.description, skills: skillIds, servers: serverNames, commands: i.commands, installedAt: Date.now() };
    writeReg([...list().filter((p) => p.name !== i.name), rec]);
    return { ok: true, plugin: rec, errors, plugins: list() };
  } finally { if (o.tmp) fs.rmSync(o.tmp, { recursive: true, force: true }); }
}
async function remove(name) {
  const p = list().find((x) => x.name === name); if (!p) return list();
  for (const id of p.skills) skills.remove(id);
  for (const n of p.servers) await mcp.removeServer(n);
  fs.rmSync(path.join(dir(), path.basename(name)), { recursive: true, force: true });
  return writeReg(list().filter((x) => x.name !== name));
}
const commands = () => list().flatMap((p) => p.commands.map((c) => ({ name: `/${p.name}:${c.name}`, description: c.description || `From ${p.name}`, prompt: c.prompt })));
module.exports = { list, inspect, install, remove, commands, dir };
