// Sidebar pages: Projects, Artifacts, Scheduled, Dispatch, Customize. Share app.js's globals ($, esc, gc, settings, open, newCode, toast, …).
const TITLES = { projects: 'Projects', artifacts: 'Artifacts', scheduled: 'Scheduled', dispatch: 'Dispatch', grizzywork: 'GrizzyWork', customize: 'Customize' };
const NAV = { nProjects: 'projects', nArtifacts: 'artifacts', nScheduled: 'scheduled', nDispatch: 'dispatch', nGrizzyWork: 'grizzywork', nCustomize: 'customize' };
let pageName = null, projSel = null, schedSel = null, artSel = null, savedSel = null, artTab = 'saved', artQuery = '', artFilter = 'all', dispDraft = { prompt: '', cwd: null, mode: 'acceptEdits' };
const P = (sel) => $('page').querySelector(sel);
const when = (t) => (t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
const folderName = (f) => (f ? f.split('/').pop() || f : '');
const shell = (title, actions, body) => `<div class="pg"><div class="pg-head"><h1>${esc(title)}</h1><span class="grow"></span>${actions || ''}</div>${body}</div>`;

async function ensureTrusted(cwd) {
  if (settings.trustedFolders.includes(cwd)) return true;
  if (!(await gc.confirm(`Trust ${cwd} and start a code session?`, 'GrizzyCode can read files in this folder and, depending on the permission mode, edit files and run commands here.', 'Trust folder'))) return false;
  settings = await gc.settings.set({ trustedFolders: [...settings.trustedFolders, cwd] }); return true;
}
function showPage(name) {
  if (name === 'grizzywork' && pageName !== 'grizzywork') { cwTask = null; cwFile = null; cwDraft.folder = null; }
  pageName = name; document.body.classList.add('paged');
  for (const [id, p] of Object.entries(NAV)) $(id).classList.toggle('on', p === name);
  $('nNew').classList.remove('on'); $('title').textContent = TITLES[name]; $('branch').hidden = true;
  document.querySelectorAll('#list .item').forEach((e) => e.classList.remove('on'));
  renderPage();
}
function hidePage() {
  if (!pageName) return; pageName = null; document.body.classList.remove('paged');
  for (const id of Object.keys(NAV)) $(id).classList.remove('on');
}
const renderPage = () => ({ projects: pgProjects, artifacts: pgArtifacts, scheduled: pgScheduled, dispatch: pgDispatch, grizzywork: pgGrizzyWork, customize: pgCustomize }[pageName]?.());
for (const [id, name] of Object.entries(NAV)) $(id).onclick = () => { if (pageName === name) return; if (name === 'projects') projSel = null; if (name === 'scheduled') schedSel = null; showPage(name); };
gc.onFeatures((n) => { if ((n === 'schedules' && pageName === 'scheduled' && !schedSel) || (n === 'dispatch' && pageName === 'dispatch') || (n === 'grizzywork' && pageName === 'grizzywork' && !cwEditing)) renderPage(); });

// ---------------- Projects ----------------
async function pgProjects() {
  const list = await gc.projects.list();
  if (projSel === null) {
    $('page').innerHTML = shell('Projects', '<button class="primary" id="pNew">New project</button>',
      (list.length ? `<div class="cards">${list.map((p) => `<div class="card2" data-id="${p.id}"><b>${esc(p.name)}</b><p>${esc(p.instructions.slice(0, 110) || 'No instructions')}</p><i>${p.chats} chat${p.chats === 1 ? '' : 's'}${p.folder ? ' · ' + esc(folderName(p.folder)) : ''}</i></div>`).join('')}</div>`
        : '<div class="pg-empty">Projects group related chats and give them shared instructions.<br>Create one to get started.</div>') + `<div class="pg-how" id="pHow"><h3>How projects work</h3><ol><li>Click <b>New project</b> and give it a name.</li><li>Write <b>instructions</b>: tone, context and rules. They are added to every chat in the project.</li><li>Optionally pick a <b>default folder</b>. Chats then start as code sessions there.</li><li>Press <b>Save</b>, then <b>New chat in project</b>. Chats you start from the project stay listed on its page, including closed ones.</li></ol><p class="hint">Deleting a project keeps its chats; they just lose the project instructions.</p></div>`);
    P('#pNew').onclick = () => { projSel = 'new'; pgProjects(); };
    $('page').querySelectorAll('.card2').forEach((c) => (c.onclick = () => { projSel = c.dataset.id; pgProjects(); }));
    return;
  }
  const p = projSel === 'new' ? { id: null, name: '', instructions: '', folder: null, chats: 0 } : list.find((x) => x.id === projSel);
  if (!p) { projSel = null; return pgProjects(); }
  const convs = p.id ? await gc.projects.chats(p.id) : [];
  $('page').innerHTML = shell(p.id ? p.name : 'New project', `<button class="outline" id="pBack">← All projects</button>`, `
    <label class="fld">Name<input id="pName" value="${esc(p.name)}" placeholder="e.g. Website redesign"></label>
    <label class="fld">Instructions<textarea id="pInst" rows="7" placeholder="How should GrizzyCode behave in this project? Tone, context, rules…">${esc(p.instructions)}</textarea></label>
    <div class="fld">Default folder <span class="hint">(optional — chats become code sessions in this folder)</span>
      <div class="inl"><code id="pFolder">${esc(p.folder || 'None')}</code><button class="outline" id="pPick">Choose…</button>${p.folder ? '<button class="outline" id="pClear">Clear</button>' : ''}</div></div>
    <div class="pg-actions"><button class="primary" id="pSave">Save</button>${p.id ? '<button class="outline" id="pChat">New chat in project</button><span class="grow"></span><button class="outline danger" id="pDel">Delete project</button>' : ''}</div>
    ${p.id ? `<h3>Chats in this project</h3>${convs.length ? convs.map((c) => `<div class="rowi" data-id="${c.id}" data-closed="${c.archived ? 1 : ''}"><span>${esc(c.title)}</span><i>${c.archived ? 'closed · ' : ''}${when(c.updatedAt)}</i></div>`).join('') : '<p class="hint">No chats yet.</p>'}` : ''}`);
  let folder = p.folder;
  P('#pBack').onclick = () => { projSel = null; pgProjects(); };
  P('#pPick').onclick = async () => { const f = await gc.pickFolder(); if (f) { folder = f; P('#pFolder').textContent = f; } };
  P('#pClear')?.addEventListener('click', () => { folder = null; P('#pFolder').textContent = 'None'; });
  const save = async () => { const r = await gc.projects.save({ id: p.id, name: P('#pName').value, instructions: P('#pInst').value, folder }); projSel = r.id; return r; };
  P('#pSave').onclick = async () => { await save(); toast('Project saved'); pgProjects(); };
  if (p.id) {
    P('#pChat').onclick = async () => {
      const r = await save();
      if (r.folder) { if (!(await ensureTrusted(r.folder))) return; setView('code', false); const c = await gc.conv.create({ mode: 'code', cwd: r.folder, projectId: r.id }); await open(c.id); }
      else { setView('chat', false); const c = await gc.conv.create({ mode: 'chat', projectId: r.id }); await open(c.id); }
    };
    P('#pDel').onclick = async () => { if (await gc.confirm(`Delete “${p.name}”?`, 'Its chats are kept but lose the project instructions.', 'Delete')) { await gc.projects.remove(p.id); projSel = null; pgProjects(); } };
    $('page').querySelectorAll('.rowi').forEach((r) => (r.onclick = async () => { if (r.dataset.closed) await gc.conv.update(r.dataset.id, { archived: false, closedAt: 0 }); open(r.dataset.id); }));
  }
}

// ---------------- Artifacts ----------------
// Saved artifacts run in their own sandboxed window (no network; bridge to the app). Templates are the built-in starters. "From chats" lists code blocks found in conversations.
const ART_ICON = { page: '▢', dashboard: '▥', slides: '▭', doc: '☰', design: '✎', tracker: '☑', diagram: '⌬' };
async function pgArtifacts() {
  const tab = artTab;
  const tabs = `<div class="seg" id="aT">${[['saved', 'Saved'], ['templates', 'Templates'], ['chats', 'From chats']].map(([v, l]) => `<button type="button" data-v="${v}" class="${tab === v ? 'on' : ''}">${l}</button>`).join('')}</div><button id="aNew">+ New artifact</button>`;
  if (tab === 'saved') await artSaved(tabs); else if (tab === 'templates') await artTemplates(tabs); else await artChats(tabs);
  $('page').querySelectorAll('#aT button').forEach((b) => (b.onclick = () => { artTab = b.dataset.v; pgArtifacts(); }));
  P('#aNew').onclick = newArtifactDialog;
}
const BLANK_HTML = (t) => `<!doctype html>\n<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t.replace(/[<&]/g, '')}</title>\n<style>body{font:16px system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:32px}</style></head>\n<body><h1>${t.replace(/[<&]/g, '')}</h1><p>Start here. Ask GrizzyCode in a chat to build this out.</p></body></html>`;
async function newArtifactDialog() {
  const { templates, types } = await gc.artifacts.templates();
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:50';
  d.innerHTML = `<div class="card3" style="width:480px;max-width:90vw;padding:20px;display:flex;flex-direction:column;gap:10px"><h3 style="margin:0">New artifact</h3>
    <input id="nTitle" placeholder="Title"><select id="nType">${types.map((t) => `<option value="${esc(t.key)}">${esc(t.title)}</option>`).join('')}</select>
    <select id="nTpl"><option value="">Blank page</option>${templates.map((t) => `<option value="${esc(t.key)}">Template: ${esc(t.title)}</option>`).join('')}</select>
    <textarea id="nHtml" rows="6" placeholder="…or paste HTML (optional)" style="font-family:monospace"></textarea>
    <label class="hint">…or import an .html file <input id="nFile" type="file" accept=".html,.htm,text/html"></label>
    <div class="pg-actions"><span class="grow"></span><button class="outline" id="nCancel">Cancel</button><button id="nOk">Create</button></div></div>`;
  document.body.appendChild(d);
  const q = (s) => d.querySelector(s);
  q('#nTitle').focus();
  q('#nFile').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; q('#nHtml').value = await f.text(); if (!q('#nTitle').value) q('#nTitle').value = f.name.replace(/\.html?$/i, ''); };
  q('#nTpl').onchange = (e) => { const t = templates.find((x) => x.key === e.target.value); if (t) q('#nType').value = t.type; };
  q('#nCancel').onclick = () => d.remove();
  d.onclick = (e) => { if (e.target === d) d.remove(); };
  q('#nOk').onclick = async () => {
    const title = q('#nTitle').value.trim() || 'Untitled artifact', html = q('#nHtml').value.trim(), template = q('#nTpl').value;
    const r = await gc.artifacts.create(html ? { title, type: q('#nType').value, html } : template ? { title, template } : { title, type: q('#nType').value, html: BLANK_HTML(title) });
    if (r.error) return toast(r.error);
    d.remove(); savedSel = r.id; artTab = 'saved'; toast('Created'); pgArtifacts();
  };
}
async function artSaved(tabs) {
  const all = await gc.artifacts.saved();
  const q = artQuery.toLowerCase();
  const list = all.filter((a) => !q || (a.title + a.type).toLowerCase().includes(q));
  const sel = list.find((a) => a.id === savedSel) || list[0];
  let full = null, vers = [];
  if (sel) { full = await gc.artifacts.get(sel.id); vers = await gc.artifacts.versions(sel.id); }
  $('page').innerHTML = shell('Artifacts', `<input id="aQ" placeholder="Search artifacts" value="${esc(artQuery)}">${tabs}`,
    all.length ? `<div class="split"><div class="alist">${list.map((a) => `<div class="rowi ${sel?.id === a.id ? 'on' : ''}" data-id="${esc(a.id)}"><span><b>${ART_ICON[a.type] || '▢'} ${esc(a.title)}</b><br><i>${esc(a.type)} · ${when(a.updatedAt)}</i></span></div>`).join('') || '<p class="hint">No matches.</p>'}</div>
      <div class="aview">${sel ? `<div class="pg-actions"><b>${esc(sel.title)}</b><span class="grow"></span><button id="sOpen">Open</button><button class="outline" id="sRen">Rename</button><button class="outline" id="sBrowser">Open in browser</button><button class="outline" id="sSave">Export HTML…</button>${sel.convId ? '<button class="outline" id="sConv">Go to chat</button>' : ''}<button class="outline danger" id="sDel">Delete</button></div>
        <p class="hint">${esc(sel.type)} · ${(sel.bytes / 1024).toFixed(1)} KB · ${sel.versions} earlier version${sel.versions === 1 ? '' : 's'}${sel.mcpTools.length ? ` · allowed tools: ${esc(sel.mcpTools.join(', '))}` : ''}</p>
        ${vers.length ? `<details><summary>Version history</summary>${vers.map((v) => `<div class="rowi" style="cursor:default"><span>${when(v.at)} · ${esc(v.label || 'update')} · ${(v.bytes / 1024).toFixed(1)} KB</span><button class="outline" data-restore="${v.index}">Restore</button></div>`).join('')}</details>` : ''}
        <pre class="acode"></pre>` : ''}</div></div>`
      : '<div class="pg-empty">Nothing saved yet. Ask GrizzyCode to build a dashboard, deck, tracker or diagram — it opens here and in its own window — or start from a template.<br><button id="sTpl" style="margin-top:12px">Browse templates</button></div>');
  P('#aQ').oninput = (e) => { artQuery = e.target.value; clearTimeout(pgArtifacts.t); pgArtifacts.t = setTimeout(async () => { await pgArtifacts(); const i = P('#aQ'); i.focus(); i.setSelectionRange(1e3, 1e3); }, 200); };
  P('#sTpl')?.addEventListener('click', () => { artTab = 'templates'; pgArtifacts(); });
  $('page').querySelectorAll('.alist .rowi').forEach((r) => (r.onclick = () => { savedSel = r.dataset.id; pgArtifacts(); }));
  if (!sel) return;
  P('.acode').textContent = full?.html || '';
  P('#sOpen').onclick = () => gc.artifacts.openSaved(sel.id);
  P('#sBrowser').onclick = () => gc.artifacts.openInBrowser(sel.id);
  P('#sSave').onclick = async () => { if (await gc.artifacts.saveHtml(sel.id)) toast('Saved'); };
  P('#sConv')?.addEventListener('click', () => open(sel.convId));
  P('#sRen').onclick = () => {
    const b = P('.pg-actions > b'); const i = document.createElement('input'); i.value = sel.title; i.style.minWidth = '260px'; b.replaceWith(i); i.focus(); i.select();
    const done = async (ok) => { if (ok && i.value.trim() && i.value.trim() !== sel.title) await gc.artifacts.rename(sel.id, i.value.trim()); pgArtifacts(); };
    i.onkeydown = (e) => { if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); }; i.onblur = () => done(true);
  };
  P('#sDel').onclick = async () => { if (await gc.confirm(`Delete “${sel.title}”?`, 'The page, its saved data and its version history are removed.', 'Delete')) { await gc.artifacts.remove(sel.id); savedSel = null; pgArtifacts(); } };
  $('page').querySelectorAll('[data-restore]').forEach((b) => (b.onclick = async () => { if (await gc.artifacts.restore(sel.id, +b.dataset.restore)) { toast('Restored'); pgArtifacts(); } }));
}
async function artTemplates(tabs) {
  const { templates, types } = await gc.artifacts.templates();
  $('page').innerHTML = shell('Artifacts', tabs, `<p class="hint">Built-in starters. “Use” saves a copy and opens it in its own window; ask GrizzyCode in a chat to customize it.</p>
    <div class="tgrid">${templates.map((t) => `<div class="card3 tcard"><div class="ti">${ART_ICON[t.type] || '▢'}</div><b>${esc(t.title)}</b> <em class="badge">${esc(t.type)}</em><p class="hint">${esc(t.description)}</p><button data-tpl="${esc(t.key)}">Use</button></div>`).join('')}</div>
    <h3 style="margin-top:20px">Types</h3>${types.map((t) => `<p class="hint"><b>${esc(t.title)}</b> — ${esc(t.description)}</p>`).join('')}`);
  $('page').querySelectorAll('[data-tpl]').forEach((b) => (b.onclick = async () => { const r = await gc.artifacts.create({ template: b.dataset.tpl }); if (r.error) return toast(r.error); savedSel = r.id; artTab = 'saved'; toast('Created'); pgArtifacts(); }));
}
async function artChats(tabs) {
  const all = await gc.artifacts.list();
  const q = artQuery.toLowerCase();
  const list = all.filter((a) => (artFilter === 'all' || (artFilter === 'preview' ? a.preview : !a.preview)) && (!q || (a.name + a.title + a.lang).toLowerCase().includes(q)));
  const sel = list.find((a) => a.id === artSel) || list[0];
  $('page').innerHTML = shell('Artifacts', `<input id="aQ" placeholder="Search" value="${esc(artQuery)}"><div class="seg" id="aF">${[['all', 'All'], ['preview', 'Web'], ['code', 'Code']].map(([v, l]) => `<button type="button" data-v="${v}" class="${artFilter === v ? 'on' : ''}">${l}</button>`).join('')}</div>${tabs}`,
    all.length ? `<div class="split"><div class="alist">${list.map((a) => `<div class="rowi ${sel?.id === a.id ? 'on' : ''}" data-id="${esc(a.id)}"><span><b>${esc(a.name)}</b><br><i>${esc(a.title)} · ${a.lines} lines</i></span><em class="badge">${esc(a.lang)}</em></div>`).join('') || '<p class="hint">No matches.</p>'}</div>
      <div class="aview">${sel ? `<div class="pg-actions"><b>${esc(sel.name)}</b><span class="grow"></span><button class="outline" id="aCopy">Copy</button><button class="outline" id="aSave">Save…</button>${sel.preview && sel.lang === 'html' ? '<button id="aMake">Save as artifact</button>' : ''}${sel.preview ? '<button class="outline" id="aOpen">Open in browser</button>' : ''}<button class="outline" id="aConv">Go to chat</button></div>
        <pre class="acode"></pre>` : ''}</div></div>`
      : '<div class="pg-empty">Code blocks and files from your conversations collect here.</div>');
  P('#aQ').oninput = (e) => { artQuery = e.target.value; clearTimeout(pgArtifacts.t); pgArtifacts.t = setTimeout(async () => { await pgArtifacts(); const i = P('#aQ'); i.focus(); i.setSelectionRange(1e3, 1e3); }, 200); };
  $('page').querySelectorAll('#aF button').forEach((b) => (b.onclick = () => { artFilter = b.dataset.v; pgArtifacts(); }));
  $('page').querySelectorAll('.alist .rowi').forEach((r) => (r.onclick = () => { artSel = r.dataset.id; pgArtifacts(); }));
  if (!sel) return;
  P('.acode').textContent = sel.code;
  P('#aCopy').onclick = () => { navigator.clipboard.writeText(sel.code); toast('Copied'); };
  P('#aSave').onclick = async () => { if (await gc.artifacts.export(sel.name.includes('.') ? sel.name : `${sel.name.replace(/\W+/g, '-')}.${sel.lang === 'markdown' ? 'md' : sel.lang}`, sel.code)) toast('Saved'); };
  P('#aMake')?.addEventListener('click', async () => { const r = await gc.artifacts.create({ title: sel.title, html: sel.code, convId: sel.convId }); if (r.error) return toast(r.error); savedSel = r.id; artTab = 'saved'; pgArtifacts(); });
  P('#aOpen')?.addEventListener('click', () => gc.artifacts.preview(sel.name.includes('.') ? sel.name : `artifact.${sel.lang}`, sel.code));
  P('#aConv').onclick = () => open(sel.convId);
}
gc.artifacts.onUpdate(() => { if (pageName === 'artifacts' && artTab === 'saved') pgArtifacts(); });

