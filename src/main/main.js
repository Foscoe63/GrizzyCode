const { app, BrowserWindow, protocol, Menu, Tray, globalShortcut, ipcMain, dialog, nativeImage, shell, nativeTheme, screen, Notification, powerSaveBlocker, session, powerMonitor, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const agent = require('./agent');
const agents = require('./agents');
const mcp = require('./mcp');
const skills = require('./skills');
const git = require('./git');
const term = require('./terminal');
const importer = require('./importer');
const features = require('./features');
const llm = require('./llm');
const auth = require('./auth');
const models = require('./models');
const providers = require('./providers');
const modsGlue = require('./mods/glue');
const savings = require('./savings');
const memory = require('./memory');
const designsystems = require('./designsystems');
const themes = require('./themes');
const plugins = require('./plugins');
const extensions = require('./extensions');
const market = require('./market');
const dataops = require('./dataops');
const logger = require('./logger');
const extras = require('./extras');
const bgtasks = require('./bgtasks');
const system = require('./system');
const shell_ = require('./shell');
const artifacts = require('./artifacts');

const wins = new Set();
let quick = null, quickReady = null, tray = null, aboutWin = null;
// Quick Entry geometry observed in Claude.app: 606x470 panel, 30px screen margin, centered on primary display.
const QW = 606, QH = 470, QMARGIN = 30;
const R = (f) => path.join(__dirname, '..', 'renderer', f);
const preload = path.join(__dirname, '..', 'preload.js');
const BG = () => (nativeTheme.shouldUseDarkColors ? '#20201f' : '#f9f9f7');

let awakeId = null; const running = new Set();
const onBattery = () => { try { return powerMonitor.isOnBatteryPower(); } catch { return false; } };
function track(ev) {
  const st = store.getSettings();
  if (ev.type === 'start') { running.add(ev.convId); if (st.keepAwake && awakeId === null && (st.keepAwakeBattery !== false || !onBattery())) awakeId = powerSaveBlocker.start('prevent-app-suspension'); }
  else if (ev.type === 'done' || ev.type === 'error') { running.delete(ev.convId); if (!running.size && awakeId !== null) { powerSaveBlocker.stop(awakeId); awakeId = null; } }
  const away = !BrowserWindow.getAllWindows().some((w) => w.isFocused());
  const kind = ev.type === 'approval' ? 'notifyApproval' : (ev.type === 'done' || ev.type === 'error') ? 'notifyDone' : null;
  const level = kind ? (st[kind] || 'banner') : 'off';
  if (st.notifications && away && level !== 'off') {
    if (st.dockBounce) { try { app.dock?.bounce(ev.type === 'approval' ? 'critical' : 'informational'); } catch {} }
    if (level === 'badge') { try { app.dock?.setBadge('•'); } catch {} }
    else if (Notification.isSupported()) {
      let title = 'GrizzyCode', body = '';
      try { const c = store.getConversation(ev.convId); title = c.title || title; } catch {}
      body = ev.type === 'approval' ? 'Needs your input to continue' : ev.type === 'error' ? 'Stopped with an error' : 'Finished';
      const n = new Notification({ title, body, silent: !st.notifySound });
      n.on('click', () => { showMain(); cmd('open', ev.convId); }); n.show();
    }
  }
}
const emit = (ev) => { try { track(ev); } catch {} for (const w of wins) if (!w.isDestroyed()) w.webContents.send('agent:event', ev); };
const focused = () => BrowserWindow.getFocusedWindow() && wins.has(BrowserWindow.getFocusedWindow()) ? BrowserWindow.getFocusedWindow() : [...wins][0];
const cmd = (ch, ...a) => { const w = focused(); if (!w) { createMain(); return; } w.show(); w.focus(); w.webContents.send('ui:command', ch, ...a); };

// Split View: tile the focused window and a new one (halves left/right, or top/bottom); Close Split puts the partner back.
function splitWindow(convId, vertical) {
  const w = focused(); if (!w) return;
  const d = screen.getDisplayMatching(w.getBounds()).workArea;
  if (w.isFullScreen()) w.setFullScreen(false); if (w.isMaximized()) w.unmaximize();
  const pre = w.getBounds(), h1 = Math.floor((vertical ? d.height : d.width) / 2);
  const A = vertical ? { x: d.x, y: d.y, width: d.width, height: h1 } : { x: d.x, y: d.y, width: h1, height: d.height };
  const B = vertical ? { x: d.x, y: d.y + h1, width: d.width, height: d.height - h1 } : { x: d.x + h1, y: d.y, width: d.width - h1, height: d.height };
  w.setBounds(A);
  const n = createMain({ conv: convId }); n.setBounds(B);
  splitPairs.set(n, { partner: w, pre });
}
const splitPairs = new WeakMap();
function closeSplit() {
  const w = focused(), pair = w && splitPairs.get(w); if (!pair) return;
  if (!pair.partner.isDestroyed()) { pair.partner.setBounds(pair.pre); pair.partner.focus(); }
  w.close();
}
function cycleWindow(dir) {
  const list = [...wins].filter((x) => !x.isDestroyed()); if (list.length < 2) return;
  const i = list.indexOf(focused()); list[(i + dir + list.length) % list.length].focus();
}

function createMain({ conv } = {}) {
  const sv = store.getSettings(), saved = shell_.boundsOnScreen(sv.winBounds, screen.getAllDisplays());
  const w = new BrowserWindow({
    ...(saved || { width: 1180, height: 780 }), minWidth: 720, minHeight: 480, title: 'GrizzyCode', icon: APP_ICON,
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 }, backgroundColor: BG(),
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  wins.add(w);
  shell_.harden(w, { dialog, store, log: console });
  if (saved && sv.winMax && wins.size === 1) w.maximize();
  if (wins.size > 1) { const [x, y] = [...wins][0].getPosition(); w.setPosition(x + 28, y + 28); }
  w.loadFile(R('index.html'), conv ? { query: { conv } } : undefined);
  w.webContents.on('did-finish-load', () => w.webContents.setZoomLevel(store.getSettings().zoom || 0));
  w.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  w.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  w.on('closed', () => wins.delete(w));
  return w;
}
const showMain = () => { const w = focused() || createMain(); if (w.isMinimized()) w.restore(); w.show(); w.focus(); return w; };

// ---------------- Quick Entry ----------------
function defaultQuickPos() {
  const d = screen.getPrimaryDisplay();
  return { x: Math.round((d.workAreaSize.width - QW) / 2 + d.workArea.x), y: Math.round((d.workAreaSize.height - QH) / 2 + d.workArea.y) };
}
function restoreQuickPos() {
  const p = store.getSettings().quickPos;
  if (!p) return defaultQuickPos();
  const d = screen.getAllDisplays().find((x) => x.id === p.displayId);
  if (!d) return defaultQuickPos();
  const x = d.workArea.x + p.relX, y = d.workArea.y + p.relY;
  return x >= d.workArea.x && y >= d.workArea.y && x + 40 < d.workArea.x + d.workArea.width && y + 40 < d.workArea.y + d.workArea.height ? { x, y } : defaultQuickPos();
}
function ensureQuick() {
  if (quick && !quick.isDestroyed()) return quick;
  const pos = restoreQuickPos();
  quick = new BrowserWindow({
    x: pos.x, y: pos.y, width: QW, height: QH, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: true,
    resizable: false, minimizable: false, maximizable: false, closable: false, skipTaskbar: true, show: false,
    ...(process.platform === 'darwin' ? { type: 'panel', titleBarStyle: 'hidden', hiddenInMissionControl: true } : {}),
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  quick.setAlwaysOnTop(true, 'pop-up-menu');
  quick.setFullScreenable(false);
  quick.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  quickReady = new Promise((r) => quick.once('ready-to-show', r));
  quick.loadFile(R('quick.html'));
  quick.on('hide', () => {
    try {
      const [x, y] = quick.getPosition(); const d = screen.getDisplayNearestPoint({ x, y });
      store.saveSettings({ quickPos: { displayId: d.id, relX: x - d.workArea.x, relY: y - d.workArea.y } });
    } catch {}
  });
  quick.on('blur', () => { if (quick && !quick.isDestroyed() && quick.isVisible()) quick.hide(); });
  quick.on('closed', () => { quick = null; });
  return quick;
}
async function toggleQuick() {
  const q = ensureQuick();
  if (q.isVisible()) { q.hide(); return; }
  await quickReady;
  const pos = restoreQuickPos(); q.setPosition(pos.x, pos.y);
  q.webContents.send('quick:reset');
  q.show(); q.focus();
}
// Keep the card on screen when its content grows (Claude.app calls this "skooch").
function skooch(w, h) {
  if (!quick || quick.isDestroyed()) return;
  const [x, y] = quick.getPosition(); const d = screen.getDisplayNearestPoint({ x, y }); if (!d) return;
  const bottom = d.workArea.y + d.workArea.height, right = d.workArea.x + d.workArea.width;
  let ny = bottom - h - QMARGIN; if (y + h <= bottom) ny = y;
  let nx = right - w - QMARGIN; if (x + w <= right) nx = x;
  if (nx !== x || ny !== y) quick.setPosition(nx, ny);
}
function submitQuick({ text = '', images = [] }) {
  if (quick && !quick.isDestroyed()) quick.hide();
  if (!(text.trim().length > 2 || images.length)) return;
  const st = store.getSettings();
  if (!st.hasKey && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(st.baseUrl || '')) { showMain(); cmd('settings'); return; }
  const c = store.newConversation({ mode: 'chat' });
  const w = showMain();
  const go = () => { w.webContents.send('ui:command', 'open', c.id); agent.send(c.id, text, emit, images); };
  w.webContents.isLoading() ? w.webContents.once('did-finish-load', go) : go();
}
// Auto-archive idle conversations and reap finished worktrees, per the settings (both off by default).
function housekeeping() {
  const st = store.getSettings();
  try { if (extras.autoArchive(st.archiveDays, agent.isRunning)) for (const w of wins) if (!w.isDestroyed()) w.webContents.send('ui:command', 'dataChanged'); } catch {}
  if (st.worktreeReapHours > 0) extras.reapWorktrees(st.worktreeReapHours).catch(() => {});
}
function registerShortcut() {
  globalShortcut.unregisterAll();
  const acc = store.getSettings().quickShortcut;
  if (!acc || String(acc).toLowerCase() === 'off') return true;
  try { globalShortcut.register(acc, toggleQuick); } catch {}
  return globalShortcut.isRegistered(acc);
}

// ---------------- About ----------------
function showAbout() {
  if (aboutWin && !aboutWin.isDestroyed()) { aboutWin.show(); return; }
  aboutWin = new BrowserWindow({ width: 360, height: 300, resizable: false, minimizable: false, maximizable: false, title: 'About GrizzyCode',
    titleBarStyle: 'hiddenInset', backgroundColor: BG(), webPreferences: { preload, contextIsolation: true, sandbox: true } });
  aboutWin.loadFile(R('about.html'));
  aboutWin.on('closed', () => { aboutWin = null; });
}

// ---------------- Artifact libraries ----------------
// Artifacts usually pull Chart.js / Mermaid / Grid.js from a CDN; serve the bundled copies so previews work offline.
const ART_LIBS = [
  { re: /https?:\/\/[^"'\s]*chart(?:\.umd)?(?:\.min)?\.js/gi, from: 'chart.js/dist/chart.umd.js', to: 'chart.umd.js' },
  { re: /https?:\/\/[^"'\s]*mermaid(?:\.min)?\.js/gi, from: 'mermaid/dist/mermaid.min.js', to: 'mermaid.min.js' },
  { re: /https?:\/\/[^"'\s]*gridjs(?:\.umd)?(?:\.min)?\.js/gi, from: 'gridjs/dist/gridjs.umd.js', to: 'gridjs.umd.js' },
  { re: /https?:\/\/[^"'\s]*gridjs[^"'\s]*\.css/gi, from: 'gridjs/dist/theme/mermaid.min.css', to: 'gridjs.css' },
];
function localizeLibs(dir, code) {
  for (const l of ART_LIBS) {
    if (!l.re.test(code)) { l.re.lastIndex = 0; continue; }
    l.re.lastIndex = 0;
    try { fs.copyFileSync(path.join(__dirname, '..', '..', 'node_modules', l.from), path.join(dir, l.to)); code = code.replace(l.re, './' + l.to); } catch {}
  }
  return code;
}

// ---------------- Menu / tray ----------------
function buildMenu() {
  const zoom = (d) => () => { const s = store.getSettings(); const z = d === 0 ? 0 : Math.max(-3, Math.min(5, (s.zoom || 0) + d)); store.saveSettings({ zoom: z }); for (const w of wins) w.webContents.setZoomLevel(z); };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'GrizzyCode', submenu: [
      { label: 'About GrizzyCode', click: showAbout }, { type: 'separator' },
      { label: 'Settings…', accelerator: 'Cmd+,', click: () => cmd('settings') }, { type: 'separator' },
      { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' } ] },
    { label: 'File', submenu: [
      { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: () => cmd('new', 'chat') },
      { label: 'New Session…', accelerator: 'CmdOrCtrl+Shift+N', click: () => cmd('new', 'code') },
      { label: 'New Session in New Window', accelerator: 'CmdOrCtrl+Alt+N', click: () => cmd('newWindow') },
      { label: 'Open Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: () => cmd('new', 'code') },
      { type: 'separator' },
      { label: 'Reopen Closed Session', accelerator: 'CmdOrCtrl+Shift+T', click: () => cmd('reopen') },
      { label: 'Close Session', accelerator: 'CmdOrCtrl+W', click: () => cmd('closeSession') },
      { type: 'separator' },
      { label: 'Command Palette…', accelerator: 'CmdOrCtrl+Shift+P', click: () => cmd('palette') },
      { label: 'Open Quick Entry', click: toggleQuick },
      { label: 'Import CLI Sessions…', click: () => cmd('importCli') },
      { label: 'Export Conversation…', click: () => cmd('export') } ] },
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' }, { type: 'separator' },
      { label: 'Find', submenu: [
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => cmd('find') },
        { label: 'Find Next', accelerator: 'CmdOrCtrl+G', click: () => cmd('findNext', true) },
        { label: 'Find Previous', accelerator: 'CmdOrCtrl+Shift+G', click: () => cmd('findNext', false) } ] } ] },
    { label: 'Go', submenu: [
      { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => cmd('back') },
      { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => cmd('forward') },
      { type: 'separator' },
      { label: 'Search…', accelerator: 'CmdOrCtrl+K', click: () => cmd('search') },
      { type: 'separator' },
      { label: 'Previous Session', accelerator: 'CmdOrCtrl+Shift+[', click: () => cmd('prev') },
      { label: 'Next Session', accelerator: 'CmdOrCtrl+Shift+]', click: () => cmd('next') },
      { type: 'separator' },
      { label: 'Side Chat', accelerator: 'CmdOrCtrl+;', click: () => cmd('side') },
      { label: 'Split View', submenu: [
        { label: 'Open Session Side by Side', accelerator: 'Ctrl+CmdOrCtrl+\\', click: () => cmd('split', false) },
        { label: 'Open Session Stacked', accelerator: 'Ctrl+CmdOrCtrl+-', click: () => cmd('split', true) },
        { label: 'Focus Next Window', accelerator: 'Ctrl+]', click: () => cycleWindow(1) },
        { label: 'Focus Previous Window', accelerator: 'Ctrl+[', click: () => cycleWindow(-1) },
        { label: 'Close Split Window', accelerator: 'Ctrl+CmdOrCtrl+W', click: closeSplit } ] } ] },
    { label: 'View', submenu: [
      { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => cmd('sidebar') },
      { label: 'Toggle Terminal', accelerator: 'Ctrl+`', click: () => cmd('terminal') },
      { label: 'Toggle Right Sidebar', accelerator: 'CmdOrCtrl+Alt+B', click: () => cmd('rside') },
      { label: 'Toggle Changes', accelerator: 'CmdOrCtrl+Shift+D', click: () => cmd('diff') },
      { label: 'Close Pane', accelerator: 'CmdOrCtrl+\\', click: () => cmd('closePane') },
      { type: 'separator' },
      { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: zoom(1) }, { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: zoom(-1) }, { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: zoom(0) },
      { type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools', accelerator: 'CmdOrCtrl+Alt+I' }, { role: 'togglefullscreen' } ] },
    { label: 'Tools', submenu: [
      { label: 'Open MCP Config', click: () => shell.openPath(mcp.configPath()) },
      { label: 'Reload MCP Servers', click: () => mcp.startAll() },
      { label: 'Open Skills Folder', click: () => shell.openPath(skills.dir()) } ] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: () => cmd('shortcuts') }] },
  ]));
}
// The menu bar icon follows "Keep running in the system tray": on shows it, off removes it (closing the last window then quits).
function syncTray() {
  const on = store.getSettings().runInTray !== false;
  if (!on && tray) { tray.destroy(); tray = null; } else if (on && !tray) buildTray();
}
function buildTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png')).resize({ width: 18, height: 18 });
  tray = new Tray(img);
  tray.setToolTip('GrizzyCode');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show GrizzyCode', click: showMain }, { label: 'Quick Entry', click: toggleQuick },
    { label: 'New Chat', click: () => cmd('new', 'chat') }, { type: 'separator' }, { role: 'quit' }]));
  tray.on('click', showMain);
}

// ---------------- IPC ----------------
function ipc() {
  const h = (n, f) => ipcMain.handle(n, (_e, ...a) => f(...a));
  // Event broadcast helper: forwards ipcMain events to renderer listeners
  const onEvt = (ch, f) => ipcMain.on(ch, (_e, ...a) => f(...a));

  // --- Core tool IPC (existing) ---
  const withUsable = (st) => ({ ...st, usable: !!st.hasKey || /^https?:\/\/(localhost|127\.0\.0\.1)/.test(st.baseUrl || '') || providers.list(st).some((p) => p.enabled && (p.hasKey || !p.needsKey)) });
  h('settings:get', () => withUsable(store.getSettings()));
  const clean = require('./validate').cleanSettings;
  h('settings:set', (p) => {
    const { out, bad } = clean(p);
    const s = store.saveSettings(out); let shortcutOk;
    if ('quickShortcut' in out) shortcutOk = registerShortcut();
    if ('theme' in out || 'colorTheme' in out) nativeTheme.themeSource = themes.nativeSource(s);
    if ('runInTray' in out) syncTray();
    if ('launchAtLogin' in out) { try { app.setLoginItemSettings({ openAtLogin: !!out.launchAtLogin }); } catch {} }
    if ('retentionDays' in out) dataops.purgeOld(out.retentionDays);
    if (('keepAwake' in out) && !out.keepAwake && awakeId !== null) { powerSaveBlocker.stop(awakeId); awakeId = null; }
    if ('archiveDays' in out) housekeeping();
    if ('font' in out) for (const w of wins) w.webContents.send('ui:command', 'font', out.font);
    return { ...withUsable(s), ...(shortcutOk === undefined ? {} : { shortcutOk }), ...(bad.length ? { rejected: bad } : {}) };
  });
  h('zoom:set', (d) => { const z = d === 0 ? 0 : Math.max(-3, Math.min(5, (store.getSettings().zoom || 0) + d)); store.saveSettings({ zoom: z }); for (const w of wins) w.webContents.setZoomLevel(z); return z; });
  h('api:test', async () => {
    const s = store.getSettings({ reveal: true });
    if (!s.apiKey) return { ok: false, error: 'No API key saved yet.' };
    try { await llm.stream({ ...s, maxTokens: 8 }, { system: 'Reply with one word.', messages: [{ role: 'user', content: 'ping' }], tools: [] }, () => {}, AbortSignal.timeout(20000)); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e.message).slice(0, 160) }; }
  });
  h('savings:stats', (convId) => { let c = null; try { c = convId ? store.getConversation(convId) : null; } catch {} return { ...savings.stats(c), pinned: convId ? savings.pins(convId) : [] }; });
  h('savings:reset', () => savings.resetStats());
  h('savings:compact', (convId) => agent.compactNow(convId));
  h('savings:pin', (convId, fact) => savings.pin(convId, fact));
  h('savings:unpin', (convId, i) => savings.unpin(convId, i));
  h('usage:get', () => store.getUsage());
  h('usage:clear', () => { store.clearUsage(); return store.getUsage(); });
  h('data:path', () => store.root());
  h('data:open', () => shell.openPath(store.root()));
  h('auth:status', () => auth.status());
  h('auth:openrouter', async () => { const r = await auth.signInOpenRouter(); const w = focused(); if (w && r.ok) { w.show(); w.focus(); } return { ...r, settings: store.getSettings() }; });
  h('auth:openrouterKey', async (k) => { const r = await auth.saveOpenRouterKey(k); return { ...r, settings: store.getSettings() }; });
  h('app:openUrl', (u) => { if (/^https:\/\//.test(u)) shell.openExternal(u); });
  h('auth:cancel', () => auth.cancel());
  h('auth:anthropicOpen', () => auth.openAnthropicConsole());
  h('auth:anthropicPeek', () => auth.peekAnthropicKey());
  h('auth:anthropicUse', async () => { const r = await auth.useAnthropicKey(); return { ...r, settings: store.getSettings() }; });
  h('auth:signout', () => withUsable(auth.signOut()));
  h('auth:removeProvider', (id) => withUsable(auth.removeProvider(id)));
  // --- Providers ---
  h('providers:list', () => providers.list());
  h('providers:save', (p) => providers.save(p));
  h('providers:remove', (id) => providers.remove(id));
  h('providers:models', async (id, force) => { const st = store.getSettings({ reveal: true }); const p = providers.get(id, st); if (!p) return { models: [], error: 'Provider not found.' }; return providers.fetchModels(p, st.keys?.[id] || '', { force: !!force }); });
  h('providers:test', (id) => providers.test(id));
  h('models:list', (force) => models.catalog({ force: !!force }));
  h('conv:list', (q) => store.searchConversations(q));
  h('conv:get', (id) => store.getConversation(id));
  h('conv:new', (o) => store.newConversation(o));
  h('conv:update', (id, patch) => { const c = store.getConversation(id); for (const k of ['permissionMode', 'model', 'title', 'pinned', 'projectId', 'agentId', 'effort', 'fast', 'archived', 'closedAt']) if (k in patch) c[k] = patch[k]; store.saveConversation(c); return c; });
  h('conv:close', (id) => { const c = store.getConversation(id); c.archived = true; c.closedAt = Date.now(); store.saveConversation(c); });
  h('conv:reopen', () => { const m = store.lastClosed(); if (!m) return null; const c = store.getConversation(m.id); c.archived = false; c.closedAt = 0; store.saveConversation(c); return c; });
  h('conv:delete', async (id) => { const c = store.getConversation(id); term.kill(id); require('./acp').kill(id); bgtasks.stopAll(id); require('./checkpoints').drop(id); const r = c?.worktree ? await git.worktreeRemove(c.worktree) : null; store.deleteConversation(id); return r; });
  h('conv:export', async (id) => {
    const c = store.getConversation(id);
    const md = `# ${c.title}\n\n` + c.messages.map((m) => `**${m.role}**\n\n` + (typeof m.content === 'string' ? m.content
      : m.content.map((b) => b.type === 'text' ? b.text : b.type === 'tool_use' ? '`' + b.name + '` ' + JSON.stringify(b.input) : b.type === 'image' ? '[image]' : '```\n' + b.content + '\n```').join('\n\n'))).join('\n\n---\n\n');
    const w = focused();
    const r = await dialog.showSaveDialog(w, { defaultPath: c.title.replace(/[^\w ]/g, '') + '.md' });
    if (!r.canceled) fs.writeFileSync(r.filePath, md);
  });
  h('agent:send', async (id, text, images) => {
    const r = await modsGlue.host.promptSubmit(text);
    if (r.drop !== undefined) { emit({ type: 'info', convId: id, text: String(r.drop) }); emit({ type: 'done', convId: id }); return; }
    agent.send(id, r.text, emit, images || []);
  });
  h('agent:stop', (id) => agent.stop(id));
  h('agent:approve', (id, decision) => agent.answer(id, decision));
  h('agent:running', (id) => agent.isRunning(id));
  h('dialog:folder', async () => { const r = await dialog.showOpenDialog(focused(), { properties: ['openDirectory', 'createDirectory'] }); return r.canceled ? null : r.filePaths[0]; });
  h('dialog:confirm', async (message, detail, ok = 'Continue') => (await dialog.showMessageBox(focused(), { type: 'warning', message, detail, buttons: [ok, 'Cancel'], defaultId: 1, cancelId: 1 })).response === 0);
  h('git:status', (cwd) => git.status(cwd));
  h('git:diff', (cwd, file) => git.diff(cwd, file));
  h('ssh:hosts', () => { try { return [...new Set(fs.readFileSync(path.join(require('os').homedir(), '.ssh', 'config'), 'utf8').split('\n').flatMap((l) => { const m = l.match(/^\s*Host\s+(.+)$/i); return m ? m[1].split(/\s+/).filter((x) => x && !/[*?!]/.test(x)) : []; }))]; } catch { return []; } });
  h('ssh:test', async (host, dir) => {
    if (!/^[\w.@-]+$/.test(host || '')) return { ok: false, error: 'Invalid host.' };
    return new Promise((res) => { require('child_process').execFile('ssh', [...require('./tools').sshArgs(host), `cd '${String(dir).replace(/'/g, `'\\''`)}' && pwd`], { timeout: 20000 }, (e, out, err) => res(e ? { ok: false, error: (err || e.message).trim().slice(0, 200) } : { ok: true, cwd: out.trim() })); });
  });
  h('attach:pick', async () => { const r = await dialog.showOpenDialog(focused(), { properties: ['openFile', 'openDirectory', 'multiSelections'] }); return r.canceled ? [] : r.filePaths; });
  h('attach:read', (paths) => {
    const IMG = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
    return (paths || []).slice(0, 20).map((p) => {
      const name = path.basename(p);
      try {
        const st = fs.statSync(p);
        if (st.isDirectory()) { const list = []; const walk = (d, depth) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (['.git', 'node_modules', '.DS_Store'].includes(e.name) || list.length >= 200) continue; list.push(path.relative(p, path.join(d, e.name)) + (e.isDirectory() ? '/' : '')); if (e.isDirectory() && depth < 2) walk(path.join(d, e.name), depth + 1); } }; walk(p, 0); return { path: p, name, kind: 'dir', listing: list }; }
        const ext = path.extname(p).toLowerCase();
        if (IMG[ext] && st.size <= 5 * 1024 * 1024) return { path: p, name, kind: 'image', mediaType: IMG[ext], data: fs.readFileSync(p).toString('base64') };
        if (st.size <= 150 * 1024) { const buf = fs.readFileSync(p); if (!buf.includes(0)) return { path: p, name, kind: 'text', text: buf.toString('utf8'), size: st.size }; }
        return { path: p, name, kind: 'file', size: st.size };
      } catch (e) { return { path: p, name, kind: 'error', error: e.message }; }
    });
  });
  h('files:list', (cwd, rel) => {
    try {
      const root = path.resolve(cwd), dir = path.resolve(root, rel || '.');
      if (dir !== root && !dir.startsWith(root + path.sep)) return { error: 'Outside the project folder.' };
      return { entries: fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !['.git', 'node_modules', '.DS_Store'].includes(e.name)).map((e) => ({ name: e.name, dir: e.isDirectory() })).sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name)).slice(0, 300) };
    } catch (e) { return { error: e.message }; }
  });
  h('git:isRepo', (cwd) => git.isRepo(cwd));
  h('git:worktreeAdd', (cwd, name) => { const st = store.getSettings(); return git.worktreeAdd(cwd, name, { prefix: st.branchPrefix, dir: st.worktreeDir || undefined }); });
  h('git:worktreeList', (cwd) => git.worktreeList(cwd));

  // --- Terminal IPC ---
  const termSend = (id) => (m) => { for (const w of wins) if (!w.isDestroyed()) w.webContents.send('term:event', id, m); };
  h('term:open', (id, cwd, size, ssh) => term.open(id, cwd, termSend(id), size, ssh));
  h('term:input', (id, data) => term.input(id, data));
  h('term:resize', (id, cols, rows) => term.resize(id, cols, rows));
  h('term:run', (id, cwd, command) => term.run(id, cwd, command, termSend(id)));
  h('term:kill', (id) => term.kill(id));

  // --- MCP IPC ---
  h('mcp:status', () => mcp.status());
  h('mcp:list', () => mcp.list());
  h('mcp:save', (p) => mcp.saveServer(p));
  h('mcp:remove', (name) => mcp.removeServer(name));
  h('mcp:toggle', (name, disabled) => mcp.setDisabled(name, disabled));
  h('mcp:toolToggle', (name, tool, on) => mcp.setToolEnabled(name, tool, on));
  h('mcp:signIn', async (name) => { const r = await mcp.signIn(name, { open: (u) => shell.openExternal(u) }); const w = focused(); if (w && r.ok) { w.show(); w.focus(); } return r; });
  h('mcp:signOut', (name) => mcp.signOut(name));
  h('mcp:cancelSignIn', (name) => mcp.cancelSignIn(name));
  h('google:client', () => mcp.google.client());
  h('google:setClient', (p) => mcp.google.setClient(p));
  h('mcp:toolPolicy', (name, tools, policy) => mcp.setToolPolicy(name, tools, policy));
  h('mcp:restart', (name) => mcp.restartServer(name));
  h('mcp:test', (def) => mcp.testServer(def));
  h('mcp:import', (text, o) => mcp.importJson(text, o));
  h('mcp:config', () => mcp.readConfig());
  h('mcp:saveConfig', async (cfg) => { mcp.writeConfig(cfg); await mcp.startAll(); return mcp.status(); });

  // --- Skills IPC ---
  h('skills:list', () => skills.list());
  h('skills:import', async () => {
    const r = await dialog.showOpenDialog(focused(), { properties: ['openFile', 'openDirectory'], filters: [{ name: 'Skill', extensions: ['skill', 'zip'] }] });
    if (r.canceled) return null;
    try { return { id: skills.importBundle(r.filePaths[0]) }; } catch (e) { return { error: e.message }; }
  });
  h('skills:remove', (id) => skills.remove(id));

  // --- IPC: CLI import ---
  h('cli:import', () => importer.importAll());
  // --- IPC: find / find:stop ---
  h('find', (text, opts) => { const w = focused(); if (!w) return; if (!text) return w.webContents.stopFindInPage('clearSelection'); w.webContents.findInPage(text, opts); });
  h('find:stop', () => focused()?.webContents.stopFindInPage('clearSelection'));
  // --- IPC: window management ---
  h('window:new', (conv) => { createMain({ conv }); });
  h('app:build', () => ({ name: app.getName(), version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, platform: process.platform + ' ' + process.arch }));
  // --- IPC: quick entry ---
  h('quick:submit', (p) => submitQuick(p));
  h('quick:dismiss', () => quick?.hide());
  h('quick:skooch', (w, hgt) => skooch(w, hgt));

  // --- Memory ---
  h('memory:list', () => memory.list());
  h('memory:add', (t) => memory.add(t, 'user'));
  h('memory:update', (id, t) => memory.update(id, t));
  h('memory:remove', (id) => memory.remove(id));
  h('memory:clear', async () => { const r = await dialog.showMessageBox(focused(), { type: 'warning', message: 'Clear all memory?', detail: 'GrizzyCode forgets everything it has saved about you. This cannot be undone.', buttons: ['Clear memory', 'Cancel'], defaultId: 1, cancelId: 1 }); if (r.response !== 0) return null; return memory.clear(); });
  // --- Design systems ---
  h('agents:list', () => agents.list());
  h('agents:save', (p) => agents.save(p));
  h('agents:remove', (id) => agents.remove(id));
  h('agents:notes', (id) => agents.allNotes(id));
  h('agents:forgetNote', (id, scope, noteId) => { agents.forgetNote(id, scope, noteId); return agents.allNotes(id); });
  h('agents:clearNotes', (id, scope) => agents.clearNotes(id, scope));
  h('agents:schema', () => ({ gates: agents.GATE_INFO, guards: agents.GUARD_INFO }));
  h('ds:list', () => designsystems.list());
  h('ds:save', (p) => designsystems.save(p));
  h('ds:remove', (id) => designsystems.remove(id));
  h('ds:import', async () => {
    const r = await dialog.showOpenDialog(focused(), { properties: ['openFile'], filters: [{ name: 'Design system', extensions: ['md', 'txt', 'json'] }] });
    if (r.canceled) return null;
    try { if (fs.statSync(r.filePaths[0]).size > 500000) return { error: 'That file is too large.' }; return { draft: designsystems.parseImport(fs.readFileSync(r.filePaths[0], 'utf8'), path.basename(r.filePaths[0]).replace(/\.[^.]+$/, '')) }; } catch (e) { return { error: e.message }; }
  });
  // --- Plugins ---
  h('plugins:list', () => plugins.list());
  h('plugins:commands', () => plugins.commands());
  h('plugins:pick', async () => {
    const r = await dialog.showOpenDialog(focused(), { properties: ['openFile', 'openDirectory'], filters: [{ name: 'Plugin', extensions: ['plugin', 'zip'] }] });
    if (r.canceled) return null;
    const info = plugins.inspect(r.filePaths[0]); return info.error ? info : { ...info, src: r.filePaths[0] };
  });
  h('plugins:install', async (src) => plugins.install(src));
  h('plugins:remove', (name) => plugins.remove(name));
  // --- Markets ---
  const safe = (f) => async (...a) => { try { return await f(...a); } catch (e) { return { error: /fetch failed|timeout|abort/i.test(e.message) ? 'Could not reach the marketplace. Check your internet connection.' : e.message }; } };
  h('market:plugins', safe(async () => ({ items: await market.pluginCatalog() })));
  h('market:skills', safe(async () => ({ items: await market.skillCatalog() })));
  h('market:connectors', safe((o) => market.connectorSearch(o)));
  h('market:connectorFields', safe((id) => market.connectorFields(id)));
  h('market:installPlugin', safe((n) => market.installPlugin(n)));
  h('market:installSkill', safe((id) => market.installSkill(id)));
  h('market:installConnector', safe((id, v) => market.installConnector(id, v)));
  // --- Extensions ---
  h('ext:catalog', () => extensions.catalog());
  h('ext:install', (id, params) => extensions.install(id, params));
  h('ext:uninstall', (id) => extensions.uninstall(id));
  h('ext:pickBundle', async () => {
    const r = await dialog.showOpenDialog(focused(), { properties: ['openFile'], filters: [{ name: 'Extension', extensions: ['mcpb', 'dxt', 'zip'] }] });
    if (r.canceled) return null;
    const info = extensions.inspectBundle(r.filePaths[0]); return info.error ? info : { ...info, src: r.filePaths[0] };
  });
  h('ext:installBundle', (src) => extensions.installBundle(src));
  h('ext:openFolder', () => { fs.mkdirSync(extensions.dir(), { recursive: true }); return shell.openPath(extensions.dir()); });
  // --- Privacy / data ---
  h('privacy:export', async () => {
    const r = await dialog.showSaveDialog(focused(), { defaultPath: `grizzycode-export-${new Date().toISOString().slice(0, 10)}.json` });
    if (r.canceled) return null; fs.writeFileSync(r.filePath, JSON.stringify(dataops.exportAll(), null, 2)); return { path: r.filePath };
  });
  h('privacy:delete', async (scope) => {
    const msg = { conversations: ['Delete all conversations?', 'Every chat and code session, your projects and usage statistics are permanently deleted from this computer.'], memory: ['Clear all memory?', 'Saved memories are permanently deleted.'], everything: ['Delete all GrizzyCode data?', 'Conversations, memory, settings, saved API keys, skills, connectors and plugins are permanently deleted, and the app restarts. This cannot be undone.'] }[scope];
    if (!msg) return null;
    const r = await dialog.showMessageBox(focused(), { type: 'warning', message: msg[0], detail: msg[1], buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1 }); if (r.response !== 0) return null;
    const out = dataops.deleteData(scope); if (scope === 'everything') { app.relaunch(); app.exit(0); } else for (const w of wins) w.webContents.send('ui:command', 'dataChanged');
    return out;
  });
  h('billing:openrouter', () => dataops.openRouterCredits());
  // --- System ---
  h('system:status', () => ({ loginItem: app.getLoginItemSettings().openAtLogin, notifications: Notification.isSupported(), platform: process.platform, hardwareAccel: store.getSettings().hardwareAccel !== false }));
  h('system:testNotification', () => { if (!Notification.isSupported()) return { ok: false }; new Notification({ title: 'GrizzyCode', body: 'Notifications are working.', silent: !store.getSettings().notifySound }).show(); return { ok: true }; });
  h('system:relaunch', () => { app.relaunch(); app.exit(0); });
  // --- Developer ---
  h('dev:devtools', () => { const w = focused(); w?.webContents.openDevTools({ mode: 'detach' }); });
  h('dev:openLogs', () => { fs.mkdirSync(logger.dir(), { recursive: true }); return shell.openPath(logger.dir()); });
  h('dev:openSettingsFile', () => shell.showItemInFolder(path.join(store.root(), 'settings.json')));
  h('dev:openMcpConfig', () => { const p = mcp.configPath(); if (!fs.existsSync(p)) mcp.writeConfig(mcp.readConfig()); return shell.openPath(p); });
  h('dev:reloadMcp', async () => { await mcp.startAll(); return mcp.status(); });
  h('dev:report', async () => {
    const r = await dialog.showSaveDialog(focused(), { defaultPath: `grizzycode-diagnostics-${new Date().toISOString().slice(0, 10)}.json` });
    if (r.canceled) return null; fs.writeFileSync(r.filePath, JSON.stringify(dataops.diagnostics(app), null, 2)); return { path: r.filePath };
  });
  h('dev:clearCache', async () => { const r = await dialog.showMessageBox(focused(), { type: 'question', message: 'Clear cached web content and restart?', detail: 'Conversations and settings are kept.', buttons: ['Clear and restart', 'Cancel'], defaultId: 0, cancelId: 1 }); if (r.response !== 0) return null; await session.defaultSession.clearCache(); app.relaunch(); app.exit(0); return true; });
  h('dev:openMcpLog', () => { const f = path.join(logger.dir(), 'mcp.log'); fs.mkdirSync(logger.dir(), { recursive: true }); if (!fs.existsSync(f)) fs.writeFileSync(f, ''); shell.showItemInFolder(f); });
  // --- Storage, updates, feedback, permissions ---
  h('storage:usage', () => extras.usage(logger.dir()));
  h('storage:cleanWorktrees', async () => extras.reapWorktrees(0));
  h('app:checkUpdate', () => extras.checkUpdate(app.getVersion()));
  h('app:feedback', () => shell.openExternal(extras.feedbackUrl({ version: app.getVersion(), electron: process.versions.electron, platform: process.platform + ' ' + process.arch })));
  h('perm:status', () => extras.permissions(systemPreferences));
  h('perm:open', (key) => { const u = extras.permissionUrl(key); return u ? shell.openExternal(u) : null; });
  h('agent:suggest', (convId) => agent.suggest(convId));
  // --- Rewind, side chat, follow-ups, background tasks, @-mention search, split view ---
  h('conv:rewindPreview', (id, idx) => agent.rewindPreview(id, idx));
  h('conv:rewind', (id, idx, opts) => agent.rewind(id, idx, opts));
  h('conv:editText', (id, oldText, newText) => agent.editText(id, oldText, newText));
  h('agent:side', async (id, q, prior) => { try { return { text: await agent.side(id, q, prior || []) }; } catch (e) { return { error: e.message }; } });
  h('backlog:list', (id) => { try { return store.getConversation(id).backlog || []; } catch { return []; } });
  h('backlog:update', (id, itemId, patch) => {
    const c = store.getConversation(id); c.backlog = (c.backlog || []).flatMap((b) => (b.id !== itemId ? [b] : patch?.remove ? [] : [{ ...b, ...(typeof patch?.done === 'boolean' ? { done: patch.done } : {}) }]));
    store.saveConversation(c); return c.backlog;
  });
  h('tasks:list', (id) => bgtasks.list(id));
  h('tasks:output', (id, tail) => bgtasks.output(id, tail));
  h('tasks:stop', (id) => bgtasks.stop(id));
  h('tasks:clear', (id) => { bgtasks.clearFinished(id); return bgtasks.list(id); });
  h('files:search', (cwd, q) => extras.searchFiles(cwd, q));
  h('window:split', (convId, vertical) => splitWindow(convId, !!vertical));

  // === OS integration: scheduled notifications, dock, memory pressure, tray status, permissions, event log ===
  const sched = system.scheduler((title, body, id) => { if (!Notification.isSupported()) return; const n = new Notification({ title, body, silent: !store.getSettings().notifySound }); n.on('click', () => showMain()); n.show(); });
  h('notifications:schedule', (id, title, body, when) => sched.schedule(id, title, body, when));
  h('notifications:cancel', (id) => sched.cancel(id));
  h('notifications:permission', () => ({ granted: Notification.isSupported() }));
  h('quickAccess:badge', (badge) => { try { app.dock?.setBadge(String(badge ?? '').slice(0, 4)); return true; } catch { return false; } });
  h('quickAccess:clearBadge', () => { try { app.dock?.setBadge(''); return true; } catch { return false; } });
  h('quickAccess:recentTasks', (tasks) => { // the Dock menu lists the latest sessions; clicking one opens it
    try { const items = (Array.isArray(tasks) ? tasks : []).slice(0, 8).filter((t) => t && t.id).map((t) => ({ label: String(t.title || 'Session').slice(0, 60), click: () => { showMain(); cmd('open', String(t.id)); } })); app.dock?.setMenu(Menu.buildFromTemplate(items)); return items.length; } catch { return 0; }
  });
  h('memoryPressure:level', () => ({ level: system.memoryLevel() }));
  h('trayUsage:getUsage', () => { const m = app.getAppMetrics(); return { usageMb: Math.round(m.reduce((a, x) => a + (x.memory?.workingSetSize || 0), 0) / 1024), lastUpdate: Date.now() }; });
  h('trayUsage:setStatus', (status) => { try { tray?.setTitle(String(status || '').slice(0, 24)); return !!tray; } catch { return false; } });
  h('permissions:list', () => { const p = extras.permissions(systemPreferences); return { grants: p ? Object.entries(p).map(([tool, state]) => ({ tool, granted: state === 'granted', state })) : [] }; });
  h('permissions:get', (tool) => { const p = extras.permissions(systemPreferences); const state = p?.[tool]; return { granted: state === 'granted', state: state || 'unknown' }; });
  h('permissions:request', (tool) => { const u = extras.permissionUrl(tool); if (u) shell.openExternal(u); return { opened: !!u }; }); // macOS only lets the user grant these, in System Settings
  h('events:log', (entry) => system.logEvent(entry));
  h('search:messages', (query, convId) => system.searchMessages(store, query, convId));
  h('search:files', (query, cwd) => ({ results: extras.searchFiles(cwd, query, 30) }));

  // === Claude.app parity: Artifacts ===
  h('artifacts:list', async () => features.listArtifacts());
  h('artifacts:export', async (name, code) => { const r = await dialog.showSaveDialog(focused(), { defaultPath: name }); if (!r.canceled) fs.writeFileSync(r.filePath, code); return !r.canceled; });
  h('artifacts:preview', async (name, code) => { const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gc-art-')); const f = path.join(dir, path.basename(name).replace(/[^\w.-]/g, '_') || 'artifact.html'); fs.writeFileSync(f, localizeLibs(dir, code)); await shell.openPath(f); });
  // Saved artifacts (the model's `artifact` tool and the gallery): sandboxed windows, versions, builtin templates.
  h('artifacts:saved', async () => artifacts.list());
  h('artifacts:get', async (id) => { const a = artifacts.get(id); return a && { id: a.id, title: a.title, type: a.type, html: a.html, updatedAt: a.updatedAt, convId: a.convId, mcpTools: a.mcpTools || [] }; });
  h('artifacts:create', async (o) => { try { const a = artifacts.create({ title: o?.title, type: o?.type, html: o?.html, template: o?.template, convId: o?.convId }); return { id: a.id }; } catch (e) { return { error: e.message }; } });
  h('artifacts:open-saved', async (id) => artifacts.open(String(id)));
  h('artifacts:rename', async (id, title) => { try { artifacts.rename(String(id), String(title)); return true; } catch { return false; } });
  h('artifacts:remove', async (id) => artifacts.remove(String(id)));
  h('artifacts:versions', async (id) => artifacts.versions(String(id)));
  h('artifacts:restore', async (id, i) => { try { artifacts.restore(String(id), Number(i)); return true; } catch { return false; } });
  h('artifacts:templates', async () => ({ templates: artifacts.templates(), types: artifacts.types() }));
  h('artifacts:save-html', async (id) => { const a = artifacts.get(String(id)); if (!a) return false; const r = await dialog.showSaveDialog(focused(), { defaultPath: a.title.replace(/[^\w. -]+/g, '_') + '.html' }); if (r.canceled) return false; fs.writeFileSync(r.filePath, artifacts.standalone(a.id)); return true; });
  h('artifacts:open-browser', async (id) => { const a = artifacts.get(String(id)); if (!a) return false; const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gc-art-')); const f = path.join(dir, 'artifact.html'); fs.writeFileSync(f, artifacts.standalone(a.id)); await shell.openPath(f); return true; });
  h('projects:list', () => store.listProjects());
  h('projects:save', (p) => store.saveProject(p));
  h('projects:delete', (id) => store.deleteProject(id));
  h('projects:chats', (id) => store.listConversations(true).filter((c) => c.projectId === id));
  h('schedules:list', () => features.listSchedules());
  h('schedules:save', (p) => features.saveSchedule(p));
  h('schedules:delete', (id) => features.removeSchedule(id));
  h('schedules:run', (id) => features.runSchedule(id));
  h('dispatch:list', () => features.listDispatch());
  h('dispatch:start', (o) => { try { return features.startDispatch(o); } catch (e) { return { error: e.message }; } });
  h('dispatch:stop', (id) => features.stopDispatch(id));
  h('dispatch:delete', (id) => features.removeDispatch(id));
  // Opens a file the Files pane lists. Only plain existing files, never programs, app bundles or installers.
  h('artifacts:open', async (filePath) => { try { const p = path.resolve(String(filePath)); if (!fs.statSync(p).isFile() || /\.(app|command|tool|workflow|scpt|pkg|dmg|exe|bat|cmd|msi|jar|terminal|webloc|inetloc)$/i.test(p) || (fs.statSync(p).mode & 0o111)) return false; return (await shell.openPath(p)) === ''; } catch { return false; } });

  // === Claude.app parity: Buddy ===
  h('buddy:visible', async () => { return { visible: quick && !quick.isDestroyed() && quick.isVisible() }; });
  h('buddy:toggle', async () => {
    if (quick && !quick.isDestroyed()) { quick.isVisible() ? quick.hide() : quick.show(); }
  });

  h('search:conversations', (query) => store.searchConversations(query));

  // === Claude.app parity: Appearance ===
  h('appearance:theme', async () => store.getSettings().theme || 'system');
  h('appearance:setTheme', async (theme) => { const s = store.saveSettings({ theme }); nativeTheme.themeSource = themes.nativeSource(s); return true; });
  h('themes:list', async () => ({ themes: themes.THEMES, accents: themes.ACCENTS, accentVars: Object.fromEntries([...themes.ACCENTS.map((a) => a.color), ...themes.THEMES.map((t) => t.accent)].map((c) => [c, themes.accentVars(c)])) }));
  h('themes:accentVars', async (c) => (themes.accentColor(c) ? themes.accentVars(themes.accentColor(c)) : null));
  h('appearance:colorScheme', async () => nativeTheme.shouldUseDarkColors ? 'dark' : 'light');

  // === Push-channel emitters (parity with Claude.app's 238 renderer listeners) ===
  // Forward IPC events from main to all renderer listeners.
  const push = (ch, ...a) => { for (const w of wins) if (!w.isDestroyed()) w.webContents.send(ch, ...a); };
  onEvt('agent:event', (ev) => push('agent:event', ev));
  onEvt('term:event', (id, m) => push('term:event', id, m));
  onEvt('quick:reset', () => push('quick:reset'));
  onEvt('ui:command', (ch, ...a) => push('ui:command', ch, ...a));
  onEvt('permissions:update', (tool, state) => push('permissions:update', tool, state));
  onEvt('events:stream', (ev) => push('events:stream', ev));
  onEvt('buddy:message', (msg) => push('buddy:message', msg));
  onEvt('memoryPressure:event', (level) => push('memoryPressure:event', level));
  { let last = system.memoryLevel(); setInterval(() => { const l = system.memoryLevel(); if (l !== last) { last = l; push('memoryPressure:event', l); } }, 30000).unref(); } // the same event Claude.app raises, from RAM use
  onEvt('appearance:change', (theme) => push('appearance:change', theme));

  
}

app.setName('GrizzyCode');
// All settings, data, caches, logs and native mods live in ~/.GrizzyCode. Copy anything from the old locations the first time.
{
  const home = require('os').homedir(), root = path.join(home, '.GrizzyCode');
  const oldUser = path.join(app.getPath('appData'), 'GrizzyCode'), oldMods = path.join(home, '.claude', 'grizzycode', 'mods');
  try { fs.mkdirSync(root, { recursive: true }); } catch {}
  try { if (!fs.existsSync(path.join(root, 'data')) && fs.existsSync(path.join(oldUser, 'data'))) fs.cpSync(path.join(oldUser, 'data'), path.join(root, 'data'), { recursive: true }); } catch {}
  try { if (!fs.existsSync(path.join(root, 'mods')) && fs.existsSync(oldMods)) fs.cpSync(oldMods, path.join(root, 'mods'), { recursive: true }); } catch {}
  app.setPath('userData', root);
  app.setPath('logs', path.join(root, 'logs'));
}
const APP_ICON = path.join(__dirname, '..', 'assets', 'icon.png');
logger.init();
// Hardware acceleration must be decided before the app is ready, so read the raw settings file.
try { if (JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'data', 'settings.json'), 'utf8')).hardwareAccel === false) app.disableHardwareAcceleration(); } catch {}
artifacts.registerScheme(protocol);
// grizzycode:// deep links: queued until the first window can take them (cold start), then forwarded to the renderer.
let pendingLink = null, appReady = false;
function handleLink(raw) {
  const l = shell_.parseDeepLink(raw); if (!l) return;
  if (!appReady) { pendingLink = raw; return; }
  showMain();
  const w = focused(), send = () => { if (l.type === 'new') cmd('deepNew', l.text, l.mode); else if (l.type === 'open') cmd('open', l.id); else cmd('settings'); };
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', () => setTimeout(send, 150)); else send();
}
try { if (app.isPackaged) app.setAsDefaultProtocolClient(shell_.SCHEME); else if (process.defaultApp && process.argv[1]) app.setAsDefaultProtocolClient(shell_.SCHEME, process.execPath, [path.resolve(process.argv[1])]); } catch {}
app.on('open-url', (e, url) => { e.preventDefault(); handleLink(url); });
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (_e, argv) => { showMain(); for (const a of argv) if (a.startsWith(shell_.SCHEME + '://')) handleLink(a); });
app.whenReady().then(() => {
  shell_.lockSession(session.defaultSession);
  try { if (store.heal()) console.warn('Repaired settings: the saved key did not match the selected endpoint.'); } catch {}
  nativeTheme.themeSource = themes.nativeSource(store.getSettings());
  try { app.dock?.setIcon(nativeImage.createFromPath(APP_ICON)); } catch {}
  try { skills.seedBundled(); } catch (e) { console.error('seeding bundled skills failed:', e.message); }
  ipc();
  artifacts.init({ electron: { session, ipcMain, dialog, shell, BrowserWindow, nativeTheme }, onChange: (m, kind) => {
    for (const w of wins) if (!w.isDestroyed()) w.webContents.send('artifacts:update', m, kind);
    if (kind === 'create') artifacts.open(m.id); else if (kind === 'update') artifacts.refresh(m.id);
  } });
  modsGlue.setup({ ipcMain, store, mcp, models, llm, tools: require('./tools'), logger, app, dialog, Notification, wins, showMain, focused });
  modsGlue.host.startEnabled().catch((e) => console.warn('mods failed to start:', e.message));
  features.init({ emit, broadcast: (ch, ...a) => { for (const w of wins) if (!w.isDestroyed()) w.webContents.send(ch, ...a); } }); buildMenu(); syncTray(); registerShortcut(); createMain();
  appReady = true; { const l = pendingLink || process.argv.find((a) => a.startsWith(shell_.SCHEME + '://')); pendingLink = null; if (l) handleLink(l); }
  mcp.startAll().catch(() => {});
  const purge = () => { try { dataops.purgeOld(store.getSettings().retentionDays); } catch {} }; purge(); setInterval(purge, 6 * 3600 * 1000);
  housekeeping(); setInterval(housekeeping, 6 * 3600 * 1000);
  bgtasks.setNotifier((ev) => { for (const w of wins) if (!w.isDestroyed()) w.webContents.send('agent:event', ev); });
  app.on('browser-window-focus', () => { try { app.dock?.setBadge(''); } catch {} });
  setTimeout(async () => {
    const st = store.getSettings(); if (!st.checkUpdates) return;
    const r = await extras.checkUpdate(app.getVersion());
    if (r.newer && Notification.isSupported() && st.lastUpdateNotified !== r.latest) {
      store.saveSettings({ lastUpdateNotified: r.latest });
      const n = new Notification({ title: 'GrizzyCode update available', body: `Version ${r.latest} is out (you have ${r.current}).` });
      n.on('click', () => shell.openExternal(r.url)); n.show();
    }
  }, 15000);
  app.on('activate', () => { if (!wins.size) createMain(); else showMain(); });
});
app.on('will-quit', () => { bgtasks.stopAll(); features.stop(); term.killAll(); modsGlue.host.stopAll(); globalShortcut.unregisterAll(); mcp.stopAll(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin' || !store.getSettings().runInTray) app.quit(); });