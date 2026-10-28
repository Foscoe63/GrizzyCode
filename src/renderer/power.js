// Session power features: rewind, message queue, @-mentions, command palette, side questions, background tasks,
// follow-ups, reasoning effort and fast mode. Shares app.js's globals ($, esc, gc, cur, busy, settings, atts, …).

// ---------- stop + message queue ----------
const queues = new Map(), paused = new Set();
const stopRun = (id) => { paused.add(id); gc.agent.stop(id); };
const unpause = (id) => paused.delete(id);
const shownWithRefs = (it) => it.shown + (it.refs?.length ? '\n' + it.refs.map((r) => (r.kind === 'dir' ? '📁 ' : '📄 ') + r.name).join('  ') : '');
function enqueue(id, item) { if (!queues.has(id)) queues.set(id, []); queues.get(id).push(item); renderQueue(); }
function renderQueue() {
  const box = $('queue'), q = (cur && queues.get(cur.id)) || [];
  box.innerHTML = ''; box.hidden = !q.length; if (!q.length) return;
  if (paused.has(cur.id) && !busy.has(cur.id)) {
    const h = document.createElement('div'); h.className = 'qh'; h.innerHTML = '<span>Queue paused — the run was stopped or failed.</span>';
    const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Send next'; b.onclick = () => { unpause(cur.id); flushQueue(cur.id); }; h.append(b); box.append(h);
  }
  q.forEach((it, i) => {
    const d = document.createElement('div'); d.className = 'q';
    const s = document.createElement('span'); s.textContent = it.shown || '(attachment)'; s.title = 'Click to edit'; d.append(s);
    s.onclick = () => { q.splice(i, 1); $('input').value = it.shown; atts.push(...it.images, ...(it.refs || [])); renderAtts(); autosize(); renderQueue(); $('input').focus(); };
    const x = document.createElement('button'); x.type = 'button'; x.textContent = '✕'; x.title = 'Remove from queue'; x.onclick = () => { q.splice(i, 1); renderQueue(); }; d.append(x);
    box.append(d);
  });
}
function flushQueue(id) {
  renderQueue();
  const q = queues.get(id); if (!q?.length || paused.has(id) || busy.has(id)) return;
  const it = q.shift(); renderQueue();
  busy.add(id);
  if (cur?.id === id) {
    userBubble(it.images.length ? [...it.images.map((a) => ({ type: 'image', source: { media_type: a.mediaType, data: a.data } })), { type: 'text', text: shownWithRefs(it) }] : shownWithRefs(it));
    typing(true); syncComposer(); $('msgs').scrollTop = 1e9;
  }
  refreshList();
  gc.agent.send(id, it.text, it.images);
}

// ---------- rewind ----------
function attachRewind(row) {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'rw'; b.textContent = '↩'; b.title = 'Rewind to here';
  b.onclick = (e) => { e.stopPropagation(); rewindMenu(e, row); }; row.prepend(b);
}
const humanIdx = (c) => c.messages.flatMap((m, i) => (m.role === 'user' && (typeof m.content === 'string' || m.content.some((b) => b.type !== 'tool_result')) ? [i] : []));
async function rewindMenu(e, row) {
  if (!cur) return; const id = cur.id;
  if (busy.has(id)) return toast('Stop the running task first');
  const n = [...$('msgs').querySelectorAll('.msg.user')].indexOf(row);
  const c = await gc.conv.get(id), idx = humanIdx(c)[n];
  if (idx == null) return toast('Can’t rewind to that message');
  const pv = await gc.rewind.preview(id, idx), nf = pv?.files?.length || 0, items = [];
  if (!c.ssh) items.push([nf ? `Restore code and conversation (${nf} file${nf > 1 ? 's' : ''})` : 'Rewind conversation to here', () => doRewind(id, idx, true)]);
  if (nf || c.ssh) items.push(['Rewind conversation only', () => doRewind(id, idx, false)]);
  ctxMenu(e, items);
}
async function doRewind(id, idx, files) {
  const r = await gc.rewind.run(id, idx, { files });
  if (r.error) return toast(r.error);
  const c = await gc.conv.get(id); queues.delete(id); renderConv(c); refreshList(); refreshDiff();
  $('input').value = r.text || ''; autosize(); $('input').focus();
  const f = r.files;
  infoLine(f ? `Rewound to that message. ${f.restored} file${f.restored === 1 ? '' : 's'} restored${f.removed ? `, ${f.removed} created file${f.removed === 1 ? '' : 's'} removed` : ''}${f.skipped?.length ? `. Couldn’t restore: ${esc(f.skipped.join(', '))}` : ''}. Shell commands run since then are not undone.` : 'Rewound the conversation. Files were left as they are.');
}
async function rewindLast() {
  if (!cur) return toast('Open a session first');
  if (busy.has(cur.id)) return toast('Stop the running task first');
  const c = await gc.conv.get(cur.id), idx = humanIdx(c).pop();
  if (idx == null) return toast('Nothing to rewind');
  const pv = await gc.rewind.preview(cur.id, idx), nf = pv?.files?.length || 0;
  if (!(await gc.confirm('Rewind to your last message?', nf && !c.ssh ? `Removes the reply and puts ${nf} file${nf > 1 ? 's' : ''} back as they were. Shell commands are not undone.` : 'Removes the reply; files are left as they are.', 'Rewind'))) return;
  doRewind(cur.id, idx, !c.ssh);
}