// ---------------- Scheduled ----------------
const describe = (s) => (s.every === 'interval' ? `Every ${s.minutes % 60 === 0 && s.minutes >= 60 ? s.minutes / 60 + ' h' : s.minutes + ' min'}` : s.every === 'weekdays' ? `Weekdays at ${s.time}` : `Daily at ${s.time}`) + ` · ${s.mode === 'code' ? 'Code in ' + folderName(s.cwd) : 'Chat'}`;
async function pgScheduled() {
  const list = await gc.schedules.list();
  if (schedSel) {
    const s = schedSel === 'new' ? { id: null, name: '', prompt: '', mode: 'chat', cwd: null, permissionMode: 'acceptEdits', every: 'daily', minutes: 60, time: '09:00', enabled: true } : list.find((x) => x.id === schedSel);
    if (!s) { schedSel = null; return pgScheduled(); }
    let cwd = s.cwd, mode = s.mode, pm = s.permissionMode, every = s.every;
    const seg = (id, opts, val) => `<div class="seg" id="${id}">${opts.map(([v, l]) => `<button type="button" data-v="${v}" class="${val === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    $('page').innerHTML = shell(s.id ? 'Edit task' : 'New scheduled task', '<button class="outline" id="sBack">← Cancel</button>', `
      <label class="fld">Name<input id="sName" value="${esc(s.name)}" placeholder="e.g. Morning summary"></label>
      <label class="fld">Prompt<textarea id="sPrompt" rows="5" placeholder="What should GrizzyCode do each time?">${esc(s.prompt)}</textarea></label>
      <div class="fld">Runs as ${seg('sMode', [['chat', 'Chat'], ['code', 'Code session']], mode)}</div>
      <div class="fld" id="sCode" ${mode === 'code' ? '' : 'hidden'}>Folder <div class="inl"><code id="sFolder">${esc(cwd || 'None')}</code><button class="outline" id="sPick">Choose…</button></div>
        <div class="inl" style="margin-top:8px">Permissions ${seg('sPm', [['acceptEdits', 'Accept edits'], ['bypassPermissions', 'Bypass']], pm)}</div><p class="hint">Unattended runs can’t ask for approval; anything the mode doesn’t allow is denied.</p></div>
      <div class="fld">Repeats ${seg('sEvery', [['interval', 'Interval'], ['daily', 'Daily'], ['weekdays', 'Weekdays']], every)}
        <div class="inl" style="margin-top:8px"><span id="sIntBox" ${every === 'interval' ? '' : 'hidden'}>Every <input id="sMin" type="number" min="1" value="${s.minutes}" style="width:80px"> minutes</span><span id="sTimeBox" ${every === 'interval' ? 'hidden' : ''}>At <input id="sTime" type="time" value="${esc(s.time.padStart(5, '0'))}"></span></div></div>
      <div class="pg-actions"><button class="primary" id="sSave2">Save task</button></div>`);
    const wire = (id, set) => $('page').querySelectorAll(`#${id} button`).forEach((b) => (b.onclick = () => { set(b.dataset.v); $('page').querySelectorAll(`#${id} button`).forEach((x) => x.classList.toggle('on', x === b)); }));
    wire('sMode', (v) => { mode = v; P('#sCode').hidden = v !== 'code'; }); wire('sPm', (v) => (pm = v));
    wire('sEvery', (v) => { every = v; P('#sIntBox').hidden = v !== 'interval'; P('#sTimeBox').hidden = v === 'interval'; });
    P('#sBack').onclick = () => { schedSel = null; pgScheduled(); };
    P('#sPick').onclick = async () => { const f = await gc.pickFolder(); if (f) { cwd = f; P('#sFolder').textContent = f; } };
    P('#sSave2').onclick = async () => {
      if (!P('#sPrompt').value.trim()) return toast('Add a prompt first');
      if (mode === 'code') { if (!cwd) return toast('Choose a folder'); if (!(await ensureTrusted(cwd))) return; if (pm === 'bypassPermissions' && !(await gc.confirm('Run this task in bypass permissions mode?', 'It will edit files and run commands in that folder with nobody watching.', 'Bypass permissions'))) return; }
      await gc.schedules.save({ id: s.id, name: P('#sName').value, prompt: P('#sPrompt').value, mode, cwd, permissionMode: pm, every, minutes: P('#sMin').value, time: P('#sTime').value, enabled: s.enabled });
      schedSel = null; toast('Task saved'); pgScheduled();
    };
    return;
  }
  $('page').innerHTML = shell('Scheduled', '<button class="primary" id="sNew">New task</button>',
    list.length ? list.map((s) => `<div class="task" data-id="${s.id}"><input type="checkbox" class="switch" ${s.enabled ? 'checked' : ''} title="Enabled">
      <div class="grow"><b>${esc(s.name)}</b><p>${esc(describe(s))}</p><i>${s.enabled ? 'Next ' + when(s.nextRun) : 'Paused'} · Last ${when(s.lastRun)}${s.lastStatus ? ' · ' + esc(s.lastStatus) : ''}</i></div>
      ${s.lastConvId ? '<button class="outline t-last">Last run</button>' : ''}<button class="outline t-run">Run now</button><button class="outline t-edit">Edit</button><button class="outline danger t-del">Delete</button></div>`).join('')
      : '<div class="pg-empty">Scheduled tasks run a prompt on a timer while GrizzyCode is open or in the tray.<br>Create one to get started.</div>');
  P('#sNew').onclick = () => { schedSel = 'new'; pgScheduled(); };
  $('page').querySelectorAll('.task').forEach((row) => {
    const s = list.find((x) => x.id === row.dataset.id);
    row.querySelector('.switch').onchange = async (e) => { await gc.schedules.save({ ...s, enabled: e.target.checked }); };
    row.querySelector('.t-run').onclick = async () => { await gc.schedules.run(s.id); toast('Started — see Last run'); };
    row.querySelector('.t-edit').onclick = () => { schedSel = s.id; pgScheduled(); };
    row.querySelector('.t-last')?.addEventListener('click', () => open(s.lastConvId));
    row.querySelector('.t-del').onclick = async () => { if (await gc.confirm(`Delete “${s.name}”?`, 'Past runs stay in your sidebar.', 'Delete')) { await gc.schedules.remove(s.id); pgScheduled(); } };
  });
}

