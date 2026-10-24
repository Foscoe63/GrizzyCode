// Housekeeping and system helpers behind Settings → System / About: storage usage, auto-archive,
// worktree reaping, update check, macOS permission status and the optional shell sandbox.
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');
const git = require('./git');

const REPO = 'Foscoe63/GrizzyCode';

// ---- storage ----
function dirSize(p) {
  let n = 0;
  try {
    const st = fs.lstatSync(p);
    if (!st.isDirectory()) return st.size;
    for (const e of fs.readdirSync(p)) n += dirSize(path.join(p, e));
  } catch {}
  return n;
}
function usage(logDir) {
  const r = store.root();
  const parts = [
    ['Conversations', path.join(r, 'conversations')], ['Memory', path.join(r, 'memory.json')], ['Skills and plugins', null],
    ['Extensions', path.join(r, 'extensions')], ['Mods', path.join(r, 'mods')], ['Logs', logDir],
  ];
  const out = [];
  for (const [label, p] of parts) {
    if (p) out.push({ label, bytes: dirSize(p) });
    else out.push({ label, bytes: dirSize(path.join(r, 'skills')) + dirSize(path.join(r, 'plugins')) });
  }
  let wt = 0;
  for (const m of store.listConversations(true)) { try { const c = store.getConversation(m.id); if (c.worktree?.path && !c.worktree.reaped) wt += dirSize(c.worktree.path); } catch {} }
  out.push({ label: 'Worktrees', bytes: wt });
  const total = dirSize(r) + wt;
  let free = null; try { const s = fs.statfsSync(r); free = s.bavail * s.bsize; } catch {}
  return { items: out, total, free, path: r };
}

// ---- auto-archive: conversations untouched for N days (pinned and running ones are kept) ----
function autoArchive(days, isRunning = () => false) {
  if (!days || days < 1) return 0;
  const cutoff = Date.now() - days * 86400000; let n = 0;
  for (const m of store.listConversations(false)) {
    if (m.pinned || m.updatedAt > cutoff || isRunning(m.id)) continue;
    try { const c = store.getConversation(m.id); c.archived = true; c.closedAt = Date.now(); store.saveConversation(c); n++; } catch {}
  }
  return n;
}

// ---- worktree reaping: clean worktrees of archived sessions that were closed more than `hours` ago ----
async function reapWorktrees(hours, { now = Date.now() } = {}) {
  if (hours == null || hours < 0) return { removed: 0, kept: 0 };
  let removed = 0, kept = 0;
  for (const m of store.listConversations(true)) {
    if (!m.archived || now - (m.closedAt || m.updatedAt) < hours * 3600000) continue;
    let c; try { c = store.getConversation(m.id); } catch { continue; }
    if (!c.worktree?.path || c.worktree.reaped) continue;
    const r = await git.worktreeRemove(c.worktree);
    if (r.removed) { c.worktree.reaped = true; store.saveConversation(c); removed++; } else kept++;
  }
  return { removed, kept };
}

// ---- update check against GitHub releases ----
const cmpVer = (a, b) => {
  const p = (v) => String(v).replace(/^v/, '').split('-')[0].split('.').map((x) => parseInt(x, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
  return 0;
};
async function checkUpdate(current) {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'GrizzyCode' }, signal: AbortSignal.timeout(10000) });
    if (res.status === 404) return { current, error: 'No releases have been published yet.' };
    if (!res.ok) return { current, error: `GitHub answered ${res.status}.` };
    const j = await res.json();
    return { current, latest: String(j.tag_name || '').replace(/^v/, ''), url: j.html_url, newer: cmpVer(j.tag_name, current) > 0 };
  } catch (e) { return { current, error: 'Could not reach GitHub: ' + e.message }; }
}
const feedbackUrl = (info) => `https://github.com/${REPO}/issues/new?body=${encodeURIComponent(`\n\n---\nGrizzyCode ${info.version} · Electron ${info.electron} · ${info.platform}`)}`;

// ---- macOS privacy permissions ----
const PANES = { accessibility: 'Privacy_Accessibility', screen: 'Privacy_ScreenCapture', microphone: 'Privacy_Microphone', files: 'Privacy_AllFiles', automation: 'Privacy_Automation' };
function permissions(systemPreferences) {
  if (process.platform !== 'darwin') return null;
  const s = (k) => { try { return systemPreferences.getMediaAccessStatus(k); } catch { return 'unknown'; } };
  let ax = false; try { ax = systemPreferences.isTrustedAccessibilityClient(false); } catch {}
  return { accessibility: ax ? 'granted' : 'not-granted', screen: s('screen'), microphone: s('microphone') };
}
const permissionUrl = (key) => (PANES[key] ? `x-apple.systempreferences:com.apple.preference.security?${PANES[key]}` : null);

