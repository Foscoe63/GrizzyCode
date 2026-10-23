// Making, installing, exporting, publishing and removing mods. Everything GrizzyCode creates or installs lives in its own
// mods folder (~/.GrizzyCode/mods); nothing here ever writes to Claude Code's plugin folders or to a marketplace unless the
// person picks that marketplace folder for a publish.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const arc = require('../archive');

const NATIVE_DIR = path.join(os.homedir(), '.GrizzyCode', 'mods');
// Mod names become folder names and part of tool names (mcp__<mod>__<tool>), so keep them plain.
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const validName = (n) => typeof n === 'string' && n.length >= 2 && n.length <= 40 && NAME_RE.test(n);
const SAFE_DIR = /^[A-Za-z0-9][\w.-]{0,63}$/;
const SKIP = new Set(['.DS_Store', 'node_modules', '.git']);

const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');

function template(name, description) {
  return `import type { Register } from 'claude-code'

// ${name}: ${description}
// A mod is a function that hooks into events: on('<event>', [matcher], async ($, event, next) => result).
// \`$\` is the app: $.ui (toast, status, ask, open), $.session, $.model, $.fs, $.process, $.store, $.clock, $.command, $.tool.
// \`await next(event)\` lets the rest of the chain run; return a value to answer instead.

export const register: Register = (on) => {
  // Make /${name} show up in the slash menu.
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: '${name}', description: ${JSON.stringify(description)} })
    return next(e)
  })

  // Run it.
  on('command.run', { command: '${name}' }, async ($, e) => {
    const turns = await $.session.turns()
    $.ui.toast('${name} ran')
    return { text: \`${name} is working. This chat has \${turns} turn(s). You typed: \${e.args || '(nothing)'}\` }
  })
}
`;
}

// Scaffolds a new mod in the GrizzyCode mods folder. `taken` = names already in use (any source), so a new mod can never
// shadow or overwrite one that came from Claude Code or a marketplace.
function create({ name, description }, { taken = [], dir = NATIVE_DIR } = {}) {
  name = String(name || '').trim();
  if (!name) return { error: 'Give the mod a name.' };
  if (!validName(name)) return { error: 'Use lowercase letters, digits and single dashes, 2–40 characters (for example “my-mod”).' };
  if (taken.includes(name)) return { error: `A mod called “${name}” already exists. Pick another name.` };
  const root = path.join(dir, name);
  if (fs.existsSync(root)) return { error: `The folder ${root} already exists.` };
  description = String(description || '').trim().replace(/\s+/g, ' ').slice(0, 300) || `The ${name} mod`;
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true }); fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '0.1.0', description, author: { name: os.userInfo().username } }, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.tsx'] }, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'hooks', 'register.tsx'), template(name, description));
  fs.writeFileSync(path.join(root, 'README.md'), `# ${name}\n\n${description}\n\nEdit \`hooks/register.tsx\`, then choose Reload on the mod in GrizzyCode → Settings → Mods.\n`);
  return { ok: true, name, root };
}

// Copy a mod folder into dest, skipping junk and links.
function copyMod(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.isSymbolicLink()) continue;
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyMod(a, b); else fs.copyFileSync(a, b);
  }
}

const inside = (child, parent) => { const r = path.relative(path.resolve(parent), path.resolve(child)); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };

// Install a mod from a folder or .zip/.plugin. `inspect(root)` validates a folder (host.inspectRoot). Returns { ok, name, dest, replaced }.
function install(src, inspect, { dir = NATIVE_DIR } = {}) {
  let tmp = null, root = src;
  try {
    if (!fs.statSync(src).isDirectory()) { tmp = arc.extractToTemp(src, { prefix: 'gc-mod-' }); root = arc.root(tmp, ['.claude-plugin/plugin.json']); }
    const m = inspect(root);
    if (!m) return { error: 'That isn’t a mod: it needs .claude-plugin/plugin.json and hooks/hooks.json with a module.' };
    const folder = m.name.replace(/[^\w.-]/g, '-');
    if (!SAFE_DIR.test(folder) || /^\.+$/.test(folder)) return { error: `“${m.name}” can’t be used as a mod name.` };
    const dest = path.join(dir, folder);
    if (path.dirname(dest) !== path.resolve(dir)) return { error: `“${m.name}” can’t be used as a mod name.` };
    if (path.resolve(root) === dest) return { ok: true, name: m.name, dest, replaced: false, unchanged: true }; // already installed there
    if (inside(dir, root)) return { error: 'Pick the mod’s own folder, not a folder that contains your mods.' };
    const replaced = fs.existsSync(dest);
    const stage = dest + '.new-' + process.pid; fs.rmSync(stage, { recursive: true, force: true });
    try { copyMod(root, stage); fs.rmSync(dest, { recursive: true, force: true }); fs.renameSync(stage, dest); }
    finally { fs.rmSync(stage, { recursive: true, force: true }); }
    return { ok: true, name: m.name, dest, replaced };
  } catch (e) { return { error: e.message }; }
  finally { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); }
}

