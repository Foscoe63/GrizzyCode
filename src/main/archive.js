// Safe-ish extraction of user-supplied zip-like bundles (.skill, .plugin, .mcpb, .dxt, .zip) with the system unzip.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function listEntries(file) { return execFileSync('unzip', ['-Z1', file], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\n').filter(Boolean); }
// Extracts into a fresh temp dir; rejects absolute paths, ".." segments and oversized archives. Returns the dir.
function extractToTemp(file, { maxBytes = 200 * 1024 * 1024, prefix = 'gc-arc-' } = {}) {
  const st = fs.statSync(file); if (st.size > maxBytes) throw new Error(`That file is too large (${Math.round(maxBytes / 1048576)} MB max).`);
  for (const e of listEntries(file)) if (e.startsWith('/') || e.split('/').includes('..')) throw new Error('The archive contains unsafe paths and was not opened.');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try { execFileSync('unzip', ['-q', '-o', file, '-d', tmp]); } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error('Could not unzip that file.'); }
  return tmp;
}
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isSymbolicLink()) continue; // never follow links out of a bundle
    if (e.isDirectory()) copyTree(a, b); else fs.copyFileSync(a, b);
  }
}
// If the archive wraps everything in one top-level folder, descend into it.
function root(dir, marker) {
  if (marker.some((m) => fs.existsSync(path.join(dir, m)))) return dir;
  const subs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const s of subs) if (marker.some((m) => fs.existsSync(path.join(dir, s.name, m)))) return path.join(dir, s.name);
  return dir;
}
module.exports = { extractToTemp, copyTree, root, listEntries };