// ---- shell sandbox (macOS sandbox-exec): 'files' = writes only inside the project, 'strict' = also no network ----
const SB_BIN = '/usr/bin/sandbox-exec';
function sandboxArgs(mode, cwd, command) {
  if (process.platform !== 'darwin' || !['files', 'strict'].includes(mode) || !fs.existsSync(SB_BIN)) return null;
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const home = os.homedir();
  const rules = [
    '(version 1)', '(allow default)', '(deny file-write*)',
    '(allow file-write* (subpath (param "CWD")) (subpath "/private/tmp") (subpath "/private/var/folders") (subpath (param "NPM")) (subpath (param "CACHE")) (subpath (param "TMP")))',
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/(fd|tty|pty)"))',
  ];
  if (mode === 'strict') rules.push('(deny network*)', '(allow network* (local unix-socket))');
  return ['-D', `CWD=${real(cwd || home)}`, '-D', `NPM=${path.join(home, '.npm')}`, '-D', `CACHE=${path.join(home, '.cache')}`, '-D', `TMP=${real(os.tmpdir())}`, '-p', rules.join('\n'), '/bin/zsh', '-lc', command];
}

// The one place a shell command is launched (bash tool and background tasks): honours Settings → Claude Code → Shell sandbox.
function spawnShell(command, cwd, env = {}, opts = {}) {
  const { spawn } = require('child_process');
  let sb = null; try { sb = sandboxArgs(store.getSettings().sandboxShell, cwd, command); } catch {}
  const o = { cwd: cwd || process.env.HOME, env: { ...process.env, ...env }, ...opts };
  return sb ? spawn(SB_BIN, sb, o) : spawn('/bin/zsh', ['-lc', command], o);
}

// ---- @-mention file search: a cached, ignore-aware listing of the session folder ----
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'target', '.venv', 'venv', '__pycache__', '.cache', 'coverage', '.DS_Store', '.idea', '.gradle', 'Pods', 'DerivedData']);
const listCache = new Map();
function listFiles(cwd, { maxEntries = 6000, maxDepth = 8 } = {}) {
  const hit = listCache.get(cwd); if (hit && Date.now() - hit.at < 30000) return hit.list;
  const list = []; const queue = [[cwd, 0]];
  while (queue.length && list.length < maxEntries) {
    const [d, depth] = queue.shift();
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (SKIP.has(e.name) || (e.name.startsWith('.') && e.name !== '.github')) continue;
      const rel = path.relative(cwd, path.join(d, e.name));
      list.push({ rel, dir: e.isDirectory() });
      if (e.isDirectory() && depth < maxDepth && !e.isSymbolicLink()) queue.push([path.join(d, e.name), depth + 1]);
      if (list.length >= maxEntries) break;
    }
  }
  listCache.set(cwd, { at: Date.now(), list }); return list;
}
function searchFiles(cwd, query, limit = 8) {
  if (!cwd || !fs.existsSync(cwd)) return [];
  const q = String(query || '').toLowerCase(); const files = listFiles(cwd);
  const subseq = (s) => { let i = 0; for (const ch of s) if (ch === q[i] && ++i === q.length) return true; return !q; };
  const scored = [];
  for (const f of files) {
    const rel = f.rel.toLowerCase(), base = path.basename(rel);
    let sc = -1;
    if (!q) sc = 100 - f.rel.split('/').length * 10;
    else if (base === q) sc = 1000; else if (base.startsWith(q)) sc = 800 - base.length; else if (base.includes(q)) sc = 600 - base.length;
    else if (rel.includes(q)) sc = 400 - rel.length; else if (subseq(rel)) sc = 100 - rel.length;
    if (sc >= 0) scored.push([sc + (f.dir ? -5 : 0), f]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, f]) => ({ rel: f.rel, path: path.join(cwd, f.rel), dir: f.dir }));
}

module.exports = { searchFiles, spawnShell, usage, autoArchive, reapWorktrees, checkUpdate, cmpVer, feedbackUrl, permissions, permissionUrl, sandboxArgs, SB_BIN, dirSize };