// ---------- @-mentions ----------
let mSel = 0, mItems = [], mTok = null, mTimer = null;
const closeMention = () => { mTok = null; mItems = []; $('mention').hidden = true; };
function renderMention() {
  const box = $('mention'); box.innerHTML = ''; box.hidden = !mItems.length;
  mItems.forEach((it, i) => { const d = document.createElement('div'); if (i === mSel) d.className = 'on'; d.textContent = (it.dir ? '📁 ' : '📄 ') + it.rel; d.onmousedown = (e) => { e.preventDefault(); pickMention(it); }; box.append(d); });
}
function mentionUpdate() {
  const i = $('input'), before = i.value.slice(0, i.selectionStart), m = before.match(/(^|\s)@([^\s@]{0,80})$/);
  const cwd = cur ? (cur.mode === 'code' ? cur.cwd : null) : (viewMode === 'code' ? homeFolder : null);
  if (!m || !cwd || cur?.ssh || (!cur && homeSsh)) return closeMention();
  mTok = { start: before.length - m[2].length - 1, end: i.selectionStart };
  clearTimeout(mTimer);
  mTimer = setTimeout(async () => { const r = await gc.searchFiles(cwd, m[2]); if (!mTok) return; mItems = r; mSel = 0; renderMention(); }, 60);
}
function pickMention(it) {
  const i = $('input'); if (!mTok) return;
  i.value = i.value.slice(0, mTok.start) + i.value.slice(mTok.end); i.setSelectionRange(mTok.start, mTok.start);
  closeMention(); addPaths([it.path]); i.focus();
}
$('input').addEventListener('input', mentionUpdate);
$('input').addEventListener('click', mentionUpdate);
$('input').addEventListener('blur', () => setTimeout(closeMention, 120));
$('input').addEventListener('keydown', (e) => {
  if ($('mention').hidden || !mItems.length) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); e.stopImmediatePropagation(); mSel = (mSel + 1) % mItems.length; renderMention(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopImmediatePropagation(); mSel = (mSel - 1 + mItems.length) % mItems.length; renderMention(); }
  else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.isComposing)) { e.preventDefault(); e.stopImmediatePropagation(); pickMention(mItems[mSel]); }
  else if (e.key === 'Escape') { e.stopImmediatePropagation(); closeMention(); }
}, true);

// ---------- reasoning effort + fast mode ----------
const EFFORTS = ['off', 'low', 'medium', 'high'];
async function setEffort(v) {
  if (!cur) return toast('Open a session first');
  cur = await gc.conv.update(cur.id, { effort: v }); syncPower();
  infoLine(v === 'off' ? 'Extended thinking is off for this session.' : `Extended thinking: <b>${v}</b>. Used by models that support it; others ignore it.`);
}
async function toggleFast() {
  if (!cur) return toast('Open a session first');
  if (!cur.fast && !settings.fastModel) return toast('Set a Fast model in Settings → Claude Code first');
  cur = await gc.conv.update(cur.id, { fast: !cur.fast }); syncPower();
  infoLine(cur.fast ? `Fast mode on — using <b>${esc(settings.fastModel)}</b>.` : 'Fast mode off.');
}
$('effortChip').onclick = (e) => { e.stopPropagation(); ctxMenu(e, EFFORTS.map((v) => [(cur?.effort || 'off') === v ? `✓ Thinking: ${v}` : `Thinking: ${v}`, () => setEffort(v)])); };
$('fastChip').onclick = toggleFast;

