// Run with: npx electron scripts/ui-check.js   (drives the Projects page in a hidden window against an in-memory fake `gc`)
const { app, BrowserWindow } = require('electron');
const path = require('path');
let failed = 0;
const assert = (c, m) => { if (!c) { failed++; console.error('FAIL', m); return; } console.log('ok  ', m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'ui-preload.js'), contextIsolation: false, nodeIntegration: false, sandbox: false } });
  const errs = []; w.webContents.on('console-message', (e) => { if (e.level === 'error' && /pages\.js/.test(e.sourceId || '')) errs.push(e.message); }); // other renderer errors come from the fake bridge's empty stubs
  w.webContents.on('preload-error', (_e, p, e) => errs.push('preload: ' + e.message));
  await w.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(800);
  const run = (js) => w.webContents.executeJavaScript(js);
  const click = (sel) => run(`document.querySelector(${JSON.stringify(sel)}).click()`);
  const text = () => run(`document.getElementById('page').innerText`);
  const set = (sel, v) => run(`document.querySelector(${JSON.stringify(sel)}).value = ${JSON.stringify(v)}`);

  assert(!(await run(`document.getElementById('nProjects').innerText`)).includes('Beta'), 'Projects nav has no Beta badge');
  await click('#nProjects'); await sleep(150);
  let t = await text();
  assert(/How projects work/.test(t) && /Create one to get started/.test(t), 'empty Projects page shows the how-to and empty state');

  await click('#pNew'); await sleep(100);
  await set('#pName', 'Docs'); await set('#pInst', 'Be terse.');
  await click('#pPick'); await sleep(100);
  assert((await run(`document.getElementById('pFolder').textContent`)) === '/tmp/picked', 'folder picker fills the folder');
  await click('#pSave'); await sleep(150);
  assert(/Docs/.test(await text()) && (await run('__ui.db.projects[0].folder')) === '/tmp/picked', 'save stores the project with its folder');

  await click('#pChat'); await sleep(200);
  const created = await run('__ui.log.find((l) => l[0] === "create")');
  assert(created && created[1].mode === 'code' && created[1].cwd === '/tmp/picked' && created[1].projectId === (await run('__ui.db.projects[0].id')), 'new chat in a project with a folder starts a code session with projectId');

  // a closed chat still appears on the project page and reopens when clicked
  await run(`__ui.db.convs[0].archived = true; __ui.db.convs[0].title = 'Old thread'`);
  await run(`document.getElementById('nProjects').click()`); await sleep(50);
  await run(`document.getElementById('nArtifacts').click()`); await sleep(50);
  await click('#nProjects'); await sleep(150); await click('.card2'); await sleep(150);
  t = await text();
  assert(/Old thread/.test(t) && /closed/.test(t), 'closed chats are listed on the project page');
  await click('.rowi'); await sleep(150);
  assert((await run('__ui.db.convs[0].archived')) === false, 'clicking a closed chat reopens it');

  await click('#nProjects'); await sleep(100); await click('.card2'); await sleep(150);
  await click('#pDel'); await sleep(200);
  assert((await run('__ui.db.projects.length')) === 0 && (await run('__ui.db.convs[0].projectId')) === null, 'delete removes the project and detaches its chats');
  assert(!errs.length, 'no errors from the pages script' + (errs.length ? ': ' + errs[0] : ''));
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED'); app.exit(failed ? 1 : 0);
});