// Zip a mod (any source) so it can be shared: GrizzyCode's “Install from folder or .zip” and Claude Code's plugin
// loader both accept the layout. The mod's files sit at the top level of the zip.
function exportZip(m, destFile) {
  if (!destFile) return { error: 'No file chosen.' };
  fs.rmSync(destFile, { force: true });
  try { execFileSync('zip', ['-q', '-r', '-X', path.resolve(destFile), '.', '-x', '*.DS_Store', '-x', 'node_modules/*', '-x', '.git/*'], { cwd: m.root, maxBuffer: 16 * 1024 * 1024 }); }
  catch (e) { return { error: 'Could not create the zip: ' + (e.message || e) }; }
  return { ok: true, file: destFile };
}

const marketFile = (dir) => path.join(dir, '.claude-plugin', 'marketplace.json');
// What a publish would touch, for the confirmation dialog. Nothing is written.
function planPublish(m, marketDir) {
  const mf = marketFile(marketDir); let market = null;
  try { market = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch {}
  if (fs.existsSync(mf) && (!market || !Array.isArray(market.plugins))) return { error: 'That folder’s marketplace.json is not valid, so nothing was changed.' };
  const folder = path.join(marketDir, 'plugins', m.name);
  return { marketName: market?.name || slugify(path.basename(marketDir)) || 'my-mods', isNew: !market, replaces: !!market?.plugins.some((p) => p.name === m.name) || fs.existsSync(folder), folder };
}
// Publish = put the mod into a marketplace folder (plugins/<name> + an entry in marketplace.json), the layout
// `/plugin marketplace add <folder>` reads in Claude Code. Returns the install lines to share.
function publish(m, marketDir) {
  marketDir = path.resolve(marketDir);
  if (!fs.existsSync(marketDir) || !fs.statSync(marketDir).isDirectory()) return { error: 'That marketplace folder doesn’t exist.' };
  const p = planPublish(m, marketDir); if (p.error) return p;
  if (!SAFE_DIR.test(m.name)) return { error: `“${m.name}” can’t be published under that name.` };
  const root = path.resolve(m.root);
  if (root === p.folder) return { error: 'This mod already lives in that marketplace.' };
  if (inside(marketDir, root) || inside(root, p.folder)) return { error: 'Pick a marketplace folder that is separate from the mod’s own folder.' };
  let market = { name: p.marketName, owner: { name: os.userInfo().username }, description: '', plugins: [] };
  if (!p.isNew) market = JSON.parse(fs.readFileSync(marketFile(marketDir), 'utf8'));
  const stage = p.folder + '.new-' + process.pid; fs.rmSync(stage, { recursive: true, force: true });
  try { fs.mkdirSync(path.join(marketDir, 'plugins'), { recursive: true }); copyMod(root, stage); fs.rmSync(p.folder, { recursive: true, force: true }); fs.renameSync(stage, p.folder); }
  catch (e) { return { error: 'Could not copy the mod: ' + e.message }; }
  finally { fs.rmSync(stage, { recursive: true, force: true }); }
  const entry = { name: m.name, source: `./plugins/${m.name}`, description: m.description, version: m.version || '0.1.0' };
  market.plugins = [...market.plugins.filter((x) => x.name !== m.name), entry].sort((a, b) => a.name.localeCompare(b.name));
  fs.mkdirSync(path.dirname(marketFile(marketDir)), { recursive: true });
  fs.writeFileSync(marketFile(marketDir), JSON.stringify(market, null, 2) + '\n');
  return { ok: true, marketName: market.name, folder: p.folder, replaced: p.replaces, created: p.isNew, install: [`/plugin marketplace add ${marketDir}`, `/plugin install ${m.name}@${market.name}`] };
}

// Only mods in GrizzyCode's own folder can be removed here; Claude Code's installs are managed there.
function removeNative(m, { dir = NATIVE_DIR } = {}) {
  const root = path.resolve(m.root);
  if (path.dirname(root) !== path.resolve(dir)) return { error: 'Only mods in GrizzyCode’s mods folder can be removed here. Remove Claude Code plugins in Claude Code.' };
  fs.rmSync(root, { recursive: true, force: true });
  return { ok: true };
}

module.exports = { NATIVE_DIR, validName, slugify, create, install, exportZip, planPublish, publish, removeNative, copyMod };