// ---------- background tasks ----------
const bgTasks = new Map(), tasksLoaded = new Set(); let taskOpen = null, taskTimer = null;
const bgMap = (id) => { if (!bgTasks.has(id)) bgTasks.set(id, new Map()); return bgTasks.get(id); };
function onBgTask(ev) {
  const m = bgMap(ev.convId), prev = m.get(ev.task.id); m.set(ev.task.id, ev.task);
  if (cur?.id !== ev.convId) return;
  syncTasksChip(); if (!$('tasksPanel').hidden) renderTasks();
  if (prev?.status === 'running' && ev.task.status !== 'running') infoLine(`Background task <b>${esc(ev.task.id)}</b> ${esc(ev.task.status)}${ev.task.code != null ? ` (exit ${ev.task.code})` : ''}: <code>${esc(ev.task.command.slice(0, 80))}</code>`);
}
async function loadTasks() {
  if (!cur || tasksLoaded.has(cur.id)) return; const id = cur.id; tasksLoaded.add(id);
  const m = bgMap(id); for (const t of await gc.tasks.list(id)) m.set(t.id, t); if (cur?.id === id) syncTasksChip();
}
function syncTasksChip() {
  const l = cur ? [...bgMap(cur.id).values()] : [], run = l.filter((t) => t.status === 'running').length, b = $('tasksChip');
  b.hidden = !l.length; b.textContent = run ? `▶ ${run} running` : `▶ ${l.length} task${l.length > 1 ? 's' : ''}`; b.classList.toggle('on', !!run);
}
function renderTasks() {
  const p = $('tasksPanel'), l = cur ? [...bgMap(cur.id).values()] : [];
  p.innerHTML = '<div class="fp-head"><b>Background tasks</b><span class="grow"></span><button type="button" class="mini" id="tkClear">Clear finished</button><button type="button" class="fp-x" id="tkX">✕</button></div>';
  p.querySelector('#tkX').onclick = closePanels; p.querySelector('#tkClear').onclick = async () => { const keep = await gc.tasks.clear(cur.id); const m = bgMap(cur.id); m.clear(); keep.forEach((t) => m.set(t.id, t)); syncTasksChip(); renderTasks(); };
  if (!l.length) p.insertAdjacentHTML('beforeend', '<div class="fp-empty">No background tasks. When Claude starts a dev server or a long command in the background, it shows up here.</div>');
  for (const t of l) {
    const r = document.createElement('div'); r.className = 'fp-row';
    r.innerHTML = `<div class="t"><b title="${esc(t.command)}">${esc(t.command)}</b><span class="st-${t.status === 'running' ? 'running' : t.status === 'failed' ? 'failed' : ''}">${esc(t.status)}</span></div>`;
    const t0 = r.querySelector('.t');
    const v = document.createElement('button'); v.type = 'button'; v.className = 'mini'; v.textContent = taskOpen === t.id ? 'Hide' : 'Output'; v.onclick = () => { taskOpen = taskOpen === t.id ? null : t.id; renderTasks(); }; t0.append(v);
    if (t.status === 'running') { const s = document.createElement('button'); s.type = 'button'; s.className = 'mini'; s.textContent = 'Stop'; s.onclick = () => gc.tasks.stop(t.id); t0.append(s); }
    if (taskOpen === t.id) { const pre = document.createElement('pre'); pre.textContent = 'Loading…'; r.append(pre); gc.tasks.output(t.id, 6000).then((o) => { pre.textContent = o?.output || '(no output yet)'; pre.scrollTop = 1e9; }); }
    p.append(r);
  }
}
$('tasksChip').onclick = (e) => { e.stopPropagation(); const open = $('tasksPanel').hidden; closePanels(); if (open) { $('tasksPanel').hidden = false; renderTasks(); clearInterval(taskTimer); taskTimer = setInterval(() => { if ($('tasksPanel').hidden) clearInterval(taskTimer); else if (taskOpen) renderTasks(); }, 2500); } };

