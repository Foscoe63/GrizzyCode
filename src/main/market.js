// Markets: browsable catalogs for plugins, skills and connectors.
// Plugins/skills come from public Claude marketplaces (.claude-plugin/marketplace.json in a GitHub repo, as Claude.app's
// default `anthropics/claude-plugins-official`); connectors come from the official MCP registry.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const store = require('./store');
const mcp = require('./mcp');
const plugins = require('./plugins');
const skills = require('./skills');
const arc = require('./archive');

const PLUGIN_REPO = 'anthropics/claude-plugins-official';
const SKILL_REPO = 'anthropics/skills';
const TTL = 60 * 60 * 1000;
const cacheFile = () => path.join(store.root(), 'market-cache.json');
const slug = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

async function getJson(url, timeout = 20000) {
  const r = await fetch(url, { headers: { 'user-agent': 'GrizzyCode', accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.json();
}
// Fetch with an on-disk fallback so the market still shows when offline.
async function cached(key, fetcher) {
  let all = {}; try { all = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); } catch {}
  const hit = all[key];
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  try {
    const data = await fetcher(); all[key] = { at: Date.now(), data };
    try { fs.mkdirSync(store.root(), { recursive: true }); fs.writeFileSync(cacheFile(), JSON.stringify(all)); } catch {}
    return data;
  } catch (e) { if (hit) return hit.data; throw e; }
}
const raw = (repo, file, ref = 'main') => `https://raw.githubusercontent.com/${repo}/${ref}/${file}`;

// ---- repo download (GitHub tarball -> temp dir) ----
async function downloadRepo(repo, ref) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-market-'));
  try {
    const r = await fetch(`https://codeload.github.com/${repo}/tar.gz/${encodeURIComponent(ref || 'HEAD')}`, { headers: { 'user-agent': 'GrizzyCode' }, signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error(`Could not download ${repo} (${r.status}).`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 200 * 1024 * 1024) throw new Error('That download is too large.');
    const f = path.join(tmp, 'repo.tgz'); fs.writeFileSync(f, buf);
    const out = path.join(tmp, 'src'); fs.mkdirSync(out);
    execFileSync('tar', ['-xzf', f, '-C', out]);
    const top = fs.readdirSync(out).filter((n) => fs.statSync(path.join(out, n)).isDirectory());
    return { tmp, root: top.length === 1 ? path.join(out, top[0]) : out };
  } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e; }
}
const githubRepo = (url) => { const m = String(url || '').match(/^(?:https:\/\/github\.com\/|git@github\.com:)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/); return m ? m[1] : null; };
const inside = (root, rel) => { const p = path.resolve(root, rel || '.'); if (p !== root && !p.startsWith(root + path.sep)) throw new Error('Unsafe path in marketplace entry.'); return p; };

// ---- plugins ----
async function pluginCatalog() {
  const data = await cached('plugins', () => getJson(raw(PLUGIN_REPO, '.claude-plugin/marketplace.json')));
  const have = new Set(plugins.list().map((p) => p.name));
  return (data.plugins || []).map((p) => ({
    id: p.name, name: p.name, description: p.description || '', category: p.category || '', author: p.author?.name || '',
    homepage: p.homepage || '', version: p.version || '', installed: have.has(slug(p.name)),
  }));
}
async function installPlugin(name) {
  const data = await cached('plugins', () => getJson(raw(PLUGIN_REPO, '.claude-plugin/marketplace.json')));
  const ent = (data.plugins || []).find((p) => p.name === name); if (!ent) return { error: 'That plugin is no longer in the marketplace.' };
  const s = ent.source; let repo, ref, sub = '';
  if (typeof s === 'string') { repo = PLUGIN_REPO; sub = s; }
  else if (s?.source === 'github') { repo = s.repo; ref = s.ref || s.sha; sub = s.path || ''; }
  else if (s?.source === 'url' || s?.source === 'git-subdir') { repo = githubRepo(s.url); ref = s.sha || s.ref; sub = s.path || ''; }
  if (!repo) return { error: 'This plugin is hosted somewhere other than GitHub, so it can’t be installed here.' };
  let dl; try { dl = await downloadRepo(repo, ref); } catch (e) { return { error: e.message }; }
  try {
    const dir = inside(dl.root, sub);
    if (!fs.existsSync(dir)) return { error: 'The plugin folder was not found in its repository.' };
    const r = await plugins.install(dir);
    // The plugin folder name is the marketplace name; keep that when its manifest has none.
    return r;
  } catch (e) { return { error: e.message }; } finally { fs.rmSync(dl.tmp, { recursive: true, force: true }); }
}

// ---- skills ----
function descOf(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/); if (!m) return { name: '', description: '' };
  const g = (k) => {
    const x = m[1].match(new RegExp(`^${k}:[ \\t]*(.*)$`, 'm')); if (!x) return '';
    let v = x[1].trim();
    if (/^[>|][+-]?$/.test(v)) v = m[1].slice(x.index + x[0].length).split('\n').slice(1).filter((l, i, a) => /^\s/.test(l) && a.slice(0, i).every((q) => /^\s/.test(q))).map((l) => l.trim()).join(' ');
    return v.replace(/^["']|["']$/g, '').trim();
  };
  return { name: g('name'), description: g('description') };
}
async function skillCatalog() {
  const list = await cached('skills', async () => {
    const dirs = (await getJson(`https://api.github.com/repos/${SKILL_REPO}/contents/skills`)).filter((e) => e.type === 'dir').map((e) => e.name);
    const out = await Promise.all(dirs.map(async (d) => {
      try { const r = await fetch(raw(SKILL_REPO, `skills/${d}/SKILL.md`), { signal: AbortSignal.timeout(20000) }); const { name, description } = descOf(await r.text()); return { id: d, name: name || d, description }; }
      catch { return { id: d, name: d, description: '' }; }
    }));
    return out;
  });
  const have = new Set(skills.list().map((k) => k.id));
  return list.map((k) => ({ ...k, source: SKILL_REPO, installed: have.has(k.id) }));
}
async function installSkill(id) {
  if (!/^[\w.-]+$/.test(id)) return { error: 'Invalid skill.' };
  let dl; try { dl = await downloadRepo(SKILL_REPO, 'main'); } catch (e) { return { error: e.message }; }
  try {
    const src = inside(dl.root, `skills/${id}`);
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) return { error: 'That skill was not found.' };
    fs.mkdirSync(skills.dir(), { recursive: true });
    fs.rmSync(path.join(skills.dir(), id), { recursive: true, force: true });
    arc.copyTree(src, path.join(skills.dir(), id));
    return { ok: true, id };
  } catch (e) { return { error: e.message }; } finally { fs.rmSync(dl.tmp, { recursive: true, force: true }); }
}

// ---- connectors (official MCP registry) ----
function entryOf(x) {
  const s = x.server || x; const remote = (s.remotes || []).find((r) => r.type === 'streamable-http') || (s.remotes || [])[0];
  const pkg = (s.packages || []).find((p) => p.registryType === 'npm' || p.registryType === 'pypi');
  const needs = [...(remote?.headers || []), ...(pkg?.environmentVariables || [])].filter((v) => v.isRequired).map((v) => v.name);
  return { id: s.name, name: s.title || s.name.split('/').pop(), description: s.description || '', version: s.version || '', homepage: s.websiteUrl || s.repository?.url || '',
    kind: remote ? 'remote' : pkg ? pkg.registryType : 'unsupported', needs };
}
async function connectorSearch({ q = '', cursor = '' } = {}) {
  const u = new URL('https://registry.modelcontextprotocol.io/v0/servers'); u.searchParams.set('limit', '30'); u.searchParams.set('version', 'latest');
  if (q) u.searchParams.set('search', q); if (cursor) u.searchParams.set('cursor', cursor);
  const j = await getJson(u.toString()); const have = new Set(mcp.list().map((s) => s.name));
  const seen = new Set();
  const items = (j.servers || []).map(entryOf).filter((e) => e.kind !== 'unsupported' && !seen.has(e.id) && seen.add(e.id)).map((e) => ({ ...e, installed: have.has(slug(e.id.split('/').pop())) || have.has(slug(e.id)) }));
  return { items, next: j.metadata?.nextCursor || '' };
}
async function installConnector(id, values = {}) {
  let j; try { j = await getJson(`https://registry.modelcontextprotocol.io/v0/servers/${encodeURIComponent(id)}/versions/latest`); } catch (e) { return { error: e.message }; }
  const s = j.server || j; const name = slug(s.name.split('/').pop()) || 'connector';
  const remote = (s.remotes || []).find((r) => r.type === 'streamable-http') || (s.remotes || [])[0]; let def;
  if (remote) {
    const headers = {}; for (const h of remote.headers || []) { if (values[h.name]) headers[h.name] = values[h.name]; else if (h.isRequired) return { error: `${h.name} is required.` }; }
    def = { url: remote.url, ...(Object.keys(headers).length ? { headers } : {}) };
  } else {
    const pkg = (s.packages || []).find((p) => p.registryType === 'npm' || p.registryType === 'pypi');
    if (!pkg) return { error: 'This server has no package GrizzyCode can run.' };
    const env = {}; for (const v of pkg.environmentVariables || []) { if (values[v.name]) env[v.name] = values[v.name]; else if (v.isRequired) return { error: `${v.name} is required.` }; }
    const spec = pkg.version ? (pkg.registryType === 'npm' ? `${pkg.identifier}@${pkg.version}` : `${pkg.identifier}==${pkg.version}`) : pkg.identifier;
    def = pkg.registryType === 'npm' ? { command: 'npx', args: ['-y', spec] } : { command: 'uvx', args: [spec] };
    if (Object.keys(env).length) def.env = env;
  }
  const r = await mcp.saveServer({ name, def, oldName: mcp.readConfig().mcpServers?.[name] ? name : undefined });
  return r.error ? r : { ok: true, name, server: mcp.list().find((x) => x.name === name) };
}
async function connectorFields(id) {
  try {
    const j = await getJson(`https://registry.modelcontextprotocol.io/v0/servers/${encodeURIComponent(id)}/versions/latest`); const s = j.server || j;
    const remote = (s.remotes || [])[0]; const pkg = (s.packages || []).find((p) => p.registryType === 'npm' || p.registryType === 'pypi');
    const f = [...(remote ? remote.headers || [] : pkg?.environmentVariables || [])].filter((v) => v.isRequired);
    const run = remote ? remote.url : pkg ? `${pkg.registryType === 'npm' ? 'npx' : 'uvx'} ${pkg.identifier}` : '';
    return { run, fields: f.map((v) => ({ name: v.name, description: v.description || '', secret: !!v.isSecret })) };
  } catch (e) { return { error: e.message }; }
}

module.exports = { pluginCatalog, installPlugin, skillCatalog, installSkill, connectorSearch, connectorFields, installConnector };
