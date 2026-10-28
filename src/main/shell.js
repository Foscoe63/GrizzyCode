// Window-shell behavior modelled on Claude.app 3.1623.4: `<scheme>://` deep links, renderer crash/hang recovery,
// a deny-by-default permission policy and persisted window bounds. Pure helpers are exported for the headless checks.
const SCHEME = 'grizzycode';
const ALLOWED_PERMS = new Set(['clipboard-sanitized-write', 'fullscreen']);

// grizzycode://new?q=<text>&mode=chat|code   grizzycode://open?id=<conversation>   grizzycode://settings
// Deep links only ever prefill or navigate; they never send a prompt or run anything.
function parseDeepLink(raw) {
  let u; try { u = new URL(String(raw)); } catch { return null; }
  if (u.protocol !== SCHEME + ':') return null;
  const action = (u.hostname || u.pathname.replace(/^\/+/, '')).toLowerCase();
  const q = u.searchParams;
  if (action === 'new') return { type: 'new', text: (q.get('q') || '').slice(0, 8000), mode: q.get('mode') === 'code' ? 'code' : 'chat' };
  if (action === 'open') { const id = q.get('id') || ''; return /^[\w-]{1,80}$/.test(id) ? { type: 'open', id } : null; }
  if (action === 'settings') return { type: 'settings' };
  return null;
}

// Keep saved bounds only if a good part of the window is still on a connected display.
function boundsOnScreen(b, displays) {
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width < 400 || b.height < 300) return null;
  const ok = displays.some((d) => {
    const a = d.workArea, w = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x), h = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
    return w >= 200 && h >= 120;
  });
  return ok ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } : null;
}

// Per-window hardening. `ctx` supplies electron pieces so this module stays testable.
function harden(w, { dialog, store, log = console }) {
  const wc = w.webContents;
  wc.on('will-attach-webview', (e) => e.preventDefault());
  let reloads = 0, lastReload = 0;
  wc.on('render-process-gone', (_e, { reason, exitCode }) => {
    if (reason === 'clean-exit' || w.isDestroyed()) return;
    log.warn?.('renderer gone', reason, exitCode);
    const now = Date.now(); reloads = now - lastReload > 60000 ? 1 : reloads + 1; lastReload = now;
    if (reloads > 3) { dialog.showErrorBox('GrizzyCode', `The window stopped (${reason}). Restart GrizzyCode to continue.`); return; }
    setTimeout(() => { if (!w.isDestroyed()) wc.reload(); }, 300);
  });
  let asking = false;
  w.on('unresponsive', async () => {
    if (asking || w.isDestroyed()) return; asking = true;
    try {
      const { response } = await dialog.showMessageBox(w, { type: 'warning', buttons: ['Wait', 'Reload'], defaultId: 0, cancelId: 0, message: 'GrizzyCode is not responding', detail: 'Waiting keeps your work; reloading restarts the window (conversations are saved).' });
      if (response === 1 && !w.isDestroyed()) wc.forcefullyCrashRenderer?.(), wc.reload();
    } finally { asking = false; }
  });
  // Persist size and position (debounced) so the window reopens where it was.
  let t; const save = () => {
    clearTimeout(t); t = setTimeout(() => {
      if (w.isDestroyed() || w.isMinimized() || w.isFullScreen()) return;
      try { store.saveSettings({ winBounds: w.getBounds(), winMax: w.isMaximized() }); } catch {}
    }, 400);
  };
  w.on('resize', save); w.on('move', save); w.on('close', () => clearTimeout(t));
}

// Main-window session: nothing is granted except clipboard writes and fullscreen; downloads never start silently.
function lockSession(ses) {
  ses.setPermissionRequestHandler((_w, p, cb) => cb(ALLOWED_PERMS.has(p)));
  ses.setPermissionCheckHandler((_w, p) => ALLOWED_PERMS.has(p));
  ses.on('will-download', (e) => e.preventDefault());
}

module.exports = { SCHEME, ALLOWED_PERMS, parseDeepLink, boundsOnScreen, harden, lockSession };