// ---------- follow-ups ----------
const backlogs = new Map();
async function loadBacklog() { if (!cur) return; const id = cur.id, l = await gc.backlog.list(id); backlogs.set(id, l); if (cur?.id === id) { syncFollowChip(); if (!$('followPanel').hidden) renderFollow(); } }
const onBacklog = (ev) => { if (cur?.id === ev.convId) { loadBacklog(); infoLine('Added a task to the follow-up list.'); } };
function syncFollowChip() {
  const n = (cur && backlogs.get(cur.id) || []).filter((b) => !b.done).length, b = $('followChip');
  b.hidden = !n; b.textContent = `☐ ${n} follow-up${n > 1 ? 's' : ''}`;
}
function renderFollow() {
  const p = $('followPanel'), l = (cur && backlogs.get(cur.id)) || [];
  p.innerHTML = '<div class="fp-head"><b>Follow-ups</b><span class="hint">Noted by Claude, not started</span><span class="grow"></span><button type="button" class="fp-x" id="flX">✕</button></div>';
  p.querySelector('#flX').onclick = closePanels;
  const open = l.filter((b) => !b.done); if (!open.length) p.insertAdjacentHTML('beforeend', '<div class="fp-empty">Nothing pending.</div>');
  for (const it of open) {
    const r = document.createElement('div'); r.className = 'fp-row';
    r.innerHTML = `<div class="t"><b title="${esc(it.title)}">${esc(it.title)}</b></div>${it.detail ? `<div class="d">${esc(it.detail)}</div>` : ''}`;
    const t0 = r.querySelector('.t');
    const go = document.createElement('button'); go.type = 'button'; go.className = 'mini'; go.textContent = 'Start session'; go.onclick = () => startFollow(it); t0.append(go);
    const dn = document.createElement('button'); dn.type = 'button'; dn.className = 'mini'; dn.textContent = 'Dismiss'; dn.onclick = async () => { backlogs.set(cur.id, await gc.backlog.update(cur.id, it.id, { remove: true })); syncFollowChip(); renderFollow(); }; t0.append(dn);
    p.append(r);
  }
}
async function startFollow(it) {
  const src = cur.id, cwd = cur.cwd; closePanels();
  await newCode(cwd); if (!cur || cur.id === src) return;
  $('input').value = it.title + (it.detail ? '\n\n' + it.detail : ''); autosize(); $('input').focus();
  backlogs.set(src, await gc.backlog.update(src, it.id, { done: true }));
}
$('followChip').onclick = (e) => { e.stopPropagation(); const open = $('followPanel').hidden; closePanels(); if (open) { $('followPanel').hidden = false; renderFollow(); } };

// ---------- side questions ----------
const sideHist = new Map();
function renderSide() {
  const log = $('sideLog'), h = (cur && sideHist.get(cur.id)) || []; log.innerHTML = '';
  if (!h.length) log.innerHTML = '<div class="fp-empty">Ask about the code, an error, or what Claude just did. The answer isn’t added to the session.</div>';
  for (const m of h) { const d = document.createElement('div'); d.className = m.role === 'user' ? 'sq' : 'sa'; d.textContent = m.text; log.append(d); }
  log.scrollTop = 1e9;
}
function openSide(q) {
  if (!cur) return toast('Open a session first');
  closePanels(); $('sidePanel').hidden = false; renderSide(); $('sideInput').focus(); if (q) askSide(q);
}
async function askSide(q) {
  if (!cur || !q.trim()) return; const id = cur.id;
  if (!sideHist.has(id)) sideHist.set(id, []); const h = sideHist.get(id), prior = h.map((m) => ({ ...m }));
  h.push({ role: 'user', text: q }); const wait = { role: 'assistant', text: 'Thinking…' }; h.push(wait); renderSide();
  const r = await gc.side(id, q, prior); wait.text = r.error ? 'Couldn’t answer: ' + r.error : r.text; if (cur?.id === id) renderSide();
}
$('sideForm').onsubmit = (e) => { e.preventDefault(); const q = $('sideInput').value.trim(); $('sideInput').value = ''; askSide(q); };
$('sideClose').onclick = closePanels;

