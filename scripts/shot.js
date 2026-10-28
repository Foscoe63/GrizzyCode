// Renders the real UI headlessly with seeded data and writes PNGs. Usage: npx electron scripts/shot.js <outDir> [dark]
const { app, BrowserWindow, nativeTheme, ipcMain } = require('electron');
const path = require('path'); const fs = require('fs'); const os = require('os');
const out = process.argv[2] || os.tmpdir(); const dark = process.argv[3] === 'dark';
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'gc-shot-')));
const store = require('../src/main/store'); const git = require('../src/main/git'); const mcp = require('../src/main/mcp'); const skills = require('../src/main/skills');
const preload = path.join(__dirname, '..', 'src', 'preload.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
app.whenReady().then(async () => {
  const h = (n, f) => ipcMain.handle(n, (_e, ...a) => f(...a));
  h('settings:get', () => store.getSettings()); h('settings:set', (p) => store.saveSettings(p)); h('usage:get', () => ({ total: { in: 52000, out: 9100 }, days: { '2026-10-15': { in: 4000, out: 900 }, '2026-10-17': { in: 12000, out: 2000 }, '2026-10-19': { in: 20000, out: 4000 }, '2026-10-21': { in: 16000, out: 2200 } } }));
  h('conv:list', (q) => store.searchConversations(q)); h('conv:get', (id) => store.getConversation(id)); h('conv:update', (id, p) => Object.assign(store.getConversation(id), p));
  h('git:status', (c) => git.status(c)); h('git:diff', (c, f) => git.diff(c, f)); h('mcp:config', () => ({ mcpServers: {} })); h('skills:list', () => []);
  const now = Date.now();
  h('projects:list', () => [{ id: 'p1', name: 'Website redesign', instructions: 'Keep copy short and friendly. Use the brand palette.', folder: null, chats: 3, updatedAt: now }, { id: 'p2', name: 'Tax prep', instructions: '', folder: null, chats: 0, updatedAt: now - 1e6 }]);
  h('artifacts:list', () => [{ id: 'a1', convId: 'x', title: 'Landing page', name: 'html snippet', lang: 'html', lines: 12, preview: true, code: '<h1 style="font-family:sans-serif">Hello</h1><p>Preview</p>', updatedAt: now }, { id: 'a2', convId: 'x', title: 'Rate limiter', name: 'limiter.js', lang: 'js', lines: 20, preview: false, code: 'const x = 1;\nmodule.exports = x;', updatedAt: now - 5 }]);
  h('schedules:list', () => [{ id: 's1', name: 'Morning summary', prompt: 'x', mode: 'chat', every: 'weekdays', time: '09:00', minutes: 60, enabled: true, nextRun: now + 3.6e6, lastRun: now - 8.6e7, lastStatus: 'ok', lastConvId: 'x' }]);
  h('dispatch:list', () => [{ id: 'd1', prompt: 'Add unit tests for the auth module', cwd: '/tmp/api', permissionMode: 'acceptEdits', convId: 'x', status: 'running', createdAt: now - 6e4 }, { id: 'd2', prompt: 'Update the README', cwd: '/tmp/api', permissionMode: 'plan', convId: 'x', status: 'done', createdAt: now - 9e6 }]);
  h('mcp:status', () => []);
  { const th = require('../src/main/themes'); h('themes:list', () => ({ themes: th.THEMES, accents: th.ACCENTS, accentVars: Object.fromEntries([...th.ACCENTS.map((a) => a.color), ...th.THEMES.map((t) => t.accent)].map((c) => [c, th.accentVars(c)])) })); h('themes:accentVars', (c) => (th.accentColor(c) ? th.accentVars(th.accentColor(c)) : null)); }
  nativeTheme.themeSource = dark ? 'dark' : 'light';
  const w0 = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-')); require('child_process').execSync('git init -q && echo hi > a.js && git add -A && git -c user.email=a@b -c user.name=t commit -qm i && echo "const x = 2;" >> a.js', { cwd: w0 });
  store.saveSettings({ trustedFolders: [w0], pinnedFolders: [w0] });
  store.newConversation({ mode: 'chat' });
  const a = store.newConversation({ mode: 'code', cwd: w0 });
  a.title = 'Refactor the auth middleware'; a.usage = { in: 12000, out: 2300 };
  a.messages = [
    { role: 'user', content: 'Can you add rate limiting to the login route?' },
    { role: 'assistant', content: [{ type: 'text', text: "I'll look at the route first.\n\n## Plan\n- Read `routes/login.js`\n- Add a **token bucket** limiter\n\n```js\nconst limiter = rateLimit({ max: 5 });\n```" }, { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'routes/login.js' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '1\tmodule.exports = {}' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Done — the limiter is wired in.' }] }];
  store.saveConversation(a);
  const b = store.newConversation({ mode: 'chat' }); b.title = 'Trip ideas for Lisbon'; b.messages = [{ role: 'user', content: 'hi' }]; store.saveConversation(b);
  const win = new BrowserWindow({ width: 1180, height: 780, show: false, backgroundColor: dark ? '#20201f' : '#f9f9f7', webPreferences: { preload, sandbox: true } });
  win.webContents.on('console-message', (e, level, msg) => { if (level >= 2) errors.push(msg); });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), { query: { conv: a.id } });
  await wait(900);
  await win.webContents.executeJavaScript(`document.body.classList.add('diff');document.getElementById('diffBtn').classList.add('on');document.getElementById('diffRefresh').click();document.getElementById('input').value='/p';document.getElementById('input').dispatchEvent(new Event('input'));0`);
  await wait(900);
  fs.writeFileSync(path.join(out, 'main.png'), (await win.webContents.capturePage()).toPNG());
  const snap = async (name) => { await wait(500); fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
  const js = (c) => win.webContents.executeJavaScript(c + ';0');
  await js(`document.getElementById('input').value='';document.getElementById('input').dispatchEvent(new Event('input'));document.body.classList.remove('diff');document.getElementById('nNew').click()`);
  await snap('code-home');
  await js(`document.getElementById('viewChat').click()`); await snap('chat-home');
  await js(`document.getElementById('openSettings').click();document.querySelector('#settings [data-tab=general]').click()`); await snap('settings');
  await js(`document.querySelector('#settings [data-tab=appearance]').click()`); await wait(300); await snap('settings-appearance');
  await js(`document.querySelector('#themeGrid .th:nth-child(10)').click()`); await wait(500); await snap('settings-appearance-nord');
  await js(`document.querySelector('#themeGrid .th:nth-child(1)').click()`); await wait(300);
  await js(`document.querySelector('#settings [data-tab=provider]').click()`); await snap('settings-provider');
  await js(`document.querySelector('#settings [data-tab=general] ').click();document.querySelector('#settings [data-tab=appearance]').click();document.querySelector('#settings .seg[data-for=sTheme] [data-v=light]').click();document.querySelector('#settings [data-tab=general]').click();document.querySelector('#settings .seg[data-for=sMode] [data-v=plan]').click();const t=document.getElementById('sTray');t.checked=false;t.dispatchEvent(new Event('change'));document.querySelector('#settings [data-tab=provider]').click();const m=document.getElementById('sMaxTok');m.value='999999';m.dispatchEvent(new Event('change'));const b=document.getElementById('sBase');b.value=' http://x.test ';b.dispatchEvent(new Event('change'))`);
  await wait(400); { const g = store.getSettings(); console.log('AUTOSAVE', JSON.stringify([g.theme, g.permissionMode, g.runInTray, g.maxTokens, g.baseUrl])); store.saveSettings({ theme: 'system', permissionMode: 'default', runInTray: true, maxTokens: 8192, baseUrl: '' }); }
  await js(`document.getElementById('sCancel').click()`);
  for (const [id, name] of [['nProjects', 'projects'], ['nArtifacts', 'artifacts'], ['nScheduled', 'scheduled'], ['nDispatch', 'dispatch'], ['nCustomize', 'customize']]) { await js(`document.getElementById('${id}').click()`); await wait(400); await snap('page-' + name); }
  await js(`document.getElementById('viewCode').click()`);
  const q = new BrowserWindow({ width: 606, height: 470, show: false, transparent: true, frame: false, webPreferences: { preload, sandbox: true } });
  await q.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'quick.html')); await wait(400);
  fs.writeFileSync(path.join(out, 'quick.png'), (await q.webContents.capturePage()).toPNG());
  console.log('SMODEL', JSON.stringify(await win.webContents.executeJavaScript("[document.getElementById('sModel').value, document.getElementById('sTheme').value, document.getElementById('sShortcut').value]")));
  console.log('ERRORS', JSON.stringify(errors)); app.exit(0);
});