// ---------------- Dispatch ----------------
const PILL = { running: 'Running', done: 'Done', failed: 'Failed', stopped: 'Stopped', interrupted: 'Interrupted' };
async function pgDispatch() {
  const list = await gc.dispatch.list();
  if (!dispDraft.cwd) dispDraft.cwd = settings.pinnedFolders?.[0] || settings.trustedFolders?.[0] || null;
  const keep = $('page').querySelector('#dText')?.value; if (keep != null) dispDraft.prompt = keep;
  $('page').innerHTML = shell('Dispatch', '', `
    <div class="card3"><textarea id="dText" rows="3" placeholder="Hand off a task. It runs in the background in its own session…">${esc(dispDraft.prompt)}</textarea>
      <div class="inl"><button class="chip-b" id="dDir">${esc(folderName(dispDraft.cwd) || 'Choose folder')}</button>
        <div class="seg" id="dMode">${[['acceptEdits', 'Accept edits'], ['plan', 'Plan only'], ['bypassPermissions', 'Bypass']].map(([v, l]) => `<button type="button" data-v="${v}" class="${dispDraft.mode === v ? 'on' : ''}">${l}</button>`).join('')}</div>
        <span class="grow"></span><button class="primary" id="dGo">Dispatch</button></div></div>
    <h3>Tasks</h3>${list.length ? list.map((t) => `<div class="task" data-id="${t.id}"><span class="pill ${t.status}">${PILL[t.status] || t.status}</span>
      <div class="grow"><b>${esc(t.prompt.slice(0, 90))}</b><p>${esc(folderName(t.cwd))} · ${esc(t.permissionMode === 'acceptEdits' ? 'Accept edits' : t.permissionMode === 'plan' ? 'Plan only' : 'Bypass')} · ${when(t.createdAt)}</p>${t.error ? `<i class="err">${esc(t.error)}</i>` : ''}</div>
      <button class="outline t-open">Open</button>${t.status === 'running' ? '<button class="outline t-stop">Stop</button>' : '<button class="outline t-del">Remove</button>'}</div>`).join('') : '<p class="hint">Nothing dispatched yet.</p>'}`);
  P('#dDir').onclick = async () => { dispDraft.prompt = P('#dText').value; const f = await gc.pickFolder(); if (f) dispDraft.cwd = f; pgDispatch(); };
  $('page').querySelectorAll('#dMode button').forEach((b) => (b.onclick = () => { dispDraft.prompt = P('#dText').value; dispDraft.mode = b.dataset.v; pgDispatch(); }));
  P('#dGo').onclick = async () => {
    const prompt = P('#dText').value.trim(); if (!prompt) return toast('Write a task first'); if (!dispDraft.cwd) return toast('Choose a folder');
    if (!(await ensureTrusted(dispDraft.cwd))) return;
    if (dispDraft.mode === 'bypassPermissions' && !(await gc.confirm('Dispatch in bypass permissions mode?', 'It will edit files and run commands without asking, with nobody watching.', 'Bypass permissions'))) return;
    const r = await gc.dispatch.start({ prompt, cwd: dispDraft.cwd, permissionMode: dispDraft.mode });
    if (r?.error) return toast(r.error);
    dispDraft.prompt = ''; toast('Dispatched'); pgDispatch(); refreshList();
  };
  $('page').querySelectorAll('.task').forEach((row) => {
    const t = list.find((x) => x.id === row.dataset.id);
    row.querySelector('.t-open').onclick = () => open(t.convId);
    row.querySelector('.t-stop')?.addEventListener('click', async () => { await gc.dispatch.stop(t.id); pgDispatch(); });
    row.querySelector('.t-del')?.addEventListener('click', async () => { await gc.dispatch.remove(t.id); pgDispatch(); });
  });
}

