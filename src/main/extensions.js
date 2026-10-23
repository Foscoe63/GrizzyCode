// Extensions: one-click MCP connectors from a curated catalog, plus .mcpb / .dxt bundles from disk.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const mcp = require('./mcp');
const arc = require('./archive');

const dir = () => path.join(store.root(), 'extensions');
const CATALOG = [
  { id: 'filesystem', name: 'Filesystem', description: 'Read, write and search files in a folder you choose.', needs: 'npx', params: [{ key: 'folder', label: 'Folder to share', type: 'folder' }], def: (p) => ({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', p.folder] }) },
  { id: 'memory-graph', name: 'Knowledge graph memory', description: 'A persistent knowledge graph the model can read and write.', needs: 'npx', def: () => ({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] }) },
  { id: 'sequential-thinking', name: 'Sequential thinking', description: 'Step-by-step reasoning scratchpad for hard problems.', needs: 'npx', def: () => ({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] }) },
  { id: 'playwright', name: 'Browser (Playwright)', description: 'Drive a real browser: open pages, click, type, take snapshots.', needs: 'npx', def: () => ({ command: 'npx', args: ['-y', '@playwright/mcp@latest'] }) },
  { id: 'fetch', name: 'Fetch', description: 'Fetch web pages and convert them to Markdown.', needs: 'uvx', def: () => ({ command: 'uvx', args: ['mcp-server-fetch'] }) },
  { id: 'git', name: 'Git', description: 'Inspect and operate on a Git repository.', needs: 'uvx', params: [{ key: 'folder', label: 'Repository folder', type: 'folder' }], def: (p) => ({ command: 'uvx', args: ['mcp-server-git', '--repository', p.folder] }) },
  { id: 'time', name: 'Time', description: 'Current time and time-zone conversions.', needs: 'uvx', def: () => ({ command: 'uvx', args: ['mcp-server-time'] }) },
];
function which(cmd) { for (const d of mcp.fullPath().split(':')) { try { fs.accessSync(path.join(d, cmd), fs.constants.X_OK); return true; } catch {} } return false; }
async function catalog() {
  await mcp.warmShellPath(); const have = new Map(mcp.list().map((s) => [s.name, s]));
  return CATALOG.map((c) => ({ id: c.id, name: c.name, description: c.description, needs: c.needs, available: which(c.needs), params: c.params || [], installed: have.has(c.id), status: have.get(c.id)?.status || null, error: have.get(c.id)?.error || null }));
}
async function install(id, params = {}) {
  const c = CATALOG.find((x) => x.id === id); if (!c) return { error: 'Unknown extension.' };
  for (const p of c.params || []) if (!params[p.key] || typeof params[p.key] !== 'string') return { error: `${p.label} is required.` };
  const r = await mcp.saveServer({ name: id, def: c.def(params), oldName: mcp.readConfig().mcpServers?.[id] ? id : undefined });
  return r.error ? r : { ok: true, server: mcp.list().find((s) => s.name === id) };
}
const uninstall = (id) => mcp.removeServer(id);

// ---- .mcpb / .dxt bundles ----
const MARK = ['manifest.json'];
function readBundle(src) {
  const tmp = arc.extractToTemp(src, { prefix: 'gc-mcpb-' }); const rootDir = arc.root(tmp, MARK);
  let m; try { m = JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8')); } catch { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error('No valid manifest.json found in that bundle.'); }
  return { tmp, rootDir, m };
}
const slug = (n) => String(n || 'extension').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'extension';
function defFromManifest(m, base) {
  const cfg = m.server?.mcp_config || {};
  const sub = (v) => String(v).replaceAll('${__dirname}', base);
  const cmd = cfg.command || (m.server?.type === 'python' ? 'python3' : m.server?.type === 'node' ? 'node' : null);
  let args = (cfg.args || (m.server?.entry_point ? [path.join(base, m.server.entry_point)] : [])).map(sub);
  if (!cmd) throw new Error('This bundle has no runnable server (binary-only or unsupported type).');
  const env = Object.fromEntries(Object.entries(cfg.env || {}).map(([k, v]) => [k, sub(v)]));
  const needsCfg = Object.entries(m.user_config || {}).filter(([k, c]) => c.required && c.default === undefined);
  const refs = JSON.stringify({ args, env }).includes('${user_config.');
  if (needsCfg.length || refs) throw new Error(`This extension needs configuration (${(needsCfg.map(([k]) => k).join(', ')) || 'user settings'}) that GrizzyCode can’t collect yet.`);
  return { command: cmd.startsWith('${') ? sub(cmd) : cmd, args, env };
}
function inspectBundle(src) {
  let b; try { b = readBundle(src); } catch (e) { return { error: e.message }; }
  try { const def = defFromManifest(b.m, '<extension folder>'); return { ok: true, name: slug(b.m.name), displayName: b.m.display_name || b.m.name, version: b.m.version || '', description: b.m.description || '', run: [def.command, ...def.args].join(' ') }; }
  catch (e) { return { error: e.message }; } finally { fs.rmSync(b.tmp, { recursive: true, force: true }); }
}
async function installBundle(src) {
  let b; try { b = readBundle(src); } catch (e) { return { error: e.message }; }
  try {
    const name = slug(b.m.name); const dest = path.join(dir(), name);
    fs.rmSync(dest, { recursive: true, force: true }); arc.copyTree(b.rootDir, dest);
    const def = defFromManifest(b.m, dest);
    const r = await mcp.saveServer({ name, def, oldName: mcp.readConfig().mcpServers?.[name] ? name : undefined });
    return r.error ? r : { ok: true, name, server: mcp.list().find((s) => s.name === name) };
  } catch (e) { return { error: e.message }; } finally { fs.rmSync(b.tmp, { recursive: true, force: true }); }
}
module.exports = { catalog, install, uninstall, inspectBundle, installBundle, dir, CATALOG };