// Task list the model keeps with todo_write: a chip with progress and a panel listing the items.
function syncTodos(list) {
  const b = $('todoChip'), l = Array.isArray(list) ? list : []; b.hidden = !l.length;
  const done = l.filter((t) => t.status === 'completed').length; b.textContent = `☑ ${done}/${l.length}`; b.classList.toggle('on', done < l.length);
  if (!$('todoPanel').hidden) renderTodos(l);
}
function renderTodos(l = cur?.todos || []) {
  const p = $('todoPanel'); p.innerHTML = '<div class="fp-head"><b>Task list</b><span class="grow"></span><button type="button" class="fp-x" id="tdX" title="Close">✕</button></div>';
  p.querySelector('#tdX').onclick = closePanels;
  for (const t of l) { const r = document.createElement('div'); r.className = 'fp-row'; r.innerHTML = `<div class="t"><span>${t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '▶' : '☐'}</span><b style="${t.status === 'completed' ? 'text-decoration:line-through;opacity:.6' : ''}">${esc(t.content)}</b></div>`; p.append(r); }
}
$('todoChip').onclick = (e) => { e.stopPropagation(); const open = $('todoPanel').hidden; closePanels(); if (open) { $('todoPanel').hidden = false; renderTodos(); } };
function closePanels() { for (const id of ['tasksPanel', 'followPanel', 'sidePanel', 'todoPanel']) $(id).hidden = true; }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ['tasksPanel', 'followPanel', 'sidePanel', 'todoPanel'].some((id) => !$(id).hidden)) closePanels(); });

function syncPower() {
  const e = cur?.effort || (typeof currentAgent === 'function' && currentAgent()?.effort) || 'off'; // the picked agent's own effort applies until the user sets one
  $('effortChip').hidden = $('fastChip').hidden = !cur;
  $('effortChip').textContent = 'Think: ' + e; $('effortChip').classList.toggle('on', e !== 'off'); $('fastChip').classList.toggle('on', !!cur?.fast);
  syncTasksChip(); syncFollowChip(); renderQueue();
  if (cur) { loadTasks(); if (!backlogs.has(cur.id)) loadBacklog(); }
  if (!cur) closePanels();
}

// ---------- slash commands ----------
SLASH.push(
  ['/rewind', 'Go back to your last message and undo file changes', rewindLast],
  ['/btw', 'Ask a side question without touching the session: /btw <question>', () => { $('input').value = '/btw '; autosize(); $('input').focus(); }],
  ['/effort', 'Set extended thinking: /effort off|low|medium|high', () => { $('input').value = '/effort '; autosize(); $('input').focus(); }],
  ['/fast', 'Toggle fast mode (uses the fast model from Settings)', toggleFast],
  ['/tasks', 'Show background tasks', () => { $('tasksChip').hidden ? toast('No background tasks in this session') : $('tasksChip').click(); }],
  ['/followups', 'Show follow-up tasks Claude noted', () => { $('followChip').hidden ? toast('No follow-ups yet') : $('followChip').click(); }],
  ['/split', 'Open this session side by side in a new window', () => cur && gc.splitWindow(cur.id)],
  ['/palette', 'Open the command palette', () => openPalette()],
);
// "/btw <q>" and "/effort <level>" carry text, so send() hands them here first. Returns true when it handled the input.
function powerSlash(text) {
  const b = text.match(/^\/btw\s+(.+)$/s);
  if (b) { $('input').value = ''; $('slash').hidden = true; autosize(); openSide(b[1].trim()); return true; }
  const f = text.match(/^\/effort\s+(\S+)\s*$/i);
  if (f) {
    $('input').value = ''; $('slash').hidden = true; autosize();
    const v = f[1].toLowerCase(); if (EFFORTS.includes(v)) setEffort(v); else infoLine('Use <code>/effort off</code>, <code>low</code>, <code>medium</code> or <code>high</code>.');
    return true;
  }
  return false;
}

