const { execFile } = require('child_process');
const run = (cwd, args) => new Promise((res) => execFile('git', args, { cwd, maxBuffer: 8 * 1024 * 1024, timeout: 15000 }, (e, out) => res(e ? null : out)));

async function status(cwd) {
  if (!cwd) return null;
  const out = await run(cwd, ['status', '--porcelain=v1', '-b']);
  if (out == null) return null;
  const lines = out.split('\n').filter(Boolean);
  const head = lines.shift() || '';
  const branch = head.replace(/^## /, '').split('...')[0].replace(/^No commits yet on /, '');
  const files = lines.map((l) => ({ status: l.slice(0, 2).trim() || '?', path: l.slice(3) }));
  return { branch, files };
}

async function diff(cwd, file) {
  if (!cwd) return '';
  const args = ['diff', 'HEAD', '--no-color', ...(file ? ['--', file] : [])];
  let out = await run(cwd, args);
  if (!out) out = await run(cwd, ['diff', '--no-color', ...(file ? ['--', file] : [])]);
  return (out || '').slice(0, 400000);
}

// ---- worktrees: each code session can work on its own branch in a sibling directory ----
const path = require('path');
const fs = require('fs');
const os = require('os');
const toplevel = async (cwd) => { const o = await run(cwd, ['rev-parse', '--show-toplevel']); return o ? o.trim() : null; };
const slug = (n) => String(n || 'session').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'session';
const runErr = (cwd, args) => new Promise((res) => execFile('git', args, { cwd, timeout: 30000 }, (e, out, err) => res({ ok: !e, out, err: (err || e?.message || '').trim() })));

// Creates <repo-parent>/.grizzycode-worktrees/<repo>-<slug>-<rand> on a new branch grizzy/<slug>-<rand> from HEAD.
async function worktreeAdd(cwd, name, opts = {}) {
  const root = await toplevel(cwd); if (!root) return { error: 'Not a git repository.' };
  const rand = Math.random().toString(36).slice(2, 6);
  const prefix = opts.prefix === undefined ? 'grizzy/' : opts.prefix;
  const branch = `${prefix}${slug(name)}-${rand}`;
  const base = opts.dir || path.join(path.dirname(root), '.grizzycode-worktrees');
  const dir = path.join(base, `${path.basename(root)}-${slug(name)}-${rand}`);
  fs.mkdirSync(base, { recursive: true });
  const r = await runErr(root, ['worktree', 'add', '-b', branch, dir, 'HEAD']);
  return r.ok ? { path: dir, branch, repo: root } : { error: r.err || 'git worktree add failed' };
}
async function worktreeList(cwd) {
  const o = await run(cwd, ['worktree', 'list', '--porcelain']); if (o == null) return [];
  return o.split('\n\n').filter(Boolean).map((b) => Object.fromEntries(b.split('\n').map((l) => { const i = l.indexOf(' '); return i < 0 ? [l, true] : [l.slice(0, i), l.slice(i + 1)]; })));
}
// Removes the worktree only if it has no uncommitted changes (never discards work); returns { removed, reason }.
async function worktreeRemove(wt) {
  if (!wt?.path || !wt?.repo || !fs.existsSync(wt.path)) return { removed: true };
  const st = await status(wt.path);
  if (st?.files?.length) return { removed: false, reason: 'uncommitted changes' };
  const r = await runErr(wt.repo, ['worktree', 'remove', wt.path]);
  return r.ok ? { removed: true } : { removed: false, reason: r.err };
}
const isRepo = async (cwd) => !!(await toplevel(cwd));

module.exports = { status, diff, worktreeAdd, worktreeList, worktreeRemove, isRepo };