// ---------------- GrizzyWork ----------------
let cwTab = 'tasks', cwTask = null, cwFile = null;
let cwDraft = { prompt: '', folder: null, spaceId: '', mode: 'acceptEdits' }, cwEditing = false;
async function pgGrizzyWork() {
  if (cwTask) return pgCwTask();
  const tabs = `<div class="seg" id="cwTabs">${[['tasks', 'Tasks'], ['network', 'Network'], ['memory', 'Memory'], ['plugins', 'Plugins'], ['data', 'Data & policy']].map(([v, l]) => `<button type="button" data-v="${v}" class="${cwTab === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  const bindTabs = () => $('page').querySelectorAll('#cwTabs button').forEach((b) => (b.onclick = () => { cwTab = b.dataset.v; pgGrizzyWork(); }));
  if (cwTab !== 'tasks') { await ({ network: cwNetwork, memory: cwMemory, plugins: cwPlugins, data: cwData }[cwTab])(tabs); bindTabs(); return; }
  const [tasks, spaces] = await Promise.all([gc.grizzywork.tasks(), gc.grizzywork.spaces()]);
  const keep = $('page').querySelector('#cText')?.value; if (keep != null) cwDraft.prompt = keep;
  const spName = (id) => spaces.find((s) => s.id === id)?.name;
  $('page').innerHTML = shell('GrizzyWork', '<button class="outline" id="cNewSpace">New Space</button>', `${tabs}
    <div class="card3"><textarea id="cText" rows="3" placeholder="What should Claude work on? Reports, research, spreadsheets, file organizing…">${esc(cwDraft.prompt)}</textarea>
      <div class="inl"><button class="chip-b" id="cDir">${esc(cwDraft.folder ? folderName(cwDraft.folder) : 'Scratch workspace')}</button>${cwDraft.folder ? '<button class="outline" id="cScratch">Use scratch</button>' : ''}
        <select id="cSpace"><option value="">No Space</option>${spaces.map((s) => `<option value="${s.id}" ${s.id === cwDraft.spaceId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
        <div class="seg" id="cMode">${[['acceptEdits', 'Accept edits'], ['default', 'Ask first'], ['plan', 'Plan only']].map(([v, l]) => `<button type="button" data-v="${v}" class="${cwDraft.mode === v ? 'on' : ''}">${l}</button>`).join('')}</div>
        <span class="grow"></span><button class="primary" id="cGo">Start task</button></div></div>
    ${spaces.length ? `<h3>Spaces</h3>${spaces.map((s) => `<div class="task" data-sp="${s.id}"><div class="grow"><b>${esc(s.name)}</b><p>${s.folders.length} folder${s.folders.length === 1 ? '' : 's'} · ${s.links.length} link${s.links.length === 1 ? '' : 's'}${s.instructions ? ' · instructions' : ''}</p></div><button class="outline sp-use">Use</button><button class="outline sp-edit">Edit</button></div>`).join('')}` : ''}
    <h3>Tasks</h3>${tasks.length ? tasks.map((t) => `<div class="task" data-id="${t.id}"><span class="pill ${t.status}">${PILL[t.status] || t.status}</span>
      <div class="grow"><b>${esc(t.prompt.slice(0, 90))}</b><p>${esc(t.scratch ? 'Scratch workspace' : folderName(t.cwd))}${spName(t.spaceId) ? ' · ' + esc(spName(t.spaceId)) : ''} · ${when(t.createdAt)}</p>${t.error ? `<i class="err">${esc(t.error)}</i>` : ''}</div>
      <button class="outline t-files">Files</button><button class="outline t-branch">Branch</button><button class="outline t-open">Open</button>${t.status === 'running' ? '<button class="outline t-stop">Stop</button>' : '<button class="outline t-del">Remove</button>'}</div>`).join('') : '<p class="hint">No GrizzyWork tasks yet.</p>'}
    <h3>Cleanup</h3><div class="inl"><span class="hint">Delete scratch workspaces older than</span>
      <select id="cRet">${[[0, 'never'], [7, '7 days'], [30, '30 days'], [90, '90 days']].map(([v, l]) => `<option value="${v}" ${(settings.grizzyworkRetentionDays ?? 30) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button class="outline" id="cClean">Clean up now</button></div>`);
  bindTabs();
  P('#cDir').onclick = async () => { cwDraft.prompt = P('#cText').value; const f = await gc.pickFolder(); if (f) cwDraft.folder = f; pgGrizzyWork(); };
  P('#cScratch')?.addEventListener('click', () => { cwDraft.prompt = P('#cText').value; cwDraft.folder = null; pgGrizzyWork(); });
  P('#cSpace').onchange = (e) => { cwDraft.spaceId = e.target.value; };
  $('page').querySelectorAll('#cMode button').forEach((b) => (b.onclick = () => { cwDraft.prompt = P('#cText').value; cwDraft.mode = b.dataset.v; pgGrizzyWork(); }));
  P('#cGo').onclick = async () => {
    const prompt = P('#cText').value.trim(); if (!prompt) return toast('Describe the task first');
    if (cwDraft.folder && !settings.trustedFolders.includes(cwDraft.folder)) {
      if (!(await gc.confirm(`Allow Claude to work in ${cwDraft.folder}?`, 'It can read files in this folder and, depending on the permission mode, change them.', 'Allow'))) return;
      settings = await gc.settings.set({ trustedFolders: [...settings.trustedFolders, cwDraft.folder] });
    }
    const r = await gc.grizzywork.start({ prompt, folder: cwDraft.folder, spaceId: cwDraft.spaceId, permissionMode: cwDraft.mode });
    if (r?.error) return toast(r.error);
    cwDraft.prompt = ''; P('#cText').value = ''; toast('Task started'); pgGrizzyWork(); refreshList();
  };
  P('#cNewSpace').onclick = () => cwSpaceForm();
  $('page').querySelectorAll('[data-sp]').forEach((row) => {
    const s = spaces.find((x) => x.id === row.dataset.sp);
    row.querySelector('.sp-use').onclick = () => { cwDraft.prompt = P('#cText').value; cwDraft.spaceId = s.id; pgGrizzyWork(); };
    row.querySelector('.sp-edit').onclick = () => cwSpaceForm(s);
  });
  $('page').querySelectorAll('.task[data-id]').forEach((row) => {
    const t = tasks.find((x) => x.id === row.dataset.id);
    row.querySelector('.t-open').onclick = () => open(t.convId);
    row.querySelector('.t-files').onclick = () => { cwTask = t; cwFile = null; pgGrizzyWork(); };
    row.querySelector('.t-branch').onclick = async () => { const r = await gc.grizzywork.branch(t.id); if (r?.error) return toast(r.error); toast('Branched. Open it to take a different path'); pgGrizzyWork(); refreshList(); };
    row.querySelector('.t-stop')?.addEventListener('click', async () => { await gc.grizzywork.stop(t.id); pgGrizzyWork(); });
    row.querySelector('.t-del')?.addEventListener('click', async () => { await gc.grizzywork.remove(t.id); pgGrizzyWork(); });
  });
  P('#cRet').onchange = async (e) => { settings = await gc.settings.set({ grizzyworkRetentionDays: Number(e.target.value) }); };
  P('#cClean').onclick = async () => { const n = await gc.grizzywork.cleanup(Number(P('#cRet').value) || 30); toast(n ? `Removed ${n} scratch workspace${n === 1 ? '' : 's'}` : 'Nothing to clean up'); };
}
function cwSpaceForm(s = {}) {
  cwEditing = true;
  $('page').innerHTML = shell(s.id ? 'Edit Space' : 'New Space', '', `<div class="card3">
    <input id="spName" placeholder="Name" value="${esc(s.name || '')}">
    <textarea id="spIns" rows="5" placeholder="Instructions every task in this Space should follow">${esc(s.instructions || '')}</textarea>
    <textarea id="spFolders" rows="3" placeholder="Folders, one absolute path per line">${esc((s.folders || []).join('\n'))}</textarea>
    <textarea id="spLinks" rows="3" placeholder="Links, one per line">${esc((s.links || []).join('\n'))}</textarea>
    <div class="inl"><button class="outline" id="spBack">Cancel</button>${s.id ? '<button class="outline" id="spDel">Delete</button>' : ''}<span class="grow"></span><button class="primary" id="spSave">Save</button></div></div>`);
  const done = () => { cwEditing = false; pgGrizzyWork(); };
  const lines = (id) => P(id).value.split('\n').map((x) => x.trim()).filter(Boolean);
  P('#spBack').onclick = done;
  P('#spDel')?.addEventListener('click', async () => { if (await gc.confirm('Delete this Space?', 'Tasks already started keep running.', 'Delete')) { await gc.grizzywork.removeSpace(s.id); done(); } });
  P('#spSave').onclick = async () => {
    const r = await gc.grizzywork.saveSpace({ id: s.id, name: P('#spName').value, instructions: P('#spIns').value, folders: lines('#spFolders'), links: lines('#spLinks') });
    if (r?.error) return toast(r.error); done();
  };
}

// Small, safe Markdown view: headings, bold/italic, inline code, bullet and numbered lists, paragraphs. Everything is escaped first.
function mdLite(src) {
  const inline = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
  let out = '', list = null;
  const close = () => { if (list) { out += `</${list}>`; list = null; } };
  for (const line of String(src).split(/\r?\n/)) {
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { close(); out += `<h${Math.min(m[1].length + 1, 6)}>${inline(m[2])}</h${Math.min(m[1].length + 1, 6)}>`; }
    else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) { if (list !== 'ul') { close(); out += '<ul>'; list = 'ul'; } out += `<li>${inline(m[1])}</li>`; }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { if (list !== 'ol') { close(); out += '<ol>'; list = 'ol'; } out += `<li>${inline(m[1])}</li>`; }
    else if (!line.trim()) close();
    else { close(); out += `<p>${inline(line)}</p>`; }
  }
  close(); return out;
}
const kb = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
async function pgCwTask() {
  const t = cwTask, [list, allArts] = await Promise.all([gc.grizzywork.files(t.id), gc.artifacts.saved()]); const arts = allArts.filter((x) => x.convId === t.convId);
  $('page').innerHTML = shell('Task files', '<button class="outline" id="fBack">Back</button>', `<p class="hint">${esc(t.prompt.slice(0, 120))}<br>${esc(t.cwd)}</p>
    <div class="inl" style="align-items:flex-start;gap:14px"><div style="width:300px;flex:none;max-height:60vh;overflow:auto">${list.length ? list.map((f) => `<div class="task f-row ${f.rel === cwFile ? 'on' : ''}" data-rel="${esc(f.rel)}"><div class="grow"><b>${esc(f.rel)}</b><p>${kb(f.size)} · ${when(f.mtime)}</p></div></div>`).join('') : '<p class="hint">No files yet.</p>'}</div>
    <div class="grow" id="fView"><p class="hint">Pick a file to preview it.</p></div></div>
    <h3>Artifacts</h3>${arts.length ? arts.map((x) => `<div class="task" data-art="${x.id}"><div class="grow"><b>${esc(x.title)}</b><p>${esc(x.type)} · ${x.versions + 1} version${x.versions ? 's' : ''} · ${when(x.updatedAt)}</p></div><button class="outline a-open">Open</button></div>`).join('') : '<p class="hint">This task has not made any artifacts.</p>'}
    <div class="inl"><button class="outline" id="fReveal">Show in Finder</button></div>`);
  $('page').querySelectorAll('[data-art]').forEach((r) => (r.querySelector('.a-open').onclick = () => gc.artifacts.openSaved(r.dataset.art)));
  P('#fBack').onclick = () => { cwTask = null; pgGrizzyWork(); };
  P('#fReveal').onclick = () => gc.grizzywork.reveal(t.id).then((ok) => ok || toast('The folder is gone'));
  const show = async (rel) => {
    cwFile = rel; $('page').querySelectorAll('.f-row').forEach((r) => r.classList.toggle('on', r.dataset.rel === rel));
    const v = P('#fView'), r = await gc.grizzywork.preview(t.id, rel);
    const bar = `<div class="inl"><b class="grow">${esc(rel)}</b><button class="outline" id="vOpen">Open</button>${/\.html?$/i.test(rel) ? '<button class="outline" id="vArt">Save as artifact</button>' : ''}</div>`;
    let body = '';
    if (r.error) body = `<p class="err">${esc(r.error)}</p>`;
    else if (r.kind === 'image') body = `<img src="${r.src}" style="max-width:100%;border-radius:8px">`;
    else if (r.kind === 'html') body = '<iframe sandbox="" style="width:100%;height:55vh;border:1px solid var(--line);border-radius:8px;background:#fff"></iframe>';
    else if (r.kind === 'table') { const rows = r.text.split(/\r?\n/).filter(Boolean).slice(0, 200).map((l) => l.split(r.sep)); body = `<div style="overflow:auto;max-height:55vh"><table>${rows.map((c, i) => `<tr>${c.map((x) => `<${i ? 'td' : 'th'}>${esc(x.replace(/^"|"$/g, ''))}</${i ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</table></div>`; }
    else if (r.kind === 'markdown') body = `<div style="max-height:55vh;overflow:auto">${mdLite(r.text)}</div>`;
    else if (r.kind === 'text') body = `<pre style="white-space:pre-wrap;max-height:55vh;overflow:auto">${esc(r.text)}</pre>`;
    else body = `<p class="hint">${esc(r.note || 'No preview.')}</p>`;
    v.innerHTML = bar + body;
    if (r.kind === 'html') v.querySelector('iframe').srcdoc = r.text;
    v.querySelector('#vOpen').onclick = async () => { if (!(await gc.grizzywork.openFile(t.id, rel))) toast('Could not open that file'); };
    v.querySelector('#vArt')?.addEventListener('click', async () => { const a = await gc.grizzywork.toArtifact(t.id, rel); toast(a?.error || 'Saved to Artifacts'); });
  };
  $('page').querySelectorAll('.f-row').forEach((r) => (r.onclick = () => show(r.dataset.rel)));
  if (cwFile) show(cwFile);
}
async function cwNetwork(tabs) {
  const e = { mode: 'all', hosts: [], ...(settings.grizzyworkEgress || {}) };
  $('page').innerHTML = shell('GrizzyWork', '', `${tabs}<div class="card3"><b>Network access for web_fetch and web_search</b>
    <div class="seg" id="nMode">${[['all', 'Any public site'], ['allowlist', 'Allow-list'], ['none', 'Off']].map(([v, l]) => `<button type="button" data-v="${v}" class="${e.mode === v ? 'on' : ''}">${l}</button>`).join('')}</div>
    <textarea id="nHosts" rows="5" placeholder="One host per line, for example example.com (subdomains included)" ${e.mode === 'allowlist' ? '' : 'disabled'}>${esc(e.hosts.join('\n'))}</textarea>
    <p class="hint">Applies to GrizzyWork tasks only. Shell commands such as curl are not filtered; use Ask first to review them.</p>
    <div class="inl"><span class="grow"></span><button class="primary" id="nSave">Save</button></div></div>`);
  let mode = e.mode;
  $('page').querySelectorAll('#nMode button').forEach((b) => (b.onclick = () => { mode = b.dataset.v; $('page').querySelectorAll('#nMode button').forEach((x) => x.classList.toggle('on', x === b)); P('#nHosts').disabled = mode !== 'allowlist'; }));
  P('#nSave').onclick = async () => { const r = await gc.grizzywork.setEgress({ mode, hosts: P('#nHosts').value.split(/\r?\n/) }); settings.grizzyworkEgress = r; toast('Saved'); pgGrizzyWork(); };
}
async function cwMemory(tabs) {
  const l = await gc.grizzywork.memory();
  $('page').innerHTML = shell('GrizzyWork', '', `${tabs}<p class="hint">Facts only GrizzyWork tasks see. Separate from chat memory.</p>
    <div class="card3"><div class="inl"><input id="mText" class="grow" placeholder="Something GrizzyWork should remember"><button class="primary" id="mAdd">Add</button></div></div>
    ${l.length ? l.map((m) => `<div class="task" data-id="${m.id}"><div class="grow">${esc(m.text)}</div><button class="outline m-del">Delete</button></div>`).join('') : '<p class="hint">Nothing remembered yet.</p>'}`);
  P('#mAdd').onclick = async () => { const r = await gc.grizzywork.memAdd(P('#mText').value); if (r?.error) return toast(r.error); pgGrizzyWork(); };
  $('page').querySelectorAll('.m-del').forEach((b) => (b.onclick = async () => { await gc.grizzywork.memRemove(b.closest('.task').dataset.id); pgGrizzyWork(); }));
}
async function cwPlugins(tabs) {
  const l = await gc.grizzywork.plugins();
  $('page').innerHTML = shell('GrizzyWork', '', `${tabs}<p class="hint">Plugins installed under Customize. Switch on the ones GrizzyWork tasks should use.</p>
    ${l.length ? l.map((p) => `<div class="task" data-n="${esc(p.name)}"><div class="grow"><b>${esc(p.name)}</b><p>${esc(p.description)} ${p.skills.length ? '· ' + p.skills.length + ' skills' : ''} ${p.commands.length ? '· ' + p.commands.length + ' commands' : ''}</p></div><label><input type="checkbox" ${p.enabled ? 'checked' : ''}> Use in GrizzyWork</label></div>`).join('') : '<p class="hint">No plugins installed.</p>'}`);
  $('page').querySelectorAll('.task input').forEach((i) => (i.onchange = async () => { await gc.grizzywork.setPlugin(i.closest('.task').dataset.n, i.checked); toast(i.checked ? 'Plugin on' : 'Plugin off'); }));
}
async function cwData(tabs) {
  const pol = { enabled: true, allowedFolders: [], ...(settings.grizzyworkPolicy || {}) };
  $('page').innerHTML = shell('GrizzyWork', '', `${tabs}<div class="card3"><b>Policy on this computer</b>
    <label><input type="checkbox" id="pOn" ${pol.enabled ? 'checked' : ''}> GrizzyWork is allowed</label>
    <textarea id="pDirs" rows="3" placeholder="Only allow these folders (one absolute path per line). Empty means any folder.">${esc(pol.allowedFolders.join('\n'))}</textarea>
    <div class="inl"><span class="grow"></span><button class="primary" id="pSave">Save policy</button></div></div>
    <h3>Your data</h3><div class="inl"><button class="outline" id="dExp">Export GrizzyWork data…</button><button class="outline" id="dDel">Delete all GrizzyWork data…</button></div>
    <p class="hint">Export includes tasks, sessions, Spaces and memory. Delete removes them and scratch workspaces. Folders you granted are not touched.</p>`);
  P('#pSave').onclick = async () => { const r = await gc.grizzywork.setPolicy({ enabled: P('#pOn').checked, allowedFolders: P('#pDirs').value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) }); settings.grizzyworkPolicy = r; toast('Policy saved'); };
  P('#dExp').onclick = async () => { if (await gc.grizzywork.export()) toast('Exported'); };
  P('#dDel').onclick = async () => { if (await gc.confirm('Delete all GrizzyWork data?', 'Tasks, their sessions, Spaces, memory and scratch workspaces are permanently deleted from this computer.', 'Delete')) { await gc.grizzywork.deleteAll(); toast('Deleted'); pgGrizzyWork(); refreshList(); } };
}

// ---------------- Customize ----------------
async function pgCustomize() {
  const [sk, st, cfg] = await Promise.all([gc.skills.list(), gc.mcp.status(), gc.mcp.config()]);
  const s = settings = await gc.settings.get();
  $('page').innerHTML = shell('Customize', '<button class="outline" id="cSettings">All settings</button>', `
    <h3>Instructions</h3><p class="hint">Added to every conversation. Project instructions apply on top of these.</p>
    <textarea id="cInst" rows="5">${esc(s.systemPrompt)}</textarea><div class="pg-actions"><button class="primary" id="cInstSave">Save instructions</button></div>
    <h3>Skills</h3>${sk.length ? sk.map((k) => `<div class="rowi" data-id="${esc(k.id)}"><span><b>${esc(k.name)}</b><br><i>${esc(k.description.slice(0, 120))}</i></span><button class="outline c-rm">Remove</button></div>`).join('') : '<p class="hint">No skills installed.</p>'}
    <div class="pg-actions"><button class="outline" id="cSkill">Import .skill / folder…</button></div>
    <h3>Connectors</h3><p class="hint">MCP servers; their tools are available in Code sessions.</p>
    ${st.length ? st.map((m) => `<div class="rowi"><span><b>${esc(m.name)}</b></span><i>${esc(m.status)}${m.error ? ' – ' + esc(m.error) : ''} · ${m.tools.length} tools</i></div>`).join('') : '<p class="hint">No servers running.</p>'}
    <textarea id="cMcp" rows="8" spellcheck="false" style="margin-top:10px">${esc(JSON.stringify(cfg, null, 2))}</textarea>
    <div class="pg-actions"><button class="primary" id="cMcpSave">Save connectors</button></div>`);
  P('#cSettings').onclick = openSettings;
  P('#cInstSave').onclick = async () => { settings = await gc.settings.set({ systemPrompt: P('#cInst').value }); toast('Instructions saved'); };
  P('#cSkill').onclick = async () => { const r = await gc.skills.import(); if (r?.error) toast(r.error); pgCustomize(); };
  $('page').querySelectorAll('.c-rm').forEach((b) => (b.onclick = async () => { await gc.skills.remove(b.closest('.rowi').dataset.id); pgCustomize(); }));
  P('#cMcpSave').onclick = async () => { try { await gc.mcp.save(JSON.parse(P('#cMcp').value)); toast('Connectors saved'); pgCustomize(); } catch (e) { toast('Invalid JSON: ' + e.message); } };
}