// ---------- command palette ----------
let palItems = [], palShown = [], palSel = 0;
async function buildPalette() {
  const act = (label, run, hint = '') => ({ group: 'Commands', label, hint, run });
  const items = [
    act('New chat', () => { setView('chat', false); goHome(); $('input').focus(); }), act('New code session…', () => newCode()),
    act('Reopen closed session', reopen, '⇧⌘T'), act('Open settings', openSettings, '⌘,'),
    act('Toggle sidebar', () => setSidebar(!document.body.classList.contains('nosidebar'))), act('Toggle terminal', () => toggle('term'), '⌃`'), act('Toggle changes pane', () => toggle('diff'), '⇧⌘D'),
    act('Find in conversation', () => { $('findbar').hidden = false; $('findInput').focus(); }, '⌘F'),
    act('Rewind to last message', rewindLast), act('Ask a side question', () => openSide()), act('Open session side by side', () => cur && gc.splitWindow(cur.id)), act('Open session stacked', () => cur && gc.splitWindow(cur.id, true)),
    act('Open session in new window', () => cur && gc.newWindow(cur.id)), act('Toggle fast mode', toggleFast),
    ...EFFORTS.map((v) => act(`Extended thinking (effort): ${v}`, () => setEffort(v))),
    act('Export conversation as Markdown', () => cur && gc.conv.export(cur.id)),
    act('Plan mode', () => setMode('plan')), act('Accept edits mode', () => setMode('acceptEdits')), act('Ask before each change', () => setMode('default')),
  ];
  if (!$('tasksChip').hidden) items.push(act('Show background tasks', () => $('tasksChip').click()));
  if (!$('followChip').hidden) items.push(act('Show follow-ups', () => $('followChip').click()));
  const seen = new Set(items.map((i) => i.label.toLowerCase()));
  for (const s of allSlash()) if (!seen.has(s[1].toLowerCase())) items.push({ group: 'Slash commands', label: s[0] + '  ' + s[1], hint: '', run: () => ($('input').value = '', s[2]()) });
  document.querySelectorAll('#settings .rail [data-tab]').forEach((b) => items.push({ group: 'Settings', label: 'Settings: ' + b.textContent.trim(), hint: '', run: async () => { await openSettings(); showTab(b.dataset.tab); } }));
  try { for (const c of await gc.conv.list('')) items.push({ group: 'Sessions', label: c.title || 'Untitled', hint: (c.cwd ? c.cwd.split('/').pop() + ' · ' : '') + c.mode, run: () => open(c.id) }); } catch {}
  return items;
}
function renderPalette() {
  const q = $('palInput').value.toLowerCase().split(/\s+/).filter(Boolean), box = $('palList'); box.innerHTML = '';
  palShown = palItems.filter((i) => q.every((t) => (i.label + ' ' + i.group).toLowerCase().includes(t))).slice(0, 60);
  palSel = Math.min(palSel, Math.max(0, palShown.length - 1));
  let g = null;
  palShown.forEach((it, i) => {
    if (it.group !== g) { g = it.group; const h = document.createElement('div'); h.className = 'ph'; h.textContent = g; box.append(h); }
    const d = document.createElement('div'); if (i === palSel) d.className = 'on'; d.innerHTML = `<span>${esc(it.label)}</span><small>${esc(it.hint)}</small>`;
    d.onclick = () => runPalette(it); box.append(d);
  });
  if (!palShown.length) box.innerHTML = '<div class="ph">No matches</div>';
  box.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
}
function closePalette() { $('palette').hidden = true; }
function runPalette(it) { closePalette(); setTimeout(() => it.run(), 0); }
async function openPalette() {
  if (!$('palette').hidden) return closePalette();
  $('palette').hidden = false; $('palInput').value = ''; palSel = 0; palItems = []; renderPalette(); $('palInput').focus();
  palItems = await buildPalette(); renderPalette();
}
$('palInput').addEventListener('input', () => { palSel = 0; renderPalette(); });
$('palInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); palSel = Math.min(palSel + 1, palShown.length - 1); renderPalette(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); palSel = Math.max(palSel - 1, 0); renderPalette(); }
  else if (e.key === 'Enter') { e.preventDefault(); if (palShown[palSel]) runPalette(palShown[palSel]); }
  else if (e.key === 'Escape') closePalette();
});
$('palette').addEventListener('mousedown', (e) => { if (e.target === $('palette')) closePalette(); });
syncPower(); // the first syncComposer() can run before this file has loaded
