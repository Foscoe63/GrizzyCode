const $ = (id) => document.getElementById(id);
const MODES = { default: 'Ask permissions', acceptEdits: 'Accept edits', plan: 'Plan mode', bypassPermissions: 'Bypass permissions' };
let cur = null, live = null, settings = {}, order = [], atts = [], providerCache = [];
let modInfo = { band: false, panes: [], status: [], commands: [], messageHooks: false, working: false };
let viewMode = 'chat', homeFolder = null, useWt = false, homeSsh = null; const shut = new Set(), expanded = new Set();
try { viewMode = localStorage.getItem('gc.view') === 'code' ? 'code' : 'chat'; } catch {}
const busy = new Set(); const hist = []; let hpos = -1; let lastHolder = null;

// ---------- markdown (escaped, minimal) ----------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function inline(s) {
  return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>').replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
}
function md(src) {
  const out = []; let list = null;
  const flush = () => { if (list) { out.push(`</${list}>`); list = null; } };
  src.split(/```/).forEach((p, i) => {
    if (i % 2) { flush(); out.push('<pre><code>' + esc(p.replace(/^[^\n]*\n/, '')) + '</code></pre>'); return; }
    for (const line of p.split('\n')) {
      let m;
      if ((m = line.match(/^(#{1,3})\s+(.*)/))) { flush(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); }
      else if ((m = line.match(/^>\s?(.*)/))) { flush(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); }
      else if ((m = line.match(/^\s*[-*]\s+(.*)/))) { if (list !== 'ul') { flush(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
      else if ((m = line.match(/^\s*\d+\.\s+(.*)/))) { if (list !== 'ol') { flush(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
      else if (line.trim()) { flush(); out.push(`<p>${inline(line)}</p>`); } else flush();
    }
    flush();
  });
  return out.join('');
}
function decorate(el) {
  el.querySelectorAll('pre:not([data-c])').forEach((pre) => {
    pre.dataset.c = 1; const b = document.createElement('button'); b.className = 'copy'; b.type = 'button'; b.textContent = 'Copy';
    b.onclick = () => { navigator.clipboard.writeText(pre.innerText.replace(/^Copy\n?/, '')); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1200); };
    pre.appendChild(b);
  });
}
const setMd = (el, text) => { el._raw = text; el.innerHTML = md(text); decorate(el); if (typeof modInfo !== 'undefined' && modInfo.messageHooks) modMask(el, text); };

// ---------- message rendering ----------
function bubble(role) {
  const d = document.createElement('div'); d.className = 'msg ' + role;
  const b = document.createElement('div'); b.className = 'b'; d.appendChild(b); d.appendChild(msgActions(role, d, b));
  $('msgs').appendChild(d); return b;
}
// Copy / edit icon buttons under each bubble (shown on hover).
const IC = {
  copy: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.8"/><path d="M10.5 3.5v-.2A1.8 1.8 0 0 0 8.7 1.5H3.8a1.8 1.8 0 0 0-1.8 1.8v4.9a1.8 1.8 0 0 0 1.8 1.8h.2"/></svg>',
  check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 4.8"/></svg>',
  edit: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10.8 2.7l2.5 2.5M2.5 13.5l.5-3L11.3 2.2a1.2 1.2 0 0 1 1.7 0l.8.8a1.2 1.2 0 0 1 0 1.7L5.5 13l-3 .5z"/></svg>',
};
const bubbleText = (b) => (b._raw != null ? b._raw : [...b.children].map((c) => (c._raw != null ? c._raw : '')).join(''));
function msgActions(role, d, b) {
  const bar = document.createElement('div'); bar.className = 'acts';
  const mk = (kind, title, fn) => { const x = document.createElement('button'); x.type = 'button'; x.className = 'act'; x.title = title; x.setAttribute('aria-label', title); x.innerHTML = IC[kind]; x.onclick = (e) => { e.stopPropagation(); fn(x); }; bar.appendChild(x); return x; };
  mk('copy', 'Copy', async (x) => {
    const t = bubbleText(b) || b.innerText || '';
    try { await navigator.clipboard.writeText(t); } catch { return toast('Couldn’t copy'); }
    x.innerHTML = IC.check; x.classList.add('ok'); setTimeout(() => { x.innerHTML = IC.copy; x.classList.remove('ok'); }, 1200);
  });
  mk('edit', role === 'user' ? 'Edit and resend' : 'Edit reply', () => (role === 'user' ? editPrompt(d) : editReply(b)));
  return bar;
}
// Edit a prompt: rewind the conversation to it (files untouched) and put its text back in the composer.
async function editPrompt(row) {
  if (!cur) return; const id = cur.id;
  if (busy.has(id)) return toast('Stop the running task first');
  const n = [...$('msgs').querySelectorAll('.msg.user')].indexOf(row);
  const c = await gc.conv.get(id), idx = humanIdx(c)[n];
  if (idx == null) return toast('Can’t edit that message');
  await doRewind(id, idx, false);
}
// Edit a reply in place; saved to the conversation.
function editReply(b) {
  if (!cur) return; if (busy.has(cur.id)) return toast('Stop the running task first');
  if (b.querySelector(':scope > .editbox')) return;
  const old = bubbleText(b), id = cur.id;
  const box = document.createElement('div'); box.className = 'editbox';
  const ta = document.createElement('textarea'); ta.value = old; ta.rows = Math.min(24, Math.max(4, old.split('\n').length + 1));
  const row = document.createElement('div'); row.className = 'editrow';
  const save = document.createElement('button'); save.type = 'button'; save.className = 'primary'; save.textContent = 'Save';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
  row.append(cancel, save); box.append(ta, row);
  const hidden = [...b.children].filter((c) => c !== box); hidden.forEach((c) => (c.hidden = true)); b.appendChild(box); ta.focus();
  const close = () => { box.remove(); hidden.forEach((c) => (c.hidden = false)); };
  cancel.onclick = close;
  save.onclick = async () => {
    const t = ta.value; if (t === old) return close();
    const r = await gc.conv.editText(id, old, t); if (r.error) return toast(r.error);
    const c = await gc.conv.get(id); renderConv(c);
  };
}
const KIND = { read_file: 'read', list_dir: 'read', grep: 'read', write_file: 'edit', edit_file: 'edit', bash: 'run', delegate_agent: 'agent', message_agent: 'agent' };
function toolBox(name, input, output, id) {
  const d = document.createElement('details'); d.className = 'tool'; if (id) d.dataset.id = id;
  const s = document.createElement('summary');
  const brief = input.command || input.path || input.pattern || input.agent || input.id || '';
  s.innerHTML = `<span class="kind">${esc(KIND[name] || (name.startsWith('mcp__') ? 'mcp' : 'tool'))}</span><span>${esc(name.replace(/^mcp__/, '').replace('__', ' · '))} ${esc(String(brief).slice(0, 90))}</span>`;
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(input, null, 2) + (output != null ? '\n\n' + output : '');
  if (output != null && /^ERROR/.test(output)) d.classList.add('err');
  d.append(s, pre); if (modInfo.messageHooks) modMaskTool(d, s, pre, name, input, output); return d;
}
function userBubble(content) {
  const b = bubble('user'); attachRewind(b.parentElement);
  b._raw = typeof content === 'string' ? content : content.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
  if (typeof content === 'string') { b.textContent = content; if (modInfo.messageHooks) modMaskUser(b, content); return; }
  for (const blk of content) {
    if (blk.type === 'image') { const i = document.createElement('img'); i.className = 'att'; i.src = `data:${blk.source.media_type};base64,${blk.source.data}`; b.appendChild(i); }
    else if (blk.type === 'text') b.appendChild(document.createTextNode(blk.text));
  }
}
function renderConv(c) {
  liveOutputs = []; cur = c; live = null; lastHolder = null; showTerm(); modSession(); rsRefresh();
  $('msgs').innerHTML = '';
  $('title').textContent = c.title;
  if (typeof hidePage === 'function') hidePage();
  setView(c.mode, false); homeFolder = c.mode === 'code' ? c.cwd : null; syncHome();
  const results = {};
  for (const m of c.messages) if (Array.isArray(m.content)) for (const b of m.content) if (b.type === 'tool_result') results[b.tool_use_id] = b.content;
  for (const m of c.messages) {
    if (m.role === 'user') { if (typeof m.content === 'string' || m.content.some((b) => b.type !== 'tool_result')) userBubble(m.content); continue; }
    const b = bubble('assistant');
    for (const blk of m.content) {
      if (blk.type === 'text') { const d = document.createElement('div'); setMd(d, blk.text); b.appendChild(d); }
      else if (blk.type === 'tool_use') b.appendChild(toolBox(blk.name, blk.input, results[blk.id], blk.id));
    }
  }
  if (busy.has(c.id)) typing(true);
  $('msgs').scrollTop = 1e9;
  syncComposer(); syncBranch();
  document.querySelectorAll('.item').forEach((e) => e.classList.toggle('on', e.dataset.id === c.id));
  refreshDiff();
}
const toast = (m) => { const t = $('toast'); t.textContent = m; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2200); };
function setView(v, home = true) {
  viewMode = v; try { localStorage.setItem('gc.view', v); } catch {}
  document.body.classList.toggle('chatview', v === 'chat');
  $('viewChat').classList.toggle('on', v === 'chat'); $('viewCode').classList.toggle('on', v === 'code');
  if (home && cur && cur.mode !== v) goHome(); else if (home && !cur) goHome();
  refreshList(); syncComposer();
}
function syncHome() {
  const empty = !cur || (!cur.messages.length && !$('msgs').children.length);
  document.body.classList.toggle('home', empty);
  const code = viewMode === 'code';
  $('homeTitle').textContent = code ? 'New session' : 'Let’s get started';
  $('emptySub').textContent = code ? '' : 'Ask a question, or switch to Code to work in a folder.';
  $('envCard').hidden = !(empty && code && !cur);
  if (!$('envCard').hidden) renderEnv();
  $('dirName').textContent = (cur?.cwd || homeSsh?.cwd || homeFolder || 'Choose folder').split('/').pop() || '/';
}
function renderEnv() {
  const l = $('envList'); l.innerHTML = '';
  const fs = [...new Set([...(settings.pinnedFolders || []), ...(settings.trustedFolders || [])])].slice(0, 5);
  for (const f of fs) {
    const d = document.createElement('div'); d.title = f; if (f === homeFolder) d.className = 'on';
    d.innerHTML = `${ICON.laptop}<span>${esc(f.split('/').pop() || f)}</span>`;
    d.onclick = () => { homeFolder = f; syncHome(); $('input').focus(); }; l.appendChild(d);
  }
}
const ICON = { laptop: '<svg viewBox="0 0 16 16"><rect x="3" y="3.5" width="10" height="7" rx="1"/><path d="M2 12.5h12"/></svg>' };
function goHome() {
  if (typeof hidePage === 'function') hidePage();
  cur = null; live = null; $('msgs').innerHTML = ''; $('title').textContent = viewMode === 'code' ? 'New session' : ''; modSession(); rsRefresh();
  $('branch').hidden = true; syncHome(); syncComposer(); refreshList(); refreshDiff();
}
function typing(on) {
  document.getElementById('typing')?.remove();
  if (!on) return;
  const d = document.createElement('div'); d.id = 'typing'; d.className = 'msg assistant'; d.innerHTML = '<div class="typing"><i></i><i></i><i></i></div>';
  $('msgs').appendChild(d);
}

// ---------- sidebar ----------
async function refreshList() {
  const q = $('search').value;
  const items = (await gc.conv.list(q)).filter((i) => i.mode === viewMode);
  const l = $('list'); l.innerHTML = ''; order = [];
  const add = (it) => {
    order.push(it.id);
    const d = document.createElement('div'); d.className = 'item' + (cur?.id === it.id ? ' on' : ''); d.dataset.id = it.id;
    d.innerHTML = `<span class="t">${esc(it.title)}</span>${busy.has(it.id) ? '<span class="dot"></span>' : ''}`;
    d.onclick = () => open(it.id);
    d.oncontextmenu = (e) => { e.preventDefault(); ctxMenu(e, [
      ['Rename…', async () => { const t = prompt('Rename', it.title); if (t) { await gc.conv.update(it.id, { title: t }); refreshList(); if (cur?.id === it.id) $('title').textContent = t; } }],
      [it.pinned ? 'Unpin' : 'Pin', async () => { await gc.conv.update(it.id, { pinned: !it.pinned }); refreshList(); }],
      ...(it.mode === 'code' && it.cwd ? [[settings.pinnedFolders.includes(it.cwd) ? 'Unpin folder' : 'Pin folder', () => togglePinFolder(it.cwd)], ['New session in this folder', () => newCode(it.cwd)]] : []),
      ['Open in new window', () => gc.newWindow(it.id)], ['Open side by side', () => gc.splitWindow(it.id)], null,
      ['Close session', () => closeSession(it.id)],
      ['Delete…', async () => { if (await gc.confirm('Delete this conversation?', 'This cannot be undone.', 'Delete')) { const r = await gc.conv.remove(it.id); if (cur?.id === it.id) goHome(); refreshList(); if (r && !r.removed) gc.confirm('Worktree kept', `The session’s worktree was left on disk (${r.reason}). Remove it manually with git worktree remove.`, 'OK'); } }],
    ]); };
    l.appendChild(d);
  };
  const group = (key, html, { plus, folder } = {}) => {
    const g = document.createElement('div'); g.className = 'group' + (shut.has(key) ? ' shut' : '');
    g.innerHTML = `<span class="gt">${html}</span>${plus ? '<button class="plus" title="New session" type="button">＋</button>' : ''}<span class="car">▾</span>`;
    g.onclick = () => { shut.has(key) ? shut.delete(key) : shut.add(key); refreshList(); };
    if (plus) g.querySelector('.plus').onclick = (e) => { e.stopPropagation(); newCode(folder); };
    if (folder) { g.title = folder; g.oncontextmenu = (e) => { e.preventDefault(); ctxMenu(e, [[settings.pinnedFolders.includes(folder) ? 'Unpin folder' : 'Pin folder', () => togglePinFolder(folder)], ['New session here', () => newCode(folder)]]); }; }
    l.appendChild(g); return !shut.has(key);
  };
  const run = (key, list, limit = 5) => {
    const all = expanded.has(key), vis = all ? list : list.slice(0, limit);
    vis.forEach(add);
    if (list.length > limit) { const m = document.createElement('div'); m.className = 'more'; m.textContent = all ? 'Show less' : 'Show more'; m.onclick = () => { all ? expanded.delete(key) : expanded.add(key); refreshList(); }; l.appendChild(m); }
  };
  if (q) { items.forEach(add); return; }
  const pinned = items.filter((i) => i.pinned), rest = items.filter((i) => !i.pinned);
  if (pinned.length && group('pinned', 'Pinned')) run('pinned', pinned, 99);
  if (viewMode === 'chat') { if (rest.length && group('recents', 'Recents')) run('recents', rest, 12); return; }
  const by = new Map(); for (const f of settings.pinnedFolders || []) by.set(f, []);
  for (const it of rest) { if (!by.has(it.cwd)) by.set(it.cwd, []); by.get(it.cwd).push(it); }
  for (const [f, list] of by) {
    const parent = f.split('/').slice(0, -1).join('/');
    if (group('f:' + f, `${esc(f.split('/').pop() || f)} <i>· ${esc(parent)}</i>`, { plus: true, folder: f })) run('f:' + f, list);
  }
}
const clearView = goHome;
async function open(id, push = true) {
  const c = await gc.conv.get(id);
  if (push) { hist.splice(hpos + 1); hist.push(id); hpos = hist.length - 1; }
  renderConv(c); clearSuggest(); refreshList(); $('input').focus();
}
async function togglePinFolder(f) {
  const set = new Set(settings.pinnedFolders); set.has(f) ? set.delete(f) : set.add(f);
  settings = await gc.settings.set({ pinnedFolders: [...set] }); refreshList();
}
function ctxMenu(e, items) {
  const m = $('ctx'); m.innerHTML = '';
  for (const it of items) {
    if (!it) { m.appendChild(document.createElement('hr')); continue; }
    const d = document.createElement('div'); d.textContent = it[0]; d.onclick = () => { m.hidden = true; it[1](); }; m.appendChild(d);
  }
  m.hidden = false; m.style.left = Math.min(e.clientX, innerWidth - 210) + 'px'; m.style.top = Math.min(e.clientY, innerHeight - m.offsetHeight - 8) + 'px';
}
document.addEventListener('click', () => { $('ctx').hidden = true; });

// ---------- sessions ----------
async function newChat() {
  setView('chat', false);
  const c = await gc.conv.create({ mode: 'chat' }); await open(c.id);
}
async function newCode(folder) {
  if (homeSsh && !folder) { setView('code', false); const c = await gc.conv.create({ mode: 'code', cwd: homeSsh.cwd, ssh: { host: homeSsh.host } }); await open(c.id); return; }
  const cwd = folder || await gc.pickFolder(); if (!cwd) return;
  if (!settings.trustedFolders.includes(cwd)) {
    if (!(await gc.confirm(`Trust ${cwd} and start a code session?`, 'GrizzyCode can read files in this folder and, depending on the permission mode, edit files and run commands here.', 'Trust folder'))) return;
    settings = await gc.settings.set({ trustedFolders: [...settings.trustedFolders, cwd] });
  }
  setView('code', false);
  let create = { mode: 'code', cwd };
  if (useWt) {
    const wt = await gc.git.worktreeAdd(cwd, cwd.split('/').pop());
    if (wt.error) { await gc.confirm('Could not create a worktree', wt.error + ' The session will use the folder directly.', 'OK'); }
    else create = { mode: 'code', cwd: wt.path, worktree: wt };
  }
  const c = await gc.conv.create(create); await open(c.id);
  if (settings.newTaskPrompt) { $('input').value = settings.newTaskPrompt; $('input').dispatchEvent(new Event('input')); }
}
async function closeSession(id) {
  if (busy.has(id)) stopRun(id);
  await gc.conv.close(id);
  if (cur?.id === id) { const i = order.indexOf(id); await refreshList(); const next = order[i] || order[i - 1]; next ? open(next) : clearView(); } else refreshList();
}
async function reopen() { const c = await gc.conv.reopen(); if (c) { await open(c.id); } }
const step = (d) => { if (!order.length) return; const i = order.indexOf(cur?.id); open(order[(i + d + order.length) % order.length]); };

// ---------- composer ----------
function syncComposer() {
  const code = cur?.mode === 'code';
  const codeUi = viewMode === 'code';
  $('envName').textContent = (cur?.ssh || homeSsh) ? 'SSH · ' + (cur?.ssh?.host || homeSsh.host) : 'This computer'; $('envChip').classList.toggle('on', !!(cur?.ssh || homeSsh));
  $('wtChip').hidden = !codeUi || !!cur || !!homeSsh; $('wtChip').classList.toggle('on', useWt);
  const ms = $('modeSel'); ms.hidden = !codeUi; $('envChip').hidden = $('dirChip').hidden = !codeUi;
  if (cur) syncHome(); else $('dirName').textContent = (homeFolder || 'Choose folder').split('/').pop();
  ms.innerHTML = Object.entries(MODES).filter(([k]) => k !== 'bypassPermissions' || settings.allowBypass !== false || cur?.permissionMode === 'bypassPermissions').map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  ms.value = cur?.permissionMode || settings.permissionMode || 'default'; if (!ms.value) ms.value = 'default';
  ms.className = { default: 'mode-ask', acceptEdits: 'mode-accept', plan: 'mode-plan', bypassPermissions: 'mode-bypass' }[ms.value];
  syncModelLabel(); renderAgentPicker();
  renderCtx(); if (typeof syncPower === 'function') syncPower(); // power.js loads after this file; it syncs itself once it has loaded
  const run = cur && busy.has(cur.id);
  $('sendBtn').textContent = run ? '■' : '↑'; $('sendBtn').classList.toggle('stop', !!run);
  $('input').placeholder = viewMode === 'code' ? 'Describe a task or ask a question  (/ for commands)' : 'How can I help you today?';
}
const niceModel = (m) => { const x = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(m); return x ? `${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}.${x[3]}` : m; };
const savedLine = (x) => `router ${fmt(x.router || 0)} · output compression ${fmt(x.outputs || 0)} · compaction ${fmt(x.compact || 0)} tokens`;
async function renderSavings() {
  const st = await gc.savings.stats(cur?.id || ''); const t = st.total;
  $('savingsStats').innerHTML = `<b>Saved so far</b> (estimated): ${esc(savedLine(t))}<br>${t.routerRequests} requests used the router · ${t.outputsCompressed} outputs compressed · ${t.compactions} conversations compacted${cur ? `<br><b>This conversation:</b> ${esc(savedLine(st.conversation))}` : ''}`;
}
$('savingsReset').onclick = async () => { await gc.savings.reset(); renderSavings(); };
const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
$('modeSel').onchange = async () => {
  const v = $('modeSel').value;
  if (!cur) { settings = await gc.settings.set({ permissionMode: v }); syncComposer(); return; }
  if (v === 'bypassPermissions' && !(await gc.confirm('Run coding task in bypass permissions mode?', 'GrizzyCode will edit files and run commands without asking. Only use this in folders you trust.', 'Bypass permissions'))) { $('modeSel').value = cur.permissionMode; return; }
  cur = await gc.conv.update(cur.id, { permissionMode: v }); syncComposer();
};
$('dirChip').onclick = async () => { if (cur) return; const f = await gc.pickFolder(); if (f) { homeFolder = f; homeSsh = null; syncHome(); syncComposer(); } };
$('envChoose').onclick = $('dirChip').onclick;
$('envChip').onclick = async () => {
  if (cur) return;
  $('sshMsg').textContent = ''; $('sshHost').value = homeSsh?.host || ''; $('sshDir').value = homeSsh?.cwd || '';
  $('sshHosts').innerHTML = (await gc.ssh.hosts()).map((h) => `<option value="${esc(h)}">`).join('');
  $('sshDlg').showModal();
};
$('sshCancel').onclick = () => $('sshDlg').close();
$('sshLocal').onclick = () => { homeSsh = null; $('sshDlg').close(); syncHome(); syncComposer(); };
$('sshOk').onclick = async () => {
  const host = $('sshHost').value.trim(), dir = $('sshDir').value.trim();
  if (!host || !dir) { $('sshMsg').textContent = 'Enter a host and a remote folder.'; return; }
  $('sshMsg').textContent = 'Connecting…';
  const r = await gc.ssh.test(host, dir);
  if (!r.ok) { $('sshMsg').textContent = 'Could not connect: ' + r.error; return; }
  homeSsh = { host, cwd: r.cwd }; useWt = false; $('sshDlg').close(); syncHome(); syncComposer();
};
$('wtChip').onclick = async () => {
  if (!useWt && homeFolder && !(await gc.git.isRepo(homeFolder))) { await gc.confirm('Not a git repository', `${homeFolder} is not a git repository, so a worktree can’t be created.`, 'OK'); return; }
  useWt = !useWt; syncComposer();
};
// ---------- context ring: how full the model's window is, like Claude Desktop ----------
const CIRC = 2 * Math.PI * 7.5; let ctxMap = new Map(), liveChars = 0;
const fmtFull = (n) => Number(n || 0).toLocaleString();
function ctxState() { const used = cur?.ctx?.used || 0; const max = ctxMap.get(currentModel()) || cur?.ctx?.max || 0; return { used, max, pct: max ? Math.min(1, used / max) : 0 }; }
function renderCtx() {
  const btn = $('ctxBtn'), u = cur?.usage, running = cur && busy.has(cur.id);
  const has = cur && (cur.ctx || (u && (u.in || u.out || u.cr || u.cw)));
  btn.hidden = !(has || running); if (btn.hidden) { $('ctxPop').hidden = true; return; }
  const { used, max, pct } = ctxState();
  $('ctxArc').style.strokeDasharray = `${pct * CIRC} ${CIRC}`;
  btn.classList.toggle('warn', pct >= 0.8 && pct < 0.95); btn.classList.toggle('full', pct >= 0.95);
  $('tok').textContent = running && liveChars ? `↓ ≈${fmt(Math.round(liveChars / 4))}` : max ? `${Math.round(pct * 100)}%` : fmt(used);
  btn.title = max ? `Context window: ${fmtFull(used)} of ${fmtFull(max)} tokens (${Math.round(pct * 100)}%)` : `Context: ${fmtFull(used)} tokens`;
}
function ctxPopHtml() {
  const { used, max, pct } = ctxState(); const u = cur?.usage || {}; const r = (l, v) => `<div class="r"><span>${l}</span><b>${fmtFull(v)}</b></div>`;
  const total = (u.in || 0) + (u.out || 0) + (u.cr || 0) + (u.cw || 0);
  return `<h4>Context window</h4><div class="big">${fmt(used)} <span>${max ? `of ${fmt(max)} tokens` : 'tokens'}</span></div>
    ${max ? `<div class="bar ${pct >= 0.95 ? 'full' : pct >= 0.8 ? 'warn' : ''}"><i style="width:${(pct * 100).toFixed(1)}%"></i></div><div class="sub">${Math.round(pct * 100)}% used · ${fmt(Math.max(0, max - used))} left</div>` : '<div class="sub">This model’s window size isn’t reported by its provider.</div>'}
    ${pct >= 0.9 ? '<div class="warnTxt">Almost full. Start a new session to keep going.</div>' : ''}
    <h4>This session</h4>${r('Input', u.in)}${r('Output', u.out)}${r('Cache read', u.cr)}${r('Cache write', u.cw)}${r('Total tokens', total)}
    <div class="act"><button type="button" class="outline" id="ctxUsage">All usage…</button></div>`;
}
$('ctxBtn').onclick = () => { const p = $('ctxPop'); if (!p.hidden) { p.hidden = true; return; } p.innerHTML = ctxPopHtml(); p.hidden = false; $('ctxUsage').onclick = async () => { p.hidden = true; await openSettings(); showTab('usage'); }; };
document.addEventListener('mousedown', (e) => { if (!$('ctxPop').hidden && !e.target.closest('#ctxWrap')) $('ctxPop').hidden = true; });
function infoLine(html) { const d = document.createElement('div'); d.className = 'sysnote'; d.innerHTML = html; $('msgs').appendChild(d); $('msgs').scrollTop = 1e9; }

// ---------- model picker: searchable, grouped by provider ----------
let catalog = { groups: [], current: '' }, modelRows = [], modelSel = 0;
const modelNames = new Map();
const splitModel = (v) => { const i = String(v || '').indexOf(':'); return i > 0 && providerCache.some((p) => p.id === v.slice(0, i)) ? { id: v.slice(0, i), model: v.slice(i + 1) } : null; };
const bareId = (v) => splitModel(v)?.model ?? String(v || '');
const modelLabel = (v) => modelNames.get(v) || niceModel(bareId(v));
const canonModel = (m) => (splitModel(m) ? m : catalogCanon(m));
const currentModel = () => canonModel(cur?.model || settings.model);
function catalogCanon(m) { // bare ids follow the default provider (mirrors the main process)
  if (String(m).startsWith('grizzy:')) return m; // Grizzy agent (Claude Code CLI)
  const base = settings.baseUrl || '';
  if (settings.provider === 'anthropic' && !base) return 'anthropic:' + m;
  if (/openrouter\.ai/i.test(base)) return 'openrouter:' + m;
  return m;
}
function syncModelLabel() { const m = currentModel(); $('modelLabel').textContent = modelLabel(m) || 'Model'; }
async function loadCatalog(force) {
  if (!providerCache.length) await loadProviders();
  try { catalog = await gc.models.list(force); } catch { return; }
  modelNames.clear(); ctxMap = new Map(); for (const g of catalog.groups) for (const m of g.models) if (m.ctx) ctxMap.set(m.value, m.ctx);
  for (const g of catalog.groups) for (const m of g.models) modelNames.set(m.value, g.id === 'openrouter' ? m.name : (m.name !== m.id ? m.name : niceModel(m.id)));
  syncModelLabel(); renderCtx();
}
const GKEY = 'gc.modelGroups';
const groupState = () => { try { return JSON.parse(localStorage.getItem(GKEY) || '{}'); } catch { return {}; } };
const isCollapsed = (g) => { const st = groupState(); return g.id in st ? !!st[g.id] : g.models.length > 60; };
function toggleGroup(g) { const st = groupState(); st[g.id] = !isCollapsed(g); try { localStorage.setItem(GKEY, JSON.stringify(st)); } catch {} renderModelList(); }
function renderModelList() {
  const q = $('modelSearch').value.trim().toLowerCase(), words = q.split(/\s+/).filter(Boolean), box = $('modelList'); box.innerHTML = ''; modelRows = [];
  const cm = currentModel(); let shown = 0;
  for (const g of catalog.groups) {
    const ms = g.models.filter((m) => !words.length || words.every((w) => (m.name + ' ' + m.id + ' ' + niceModel(m.id)).toLowerCase().includes(w)));
    if (!ms.length) continue;
    const open = !!words.length || !isCollapsed(g);
    const h = document.createElement('div'); h.className = 'mg'; h.setAttribute('role', 'button'); h.setAttribute('aria-expanded', String(open));
    h.innerHTML = `<span class="chev">${open ? '▾' : '▸'}</span><span class="gl">${esc(g.label)}</span><span class="cnt">${words.length ? `${ms.length} of ${g.models.length}` : g.models.length}</span>`;
    h.onmousedown = (e) => { e.preventDefault(); if (!words.length) toggleGroup(g); };
    box.appendChild(h);
    if (!open) continue;
    if ((g.note || g.error) && !words.length) { const e = document.createElement('div'); e.className = 'mgerr'; e.textContent = g.note || g.error; box.appendChild(e); }
    for (const m of ms.slice(0, 300)) {
      const d = document.createElement('div'); d.className = 'mi'; d.dataset.v = m.value; d.setAttribute('role', 'option');
      const nm = m.name === m.id ? niceModel(m.id) : m.name;
      d.innerHTML = `<span class="mn">${esc(nm)}</span>${nm !== m.id ? `<span class="mid">${esc(m.id)}</span>` : ''}${m.value === cm ? '<span class="ck">✓</span>' : ''}`;
      d.onmousedown = (e) => { e.preventDefault(); pickModel(m.value); };
      box.appendChild(d); modelRows.push(d); shown++;
    }
    if (ms.length > 300) { const t = document.createElement('div'); t.className = 'mgerr'; t.textContent = `${ms.length - 300} more — keep typing to narrow the list`; box.appendChild(t); }
  }
  if (!catalog.groups.length) box.innerHTML = '<div class="mgerr">No providers connected. Add a key in Settings → Account.</div>';
  else if (!shown && words.length) box.innerHTML = `<div class="mgerr">No models match “${esc($('modelSearch').value)}”.</div>`;
  const n = catalog.groups.reduce((a, g) => a + g.models.length, 0); $('modelFoot').textContent = `${n} models · ${catalog.groups.map((g) => g.label).join(', ') || 'none'}`;
  modelSel = Math.max(0, modelRows.findIndex((r) => r.dataset.v === cm)); markModel(true);
}
function markModel(scroll) { modelRows.forEach((r, i) => r.classList.toggle('sel', i === modelSel)); if (scroll) modelRows[modelSel]?.scrollIntoView({ block: 'nearest' }); }
async function pickModel(v) {
  closeModelMenu();
  if (cur) cur = await gc.conv.update(cur.id, { model: v }); else settings = await gc.settings.set({ model: v });
  syncModelLabel();
}
function closeModelMenu() { $('modelMenu').hidden = true; $('modelBtn').classList.remove('on'); }
async function openModelMenu() {
  if (!$('modelMenu').hidden) return closeModelMenu();
  $('modelBtn').classList.add('on'); $('modelMenu').hidden = false; $('modelSearch').value = ''; renderModelList(); $('modelSearch').focus();
  await loadCatalog(false); if (!$('modelMenu').hidden) renderModelList();
}
$('modelBtn').onclick = openModelMenu;
$('modelSearch').addEventListener('input', () => { modelSel = 0; renderModelList(); modelSel = 0; markModel(true); });
$('modelSearch').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { modelSel = Math.min(modelRows.length - 1, modelSel + 1); markModel(true); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { modelSel = Math.max(0, modelSel - 1); markModel(true); e.preventDefault(); }
  else if (e.key === 'Enter') { const r = modelRows[modelSel]; if (r) pickModel(r.dataset.v); e.preventDefault(); }
  else if (e.key === 'Escape') { closeModelMenu(); $('input').focus(); e.preventDefault(); e.stopPropagation(); }
});
document.addEventListener('mousedown', (e) => { if (!$('modelMenu').hidden && !e.target.closest('#modelWrap')) closeModelMenu(); });
loadCatalog(false); loadAgents();

function renderAtts() {
  $('atts').innerHTML = '';
  atts.forEach((a, i) => {
    const d = document.createElement('div'); d.className = a.ref ? 'att-f' : 'att-t';
    d.innerHTML = a.ref ? `<span title="${esc(a.path)}">${a.kind === 'dir' ? '📁' : '📄'} ${esc(a.name)}</span><button type="button" title="Remove">✕</button>` : `<img src="data:${a.mediaType};base64,${a.data}"><button type="button" title="Remove">✕</button>`;
    d.querySelector('button').onclick = () => { atts.splice(i, 1); renderAtts(); }; $('atts').appendChild(d);
  });
}
// Files and folders (from the picker or dropped): images go in as images; text files are included; folders as a listing; anything else by path.
async function addPaths(paths) {
  const items = await gc.attach.read(paths.filter(Boolean));
  for (const it of items) {
    if (it.kind === 'error') { toast(`Couldn’t read ${it.name}: ${it.error}`); continue; }
    if (it.kind === 'image') atts.push({ mediaType: it.mediaType, data: it.data, name: it.name }); else atts.push({ ref: true, ...it });
  }
  renderAtts();
}
function addFiles(files) {
  const paths = [];
  for (const f of files) {
    const p = gc.attach.pathOf(f);
    if (p) { paths.push(p); continue; }
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(f.type) || f.size > 5 * 1024 * 1024) continue; // pasted screenshots have no path
    const r = new FileReader(); r.onload = () => { atts.push({ mediaType: f.type, data: String(r.result).split(',')[1] }); renderAtts(); }; r.readAsDataURL(f);
  }
  if (paths.length) addPaths(paths);
}
function refsText(refs) {
  return refs.map((r) => r.kind === 'text' ? `<file path="${r.path}">\n${r.text}\n</file>` : r.kind === 'dir' ? `<folder path="${r.path}">\n${r.listing.join('\n')}\n</folder>` : `<attached-file path="${r.path}" size="${r.size || 0}" note="not included; read it with a tool if you can" />`).join('\n\n');
}
$('attach').onclick = async () => { const p = await gc.attach.pick(); if (p.length) addPaths(p); };
$('input').addEventListener('paste', (e) => { const f = [...(e.clipboardData?.files || [])]; if (f.length) { e.preventDefault(); addFiles(f); } });
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => { e.preventDefault(); addFiles([...e.dataTransfer.files]); });

const SLASH = [
  ['/plan', 'Switch to plan mode', () => setMode('plan')], ['/accept', 'Accept edits automatically', () => setMode('acceptEdits')],
  ['/ask', 'Ask before each change', () => setMode('default')], ['/bypass', 'Bypass permissions', () => { if (settings.allowBypass === false) return toast('Bypass permissions is turned off in Settings → Claude Code'); $('modeSel').value = 'bypassPermissions'; $('modeSel').onchange(); }],
  ['/clear', 'Start a fresh session here', () => (cur?.mode === 'code' ? newCode(cur.cwd) : newChat())], ['/export', 'Export as Markdown', () => cur && gc.conv.export(cur.id)],
  ['/compact', 'Summarize older messages now to free context', async () => { if (!cur) return; infoLine('Compacting…'); const r = await gc.savings.compact(cur.id); if (r.error) return infoLine(esc(r.error)); infoLine(`Compacted ${r.compacted} earlier messages (about ${fmt(r.tokensSaved)} tokens saved). Reopen the chat to see the summary.`); }],
  ['/pin', 'Pin a fact that survives compaction: /pin <fact>', () => { $('input').value = '/pin '; autosize(); $('input').focus(); }], ['/pins', 'List pinned facts', async () => { if (!cur) return; const st = await gc.savings.stats(cur.id); infoLine(st.pinned.length ? '<b>Pinned facts</b><br>' + st.pinned.map((f, i) => `${i + 1}. ${esc(f)}`).join('<br>') + '<br>Remove one with /unpin <number>.' : 'No pinned facts. Add one with /pin <fact>.'); }],
  ['/unpin', 'Remove a pinned fact: /unpin <number>', () => { $('input').value = '/unpin '; autosize(); $('input').focus(); }],
  ['/usage', 'Show token usage for this session', () => { const u = cur?.usage; if (!cur || !u || !(u.in || u.out || u.cr || u.cw)) return infoLine('No token usage yet in this session.'); const { used, max, pct } = ctxState(); infoLine(`<b>Session usage</b> · ${fmt(u.in)} in · ${fmt(u.out)} out · ${fmt(u.cr || 0)} cache read · ${fmt(u.cw || 0)} cache write<br>Context ${fmt(used)}${max ? ` of ${fmt(max)} (${Math.round(pct * 100)}%)` : ''}`); }],
  ['/terminal', 'Toggle terminal', () => toggle('term')], ['/changes', 'Toggle changes pane', () => toggle('diff')],
];
// Slash commands from installed plugins fill the composer with the command's prompt.
const allSlash = () => [...SLASH, ...modInfo.commands.map((c) => ['/' + c.name, c.description || `From the ${c.plugin} mod`, () => runModCommand(c, '')]), ...pluginCmds.map((c) => [c.name, c.description, () => { $('input').value = c.prompt.replace(/\$ARGUMENTS/g, '').trim() + ' '; autosize(); $('input').focus(); }])];
async function setMode(v) { if (cur?.mode === 'code') { cur = await gc.conv.update(cur.id, { permissionMode: v }); syncComposer(); } }
let slashSel = 0;
function showSlash() {
  const v = $('input').value; const box = $('slash');
  if (!v.startsWith('/') || v.includes(' ')) { box.hidden = true; return; }
  const m = allSlash().filter((s) => s[0].startsWith(v)); if (!m.length) { box.hidden = true; return; }
  slashSel = Math.min(slashSel, m.length - 1);
  const keep = box.scrollTop; box.innerHTML = ''; box.hidden = false;
  m.forEach((s, i) => { const d = document.createElement('div'); if (i === slashSel) d.className = 'on'; d.innerHTML = `<b>${s[0]}</b><span>${s[1]}</span>`; d.onclick = () => runSlash(s); box.appendChild(d); });
  box._m = m; box.scrollTop = keep; box.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
}
function runSlash(s) { $('input').value = ''; $('slash').hidden = true; autosize(); s[2](); }

async function send() {
  clearSuggest();
  let text = $('input').value.trim();
  if (!text && !atts.length) return;
  if (!canUse(settings)) { toast('Sign in first to start chatting'); await openSettings(); showTab('account'); return; }
  if (powerSlash(text)) return;
  const tok = text.split(/\s+/)[0]; const mc = modInfo.commands.find((c) => '/' + c.name === tok);
  if (mc) { $('input').value = ''; $('slash').hidden = true; autosize(); return runModCommand(mc, text.slice(tok.length).trim()); }
  const pinM = text.match(/^\/(pin|unpin)\s+(.+)$/s);
  if (pinM && cur) {
    $('input').value = ''; $('slash').hidden = true; autosize();
    const r = pinM[1] === 'pin' ? await gc.savings.pin(cur.id, pinM[2]) : await gc.savings.unpin(cur.id, Number(pinM[2]) - 1);
    return infoLine(r.error ? esc(r.error) : pinM[1] === 'pin' ? `Pinned (${r.pinned.length}). It will survive compaction.` : `Unpinned. ${r.pinned.length} left.`);
  }
  const cmd = allSlash().find((s) => s[0] === text); if (cmd) return runSlash(cmd);
  if (!cur) {
    if (viewMode === 'code') {
      if (homeSsh) await newCode();
      else if (!homeFolder) { toast('Choose a folder for this code session first, or switch to Chat'); const c = $('dirChip'); c.classList.remove('nudge'); void c.offsetWidth; c.classList.add('nudge'); return; }
      else await newCode(homeFolder);
    } else await newChat();
    if (!cur) return;
    if (viewMode === 'code' && ($('modeSel').value !== 'default')) cur = await gc.conv.update(cur.id, { permissionMode: $('modeSel').value });
  }
  const images = atts.filter((a) => !a.ref), refs = atts.filter((a) => a.ref); atts = []; renderAtts();
  const shown = text; if (refs.length) text = (text ? text + '\n\n' : '') + refsText(refs);
  if (busy.has(cur.id)) { enqueue(cur.id, { text, shown, images, refs }); $('input').value = ''; autosize(); return; }
  unpause(cur.id);
  $('input').value = ''; autosize(); document.body.classList.remove('home');
  userBubble(images.length ? [...images.map((a) => ({ type: 'image', source: { media_type: a.mediaType, data: a.data } })), { type: 'text', text: shown + (refs.length ? '\n' + refs.map((r) => (r.kind === 'dir' ? '📁 ' : '📄 ') + r.name).join('  ') : '') }] : shown + (refs.length ? '\n' + refs.map((r) => (r.kind === 'dir' ? '📁 ' : '📄 ') + r.name).join('  ') : ''));
  busy.add(cur.id); typing(true); syncComposer(); $('msgs').scrollTop = 1e9;
  gc.agent.send(cur.id, text, images);
}
$('composer').addEventListener('submit', (e) => { e.preventDefault(); if (cur && busy.has(cur.id)) stopRun(cur.id); else send(); });
$('input').addEventListener('keydown', (e) => {
  const box = $('slash');
  if (!box.hidden && box._m) {
    if (e.key === 'ArrowDown') { e.preventDefault(); slashSel = (slashSel + 1) % box._m.length; return showSlash(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); slashSel = (slashSel - 1 + box._m.length) % box._m.length; return showSlash(); }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); return runSlash(box._m[slashSel]); }
    if (e.key === 'Escape') { box.hidden = true; return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  if (e.key === 'Escape' && cur && busy.has(cur.id)) stopRun(cur.id);
});
const autosize = () => { const i = $('input'); i.style.height = 'auto'; i.style.height = Math.min(i.scrollHeight, 220) + 'px'; };
$('input').addEventListener('input', () => { autosize(); slashSel = 0; showSlash(); });

// ---------- agent events ----------
gc.agent.onEvent((ev) => {
  if (ev.type === 'bgtask') return onBgTask(ev);
  if (ev.type === 'backlog') return onBacklog(ev);
  if (ev.type === 'start') { busy.add(ev.convId); if (cur?.id === ev.convId) liveChars = 0; refreshList(); if (cur?.id === ev.convId) { $('title').textContent = ev.title; } return; }
  if (ev.type === 'done' || ev.type === 'error') {
    busy.delete(ev.convId);
    if (cur?.id === ev.convId) {
      typing(false);
      if (ev.type === 'error') bubble('assistant').innerHTML = `<span class="err">${esc(ev.message)}</span>`;
      live = null; syncComposer(); syncBranch(); if (document.body.classList.contains('diff')) refreshDiff();
      if (ev.type === 'done') showSuggest(ev.convId);
    }
    refreshList(); if (ev.type === 'done') flushQueue(ev.convId); else { paused.add(ev.convId); renderQueue(); } return;
  }
  if (cur?.id !== ev.convId) return;
  if (ev.type === 'tool_call' && (ev.name === 'write_file' || ev.name === 'edit_file') && ev.input?.path) { liveOutputs.unshift(ev.input.path); rsRefresh(); }
  if (ev.type === 'usage') { cur.usage = ev.usage; cur.ctx = ev.ctx; liveChars = 0; syncComposer(); rsRefresh(); if (!$('ctxPop').hidden) $('ctxPop').innerHTML = ctxPopHtml(); return; }
  if (ev.type === 'mode') { cur.permissionMode = ev.permissionMode; syncComposer(); return; }
  if (ev.type === 'info') { infoLine(esc(ev.text)); return; }
  const box = $('msgs'); const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
  typing(false);
  if (ev.type === 'text') {
    if (!live) live = { el: bubble('assistant'), text: '' };
    live.text += ev.delta; liveChars += ev.delta.length; renderCtx(); setMd(live.el, live.text); lastHolder = live.el;
  } else if (ev.type === 'tool_call') {
    const parent = ev.parentId && document.querySelector(`details[data-id="${CSS.escape(ev.parentId)}"]`);
    if (parent) { // a delegated agent's own tool call: nest it inside the delegate_agent call that started it
      let sub = parent.querySelector(':scope > .subs'); if (!sub) { sub = document.createElement('div'); sub.className = 'subs'; parent.appendChild(sub); }
      const box = toolBox(ev.name, ev.input, null, ev.id); box.querySelector('summary').insertAdjacentHTML('afterbegin', `<span class="kind">${esc(ev.agent || 'agent')}</span>`); sub.appendChild(box);
    } else {
      const holder = live?.el || bubble('assistant'); live = null; lastHolder = holder;
      holder.appendChild(toolBox(ev.name, ev.input, null, ev.id));
    }
  } else if (ev.type === 'tool_result') {
    const d = document.querySelector(`details[data-id="${CSS.escape(ev.id)}"]`);
    if (d) { d.querySelector('pre').textContent += '\n\n' + ev.output; if (/^ERROR/.test(ev.output)) d.classList.add('err'); }
    typing(busy.has(ev.convId));
  } else if (ev.type === 'approval') approvalCard(ev);
  if (stick) box.scrollTop = 1e9;
});
function approvalCard(ev) {
  const a = document.createElement('div'); a.className = 'approve';
  const row = document.createElement('div'); row.className = 'row';
  const btn = (label, cls, decision) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.className = cls; b.onclick = () => { gc.agent.approve(ev.approvalId, decision); a.remove(); typing(true); }; row.appendChild(b); };
  if (ev.plan) {
    a.innerHTML = '<div class="what"><b>Review the plan</b></div>';
    const p = document.createElement('div'); p.className = 'plan b'; setMd(p, ev.input.plan || ''); a.appendChild(p);
    btn('Approve plan & accept edits', 'primary', 'approve'); btn('Keep planning', 'outline', 'deny');
  } else {
    const brief = ev.input.command || ev.input.path || JSON.stringify(ev.input).slice(0, 140);
    a.innerHTML = `<div class="what">${ev.agent ? `<b>${esc(ev.agent)}</b> wants to use ` : 'Allow '}<b>${esc(ev.name.replace(/^mcp__/, ''))}</b>? <code>${esc(String(brief))}</code></div>`;
    btn('Allow once', 'primary', 'once'); btn('Allow for this session', 'outline', 'session'); btn('Deny', 'outline', 'deny');
  }
  a.appendChild(row); (lastHolder || bubble('assistant')).appendChild(a); typing(false);
  $('msgs').scrollTop = 1e9;
}

// ---------- branch / diff / terminal ----------
async function syncBranch() {
  const b = $('branch');
  if (cur?.mode !== 'code') { b.hidden = true; return; }
  const st = await gc.git.status(cur.cwd);
  if (!st) { b.hidden = true; return; }
  b.hidden = false; b.textContent = `⎇ ${st.branch}${st.files.length ? ` · ${st.files.length} changed` : ''}`;
}
function toggle(name) {
  document.body.classList.toggle(name);
  $(name === 'term' ? 'termBtn' : 'diffBtn').classList.toggle('on', document.body.classList.contains(name));
  if (name === 'diff' && document.body.classList.contains('diff')) refreshDiff();
  if (name === 'term') showTerm();
}
async function refreshDiff() {
  if (!document.body.classList.contains('diff')) return;
  const f = $('diffFiles'), body = $('diffBody'); f.innerHTML = ''; body.textContent = '';
  if (cur?.mode !== 'code') { body.textContent = 'Open a code session to see changes.'; return; }
  const st = await gc.git.status(cur.cwd);
  if (!st) { body.textContent = 'Not a git repository.'; return; }
  $('diffTitle').textContent = `Changes · ${st.files.length}`;
  const show = async (file, el) => { f.querySelectorAll('div').forEach((x) => x.classList.toggle('on', x === el)); renderDiff(await gc.git.diff(cur.cwd, file) || '(no textual diff)'); };
  for (const x of st.files) { const d = document.createElement('div'); d.innerHTML = `<span class="st-${esc(x.status[0])}">${esc(x.status)}</span><span>${esc(x.path)}</span>`; d.onclick = () => show(x.path, d); f.appendChild(d); }
  if (!st.files.length) body.textContent = 'Working tree clean.'; else renderDiff(await gc.git.diff(cur.cwd, null));
}
function renderDiff(t) {
  const b = $('diffBody'); b.innerHTML = '';
  for (const line of t.split('\n')) { const d = document.createElement('div'); d.className = 'l ' + (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff') || line.startsWith('@@') ? 'h' : line[0] === '+' ? 'a' : line[0] === '-' ? 'd' : ''); d.textContent = line || ' '; b.appendChild(d); }
}
$('diffRefresh').onclick = refreshDiff; $('diffClose').onclick = () => { if (document.body.classList.contains('diff')) toggle('diff'); }; $('diffBtn').onclick = () => toggle('diff'); $('termBtn').onclick = () => toggle('term');
// One xterm.js view per session, each backed by a real pty in the main process.
const termViews = new Map(); // id -> { term, fit, el, opened }
const termId = () => cur?.id || 'global';
const termTheme = () => { const cs = getComputedStyle(document.documentElement); return { background: cs.getPropertyValue('--code').trim() || '#2c2c2a', foreground: cs.getPropertyValue('--code-fg').trim() || '#f0efec', cursor: '#d97757' }; };
function termView(id) {
  let v = termViews.get(id); if (v) return v;
  const el = document.createElement('div'); el.style.cssText = 'height:100%;display:none'; $('termHost').appendChild(el);
  const term = new Terminal({ fontFamily: getComputedStyle(document.body).getPropertyValue('--mono') || 'Menlo, monospace', fontSize: settings.termFontSize || 12, cursorBlink: true, theme: termTheme(), scrollback: 5000, allowProposedApi: true });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(el);
  term.onData((d) => gc.term.input(id, d));
  term.onResize(({ cols, rows }) => gc.term.resize(id, cols, rows));
  v = { term, fit, el, opened: false }; termViews.set(id, v); return v;
}
function showTerm() {
  if (!document.body.classList.contains('term')) return;
  const id = termId();
  for (const [k, x] of termViews) x.el.style.display = k === id ? '' : 'none';
  const v = termView(id); v.el.style.display = '';
  requestAnimationFrame(async () => {
    try { v.fit.fit(); } catch {}
    if (!v.opened) { v.opened = true; await gc.term.open(id, cur?.cwd || null, { cols: v.term.cols, rows: v.term.rows }, cur?.ssh || null); }
    v.term.focus();
  });
}
new ResizeObserver(() => { const v = termViews.get(termId()); if (v && document.body.classList.contains('term')) try { v.fit.fit(); } catch {} }).observe($('termHost'));
gc.term.onEvent((id, m) => {
  const v = termView(id);
  if (m.type === 'data') v.term.write(m.data);
  else if (m.type === 'exit') { v.opened = false; v.term.write(`\r\n[process exited${m.code ? ' with code ' + m.code : ''}]\r\n`); if (cur?.mode === 'code') syncBranch(); }
});

// ---------- find ----------
const doFind = (fwd = true) => gc.find($('findInput').value, { forward: fwd, findNext: true });
$('findInput').addEventListener('input', () => gc.find($('findInput').value, { findNext: false }));
$('findInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doFind(!e.shiftKey); if (e.key === 'Escape') closeFind(); });
$('findNext').onclick = () => doFind(true); $('findPrev').onclick = () => doFind(false);
const closeFind = () => { $('findbar').hidden = true; gc.findStop(); }; $('findClose').onclick = closeFind;

// ---------- sidebar / buttons / menu commands ----------
function setSidebar(hidden) { document.body.classList.toggle('nosidebar', hidden); gc.settings.set({ sidebarHidden: hidden }); }
$('sideBtn').onclick = () => setSidebar(!document.body.classList.contains('nosidebar'));
const back = () => { if (hpos > 0) { hpos--; open(hist[hpos], false); } }, fwd = () => { if (hpos < hist.length - 1) { hpos++; open(hist[hpos], false); } };
$('backBtn').onclick = back; $('fwdBtn').onclick = fwd;
$('viewChat').onclick = () => setView('chat'); $('viewCode').onclick = () => setView('code');
$('nNew').onclick = () => { $('search').value = ''; goHome(); $('input').focus(); };
$('nMore').onclick = () => { $('moreItems').hidden = !$('moreItems').hidden; };
$('nImport').onclick = async () => { await openSettings(); showTab('code'); };
$('nShortcuts').onclick = () => showShortcuts();
$('search').addEventListener('input', refreshList);
const SC = [['New', '⌘N'], ['New session in current mode', '⇧⌘N'], ['New session in new window', '⌥⌘N'], ['Reopen closed session', '⇧⌘T'], ['Close session', '⌘W'],
  ['Search', '⌘K'], ['Find in conversation / next / previous', '⌘F / ⌘G / ⇧⌘G'], ['Close pane', '⌘\\'], ['Previous / next session', '⇧⌘[ / ⇧⌘]'], ['Back / forward', '⌘[ / ⌘]'], ['Toggle sidebar', '⌘B'],
  ['Toggle terminal', '⌃`'], ['Toggle changes', '⇧⌘D'], ['Zoom in / out / reset', '⌘= / ⌘- / ⌘0'], ['Quick Entry', settings.quickShortcut || 'Alt+Space'], ['Settings', '⌘,'], ['Stop generating', 'Esc']];
gc.onCommand(async (c, arg) => {
  if (c === 'new') { setView(arg === 'code' ? 'code' : 'chat', false); $('search').value = ''; goHome(); $('input').focus(); }
  else if (c === 'newWindow') { const f = await gc.pickFolder(); if (!f) return; const x = await gc.conv.create({ mode: 'code', cwd: f }); if (!settings.trustedFolders.includes(f)) settings = await gc.settings.set({ trustedFolders: [...settings.trustedFolders, f] }); gc.newWindow(x.id); }
  else if (c === 'settings') openSettings();
  else if (c === 'palette') openPalette();
  else if (c === 'find') { $('findbar').hidden = false; $('findInput').focus(); $('findInput').select(); }
  else if (c === 'rside') toggleRs();
  else if (c === 'findNext') { if (!$('findbar').hidden) doFind(arg !== false); else { $('findbar').hidden = false; $('findInput').focus(); } }
  else if (c === 'closePane') { for (const n of ['term', 'diff']) if (document.body.classList.contains(n)) { toggle(n); break; } }
  else if (c === 'search') { document.body.classList.contains('nosidebar') && setSidebar(false); $('search').focus(); $('search').select(); }
  else if (c === 'open') open(arg);
  else if (c === 'reopen') reopen();
  else if (c === 'closeSession') cur ? closeSession(cur.id) : window.close();
  else if (c === 'prev') step(-1); else if (c === 'next') step(1);
  else if (c === 'back') back();
  else if (c === 'forward') fwd();
  else if (c === 'sidebar') setSidebar(!document.body.classList.contains('nosidebar'));
  else if (c === 'terminal') toggle('term'); else if (c === 'diff') toggle('diff');
  else if (c === 'export') cur && gc.conv.export(cur.id);
  else if (c === 'importCli') { await openSettings(); showTab('code'); }
  else if (c === 'font') applyFont(arg);
  else if (c === 'dataChanged') { refreshList(); goHome(); if (!$('settings').hidden) { renderMemory(); renderUsage(); } }
  else if (c === 'shortcuts') showShortcuts();
});
function showShortcuts() { $('scList').innerHTML = SC.map(([a, k]) => `<div>${esc(a)}</div><div><kbd>${esc(k)}</kbd></div>`).join(''); $('shortcuts').showModal(); }
$('scClose').onclick = () => $('shortcuts').close();

// ---------- settings ----------
function showTab(t) {
  document.querySelectorAll('#settings .rail button').forEach((x) => x.classList.toggle('on', x.dataset.tab === t));
  document.querySelectorAll('[data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== t));
  if (t === 'appearance') applyAppearance(); if (t === 'capabilities') renderSavings();
  if (t === 'account') { renderAccount(); if (!anPoll && $('anOpen').dataset.armed) startAnPoll(); }
  else if (t === 'mods') renderMods2(); else if (t === 'providers') renderProviders(); else if (t === 'billing') renderBilling(); else if (t === 'memory') renderMemory(); else if (t === 'agents') renderAgents(); else if (t === 'extensions') renderExtensions(); else if (t === 'browser') renderBrowser(); else if (t === 'plugins') renderPlugins(); else if (t === 'design') renderDesign(); else if (t === 'system') renderSystem(); else if (t === 'usage') renderUsage();
}
document.querySelectorAll('#settings .rail button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
$('setSearch').addEventListener('input', () => { const q = $('setSearch').value.toLowerCase(); document.querySelectorAll('#settings .rail button').forEach((b) => (b.hidden = !!q && !b.textContent.toLowerCase().includes(q))); });
function syncSeg() { document.querySelectorAll('.seg[data-for]').forEach((g) => g.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === $(g.dataset.for).value))); }
document.querySelectorAll('.seg button[data-v]').forEach((b) => (b.onclick = () => { const sel = $(b.parentElement.dataset.for); sel.value = b.dataset.v; syncSeg(); sel.dispatchEvent(new Event('change')); }));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('settings').hidden) closeSettings(); });
const closeSettings = () => { $('settings').hidden = true; };
async function openSettings() {
  const s = settings = await gc.settings.get();
  $('sTheme').value = s.theme; $('sMode').value = s.permissionMode === 'bypassPermissions' ? 'default' : s.permissionMode; $('sShortcut').value = s.quickShortcut;
  $('sProvider').value = s.provider; $('sKey').value = ''; $('sKey').placeholder = s.hasKey ? '•••••• (saved)' : 'sk-…';
  $('sBase').value = s.baseUrl; $('sModel').value = s.model; $('sModels').value = (s.models || []).join(', '); $('sSys').value = s.systemPrompt;
  loadSettingFields(); renderMcp(); renderSkills(); renderFolders(); renderUsage();
  $('sMaxTok').value = s.maxTokens; $('zReset').textContent = zoomPct(s.zoom || 0); $('sTestOut').textContent = '';
  loadProviders().then(() => { renderAccount(); renderProviders(); }); renderAccount(); renderData(); renderAbout(); renderMemory(); renderDesign(); renderPlugins(); renderExtensions(); renderBrowser(); renderSystem(); renderBilling();
  showTab(canUse(s) ? 'general' : 'account'); syncSeg(); $('settings').hidden = false;
}
const canUse = (s) => s.usable ?? (!!s.hasKey || /^https?:\/\/(localhost|127\.0\.0\.1)/.test(s.baseUrl || ''));
const METHOD = { openrouter: 'OpenRouter (browser)', 'openrouter-key': 'OpenRouter API key', 'anthropic-key': 'Anthropic API key' };
async function renderProfile() {
  const s = settings, name = (s.profileName || s.displayName || '').trim(), initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  $('profAv').textContent = initials || '?'; $('profName').textContent = name || 'Your profile'; $('profMail').textContent = s.profileEmail || 'Stored on this computer only';
  try { const u = await gc.usage(); $('profSince').textContent = u?.since || 'today'; } catch { $('profSince').textContent = '—'; }
}
function renderAccount() {
  const s = settings, m = s.account?.method; renderProfile();
  $('acctTitle').textContent = s.hasKey ? (m ? `Signed in · ${METHOD[m] || m}` : 'API key saved') : canUse(s) ? 'Providers ready' : 'Not signed in';
  $('acctSub').textContent = s.hasKey ? `${s.provider === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible'}${s.baseUrl ? ' · ' + s.baseUrl : ''} · model ${s.model}` : canUse(s) ? s.baseUrl : 'Sign in through your browser to start chatting.';
  $('acctOut').hidden = !s.hasKey;
  const rows = Object.keys(s.providerKeys || {}).filter((id) => s.providerKeys[id]).map((id) => [id, (providerCache.find((p) => p.id === id) || {}).name || id]);
  $('provRows').innerHTML = rows.length ? '<h3>Connected providers</h3>' : '';
  for (const [id, label] of rows) {
    const r = document.createElement('div'); r.className = 'srow'; r.innerHTML = `<span>${esc(label)}<br><span class="hint">${s.keyHints?.[id] ? `Key <code>${esc(s.keyHints[id])}</code> · ` : ''}<span class="ptest">Models appear in the model picker</span></span></span>`;
    const t = document.createElement('button'); t.type = 'button'; t.textContent = 'Test'; t.onclick = async () => { const o = r.querySelector('.ptest'); t.disabled = true; o.textContent = 'Testing…'; o.style.color = ''; const x = await gc.providers.test(id).catch((e) => ({ ok: false, error: e.message })); t.disabled = false; o.textContent = x.ok ? `Connected ✓${x.count != null ? ` · ${x.count} models` : ''}` : (x.error || 'Could not connect'); o.style.color = x.ok ? 'var(--git-add)' : 'var(--git-del)'; };
    const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Remove';
    b.onclick = async () => { if (!(await gc.confirm(`Remove ${label}?`, 'Deletes the saved key from this computer. Its models disappear from the picker.', 'Remove'))) return; settings = await gc.auth.removeProvider(id); renderAccount(); openSettingsFields(); syncComposer(); loadCatalog(true); };
    const act = document.createElement('span'); act.className = 'inline'; act.append(t, b); r.appendChild(act); $('provRows').appendChild(r);
  }
}
let anPoll = null;
function stopAnPoll() { clearInterval(anPoll); anPoll = null; }
function startAnPoll() {
  stopAnPoll();
  anPoll = setInterval(async () => {
    if ($('settings').hidden || document.querySelector('[data-pane="account"]').hidden) return stopAnPoll();
    const r = await gc.auth.anthropicPeek();
    $('anUse').hidden = !r.found; if (r.found) $('anMsg').textContent = `Key ${r.hint} found on the clipboard.`;
  }, 1500);
}
$('orLogin').onclick = async () => {
  $('orLogin').disabled = true; $('orCancel').hidden = false; $('orMsg').textContent = 'Waiting for the browser…'; $('orMsg').style.color = '';
  const r = await gc.auth.openrouter();
  $('orLogin').disabled = false; $('orCancel').hidden = true;
  if (r.ok) { settings = r.settings; $('orMsg').textContent = ''; toast('Signed in with OpenRouter'); renderAccount(); openSettingsFields(); syncComposer(); loadCatalog(true); }
  else { $('orMsg').textContent = r.error === 'Cancelled' ? '' : r.error; $('orMsg').style.color = 'var(--git-del)'; }
};
$('orCancel').onclick = () => gc.auth.cancel();
$('orKeys').onclick = (e) => { e.preventDefault(); gc.openUrl('https://openrouter.ai/keys'); };
$('orSave').onclick = async () => {
  const k = $('orKey').value.trim(); if (!k) { $('orMsg').textContent = 'Paste an OpenRouter key first.'; $('orMsg').style.color = 'var(--git-del)'; return; }
  $('orSave').disabled = true; $('orMsg').textContent = 'Checking key…'; $('orMsg').style.color = '';
  const r = await gc.auth.openrouterKey(k); $('orSave').disabled = false;
  if (r.ok) { settings = r.settings; $('orKey').value = ''; $('orMsg').textContent = 'Saved ✓'; $('orMsg').style.color = 'var(--git-add)'; renderAccount(); openSettingsFields(); syncComposer(); toast('OpenRouter key saved'); loadCatalog(true); }
  else { $('orMsg').textContent = r.error; $('orMsg').style.color = 'var(--git-del)'; }
};
$('orKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('orSave').click(); });
$('anOpen').onclick = () => { $('anOpen').dataset.armed = '1'; gc.auth.anthropicOpen(); $('anMsg').textContent = 'Copy your new key; it will be detected here.'; startAnPoll(); };
$('anUse').onclick = async () => {
  const r = await gc.auth.anthropicUse();
  if (!r.ok) { $('anMsg').textContent = r.error; return; }
  settings = r.settings; $('anUse').hidden = true; $('anMsg').textContent = `Saved ${r.hint}. Checking…`; renderAccount(); openSettingsFields(); syncComposer(); loadCatalog(true);
  const t = await gc.testApi(); $('anMsg').textContent = t.ok ? 'Connected ✓' : t.error; $('anMsg').style.color = t.ok ? 'var(--git-add)' : 'var(--git-del)';
};
$('acctOut').onclick = async () => { if (!(await gc.confirm('Sign out?', 'This removes the saved API key from this computer. Conversations are kept.', 'Sign out'))) return; settings = await gc.auth.signOut(); renderAccount(); openSettingsFields(); syncComposer(); loadCatalog(true); toast('Signed out'); };
$('toProvider').onclick = (e) => { e.preventDefault(); showTab('apikeys'); };
function openSettingsFields() { const s = settings; $('sProvider').value = s.provider; $('sBase').value = s.baseUrl; $('sModel').value = s.model; $('sModels').value = (s.models || []).join(', '); $('sKey').value = ''; $('sKey').placeholder = s.hasKey ? '•••••• (saved)' : 'sk-…'; }
const PRESETS = {
  anthropic: { provider: 'anthropic', baseUrl: '' },
  openrouter: { provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1' },
  openai: { provider: 'openai', baseUrl: 'https://api.openai.com/v1' },
  ollama: { provider: 'openai', baseUrl: 'http://localhost:11434/v1' },
};
$('sPreset').addEventListener('change', async () => { const p = PRESETS[$('sPreset').value]; if (!p) return; await commit(p, 'Preset applied; set a model and key'); openSettingsFields(); renderAccount(); $('sPreset').value = ''; });
$('usageClear').onclick = async () => { if (await gc.confirm('Reset usage statistics?', 'Clears the token counts shown here. Conversations are not affected.', 'Reset')) { await gc.clearUsage(); renderUsage(); } };
async function renderData() { $('dataPath').textContent = await gc.data.path(); }
async function renderAbout() { const b = await gc.build(); $('aboutBody').innerHTML = `<div class="srow"><span>Version</span><span>${esc(b.version)}</span></div><div class="srow"><span>Electron</span><span>${esc(b.electron)}</span></div><div class="srow"><span>Chromium</span><span>${esc(b.chrome)}</span></div><div class="srow"><span>Node</span><span>${esc(b.node)}</span></div><div class="srow"><span>Platform</span><span>${esc(b.platform)}</span></div>`; }
function renderFolders() {
  for (const [key, el] of [['trustedFolders', 'trustedList'], ['pinnedFolders', 'pinnedList']]) {
    $(el).innerHTML = '';
    for (const f of settings[key]) {
      const r = document.createElement('div'); r.className = 'srow'; r.innerHTML = `<code>${esc(f)}</code>`;
      const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Remove';
      b.onclick = async () => { settings = await gc.settings.set({ [key]: settings[key].filter((x) => x !== f) }); renderFolders(); refreshList(); };
      r.appendChild(b); $(el).appendChild(r);
    }
    if (!settings[key].length) $(el).innerHTML = '<p class="hint">None.</p>';
  }
}
let usageRange = 30;
async function renderUsage() {
  const u = await gc.usage(), box = $('usageBody');
  const sum = (x) => (x.in || 0) + (x.out || 0);
  if (!u.requests && !sum(u.total)) { box.innerHTML = '<div class="uempty">Once you use Chat or Code on this computer, token usage will show up here.</div>'; return; }
  const days = []; const now = new Date();
  for (let i = usageRange - 1; i >= 0; i--) { const d = new Date(now); d.setDate(d.getDate() - i); const k = d.toISOString().slice(0, 10); days.push({ k, ...(u.days[k] || { in: 0, out: 0, cr: 0, cw: 0, cost: 0 }) }); }
  const tot = days.reduce((a, d) => ({ in: a.in + d.in, out: a.out + d.out, cr: a.cr + (d.cr || 0), cw: a.cw + (d.cw || 0), cost: a.cost + (d.cost || 0) }), { in: 0, out: 0, cr: 0, cw: 0, cost: 0 });
  const active = days.filter((d) => d.in || d.out).length;
  const models = Object.entries(u.models).map(([m, v]) => ({ m, ...v })).sort((a, b) => sum(b) - sum(a));
  const fav = models[0];
  const money = (c) => (c >= 1 ? '$' + c.toFixed(2) : '$' + c.toFixed(c >= 0.01 ? 3 : 4));
  const card = (l, v, sub) => `<div class="ucard"><div class="ul">${l}</div><div class="uv">${v}</div>${sub ? `<div class="us">${sub}</div>` : ''}</div>`;
  const max = Math.max(1, ...days.map((d) => d.in + d.out + (d.cr || 0) + (d.cw || 0)));
  const step = usageRange <= 7 ? 1 : usageRange <= 30 ? 5 : 15;
  const bars = days.map((d, i) => {
    const t = d.in + d.out + (d.cr || 0) + (d.cw || 0), h = (n) => (n / max) * 100;
    return `<div class="ubar" title="${d.k}: ${fmtFull(t)} tokens\n${fmtFull(d.in)} in · ${fmtFull(d.out)} out · ${fmtFull(d.cr || 0)} cache read · ${fmtFull(d.cw || 0)} cache write"><div class="stk">${t ? `<i class="sc" style="height:${h((d.cr || 0) + (d.cw || 0))}%"></i><i class="so" style="height:${h(d.out)}%"></i><i class="si" style="height:${h(d.in)}%"></i>` : '<i class="sz"></i>'}</div><small>${(days.length - 1 - i) % step === 0 ? d.k.slice(5) : ''}</small></div>`;
  }).join('');
  const modelRows = models.slice(0, 8).map((x) => `<div class="urow"><div class="uname"><span>${esc(modelLabel(x.m) || x.m)}</span><span class="hint">${fmtFull(x.n)} request${x.n === 1 ? '' : 's'}${x.cost ? ' · ' + money(x.cost) : ''}</span></div><div class="ubarh"><i style="width:${(sum(x) / Math.max(1, sum(models[0]))) * 100}%"></i></div><div class="hint">${fmt(x.in)} in · ${fmt(x.out)} out · ${fmt(x.cr || 0)} cache read · ${fmt(x.cw || 0)} cache write</div></div>`).join('');
  const modeMax = Math.max(1, sum(u.modes.chat), sum(u.modes.code));
  const modeRows = [['Chat', u.modes.chat], ['Code', u.modes.code]].map(([l, x]) => `<div class="urow"><div class="uname"><span>${l}</span><span class="hint">${fmt(sum(x))} tokens</span></div><div class="ubarh"><i style="width:${(sum(x) / modeMax) * 100}%"></i></div></div>`).join('');
  box.innerHTML = `<div class="ucards">${card('Total tokens', fmt(tot.in + tot.out), `input + output · ${fmt(sum(u.total))} all time`)}${card('Requests', fmtFull(u.requests), `${fmtFull(u.sessions.length)} session${u.sessions.length === 1 ? '' : 's'}`)}${card('Active days', `${active}<span class="ud"> / ${usageRange}</span>`, u.since ? 'since ' + u.since : '')}${card('Favorite model', esc(fav ? modelLabel(fav.m) || fav.m : '—'), fav ? fmt(sum(fav)) + ' tokens' : '')}</div>
    <h3>Tokens per day</h3><div class="uchart"><div class="uaxis"><span>${fmt(max)}</span><span>${fmt(max / 2)}</span><span>0</span></div><div class="ubars">${bars}</div></div>
    <div class="ulegend"><span><i class="si"></i>Input</span><span><i class="so"></i>Output</span><span><i class="sc"></i>Cache read / write</span></div>
    <p class="usplit">${fmt(tot.in)} in · ${fmt(tot.out)} out · ${fmt(tot.cr)} cache read · ${fmt(tot.cw)} cache write${tot.cost ? ` · est. ${money(tot.cost)}` : ''}</p>
    <h3>By model</h3>${modelRows || '<p class="hint">No data.</p>'}
    <h3>By tab</h3>${modeRows}
    ${u.cost ? `<p class="hint" style="margin-top:18px">Estimated cost uses per-token prices reported by OpenRouter and covers only those models (${money(u.cost)} all time).</p>` : ''}
    <p class="hint" style="margin-top:14px">Counts come from your providers’ usage reports and stay on this computer.</p>`;
}
document.querySelectorAll('#usageRange button').forEach((b) => (b.onclick = () => { usageRange = +b.dataset.v; document.querySelectorAll('#usageRange button').forEach((x) => x.classList.toggle('on', x === b)); renderUsage(); }));
const MCP_PRESETS = [
  { label: 'Filesystem', name: 'filesystem', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '~'], note: 'Replace ~ with the folder to share.' },
  { label: 'Memory', name: 'memory', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
  { label: 'Fetch', name: 'fetch', type: 'stdio', command: 'uvx', args: ['mcp-server-fetch'], note: 'Needs uv installed.' },
  { label: 'Remote URL', name: '', type: 'http', url: '' },
];
// Connector tool policy: like Claude's connector settings, each tool is Always allow, Needs approval or Blocked, grouped by what the tool says it does.
const POLICIES = [['allow', 'Always allow'], ['ask', 'Needs approval'], ['block', 'Blocked']];
const GROUPS = [['read', 'Read-only tools'], ['write', 'Write/delete tools'], ['other', 'Other tools']];
const groupOf = (t) => (t.readOnly ? 'read' : t.annotated ? 'write' : 'other');
const polSelect = (cls, val, extra) => `<select class="${cls}" ${extra}><option value=""${val === '' ? ' selected' : ''} disabled hidden>Mixed</option>${POLICIES.map(([v, l]) => `<option value="${v}"${v === val ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
const toolSummary = (tools) => { const n = (p) => tools.filter((t) => t.policy === p).length; return `Tools (${tools.length}) <span class="hint">· ${n('allow')} always allowed · ${n('block')} blocked</span>`; };
function toolGroups(tools) {
  return GROUPS.map(([g, label]) => {
    const ts = tools.filter((t) => groupOf(t) === g); if (!ts.length) return '';
    const ps = new Set(ts.map((t) => t.policy));
    return `<div class="mgrp"><b>${label}</b> <span class="hint">${ts.length}</span><span class="spacer"></span>${polSelect('', ps.size === 1 ? [...ps][0] : '', `data-g="${g}" title="Set every tool in this group"`)}</div>` + ts.map((t) => `<div class="mtool"><div><code>${esc(t.name)}</code> <span class="hint">${esc(t.description.slice(0, 90))}</span></div>${polSelect('', t.policy, `data-t="${esc(t.name)}"`)}</div>`).join('');
  }).join('');
}
let mcpEditing = null; // original name when editing
const dot = { running: 'ok', error: 'bad', starting: 'wait', stopped: 'off', disabled: 'off' };
async function refreshMcp(list) {
  list ||= await gc.mcp.list();
  const box = $('mcpList'); box.innerHTML = '';
  if (!list.length) box.innerHTML = '<p class="hint">No connectors yet. Add one to give Code sessions more tools.</p>';
  for (const s of list) {
    const d = document.createElement('div'); d.className = 'mcard';
    const summary = s.builtin ? `${s.label} · built in${s.auth.state === 'signed-in' && s.auth.account ? ' · ' + s.auth.account : ''}` : s.type === 'http' ? s.def.url : [s.def.command, ...(s.def.args || [])].join(' ');
    d.innerHTML = `<div class="mhead"><span class="mdot ${dot[s.status] || 'off'}" title="${esc(s.status)}"></span><b>${esc(s.name)}</b><span class="mbadge">${s.builtin ? 'built-in' : s.type === 'http' ? 'remote' : 'local'}</span>${s.auth?.state === 'signed-in' ? '<span class="mbadge">signed in</span>' : s.auth?.state === 'required' ? '<span class="mbadge">sign-in needed</span>' : ''}<span class="spacer"></span><span class="hint">${s.status === 'running' ? s.tools.length + ' tool' + (s.tools.length === 1 ? '' : 's') : esc(s.status)}</span></div>
      <div class="msum" title="${esc(summary)}">${esc(summary)}</div>
      ${s.error ? `<div class="merr">${esc(s.error)}${s.stderr ? `<details><summary>Server output</summary><pre>${esc(s.stderr)}</pre></details>` : ''}</div>` : ''}
      ${s.tools.length ? `<details class="mtools"><summary>${toolSummary(s.tools)}</summary>${toolGroups(s.tools)}</details>` : ''}
      <div class="mact"></div>`;
    // Per-tool policy. A group header's select applies one policy to every tool in the group.
    const applyPolicy = async (tools, policy) => { const r = await gc.mcp.toolPolicy(s.name, tools, policy), me = r.find((x) => x.name === s.name); if (me) { d.querySelector('.mtools summary').innerHTML = toolSummary(me.tools); d.querySelectorAll('.mtool select').forEach((x) => { x.value = me.tools.find((t) => t.name === x.dataset.t)?.policy || 'ask'; }); d.querySelectorAll('.mgrp select').forEach((x) => { const ps = new Set(me.tools.filter((t) => groupOf(t) === x.dataset.g).map((t) => t.policy)); x.value = ps.size === 1 ? [...ps][0] : ''; }); } };
    d.querySelectorAll('.mtool select').forEach((sel) => (sel.onchange = () => applyPolicy([sel.dataset.t], sel.value)));
    d.querySelectorAll('.mgrp select').forEach((sel) => (sel.onchange = () => { if (sel.value) applyPolicy(s.tools.filter((t) => groupOf(t) === sel.dataset.g).map((t) => t.name), sel.value); }));
    const act = d.querySelector('.mact');
    const btn = (t, f, cls = 'outline') => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = t; b.onclick = f; act.appendChild(b); return b; };
    if (s.builtin) btn('Google settings…', openGoogleDialog);
    else btn('Edit', () => openMcpDialog(s.name, s.def));
    if (s.builtin && !s.disabled) {
      if (s.auth.state === 'signed-in') btn('Sign out', async () => { refreshMcp(await gc.mcp.signOut(s.name)); toast('Signed out of Google'); });
      else if (!s.auth.configured) btn('Set up Google…', openGoogleDialog, 'primary');
      else {
        const sb = btn('Sign in with Google', async () => {
          if (sb.dataset.busy) return gc.mcp.cancelSignIn(s.name);
          sb.dataset.busy = '1'; sb.textContent = 'Cancel sign-in'; toast('Finish signing in in your browser');
          const r = await gc.mcp.signIn(s.name).catch((e) => ({ ok: false, error: e.message }));
          if (r.ok) toast('Signed in to Google' + (r.email ? ' as ' + r.email : '')); else if (r.error && r.error !== 'Cancelled') toast(r.error);
          refreshMcp(r.servers);
        }, 'primary');
      }
    }
    if (s.type === 'http' && !s.disabled) {
      if (s.auth?.state === 'signed-in') btn('Sign out', async () => { refreshMcp(await gc.mcp.signOut(s.name)); toast(`${s.name} signed out`); });
      else {
        const sb = btn('Sign in…', async () => {
          if (sb.dataset.busy) return gc.mcp.cancelSignIn(s.name);
          sb.dataset.busy = '1'; sb.textContent = 'Cancel sign-in'; toast('Finish signing in in your browser');
          const r = await gc.mcp.signIn(s.name).catch((e) => ({ ok: false, error: e.message }));
          if (r.ok) toast(`${s.name} signed in`); else if (r.error && r.error !== 'Cancelled') toast(r.error);
          refreshMcp(r.servers);
        }, s.auth?.state === 'required' ? 'primary' : 'outline');
      }
    }
    if (!s.disabled && !s.builtin) btn(s.status === 'error' ? 'Reconnect' : 'Restart', async (e) => { e.target.disabled = true; e.target.textContent = 'Connecting…'; refreshMcp(await gc.mcp.restart(s.name)); });
    btn(s.disabled ? 'Connect' : 'Disconnect', async () => refreshMcp(await gc.mcp.toggle(s.name, !s.disabled)));
    if (!s.builtin) btn('Remove', async () => { if (await gc.confirm(`Remove “${s.name}”?`, 'The server is stopped and its configuration deleted.', 'Remove')) refreshMcp(await gc.mcp.remove(s.name)); });
    box.appendChild(d);
  }
  $('mcpCfg').value = JSON.stringify(await gc.mcp.config(), null, 2);
}
const renderMcp = () => refreshMcp();
// Built-in Google connectors: the user's own OAuth client (Client ID + Secret), then one browser sign-in for all five apps.
const gmsg = (t, ok) => { $('gMsg').textContent = t; $('gMsg').className = 'mmsg ' + (ok === true ? 'ok' : ok === false ? 'bad' : ''); };
async function openGoogleDialog() {
  const c = await gc.google.client();
  $('gSteps').innerHTML = c.steps.map((st) => `<li><b>${esc(st.title)}.</b> ${esc(st.body)}${st.link ? ` <a href="#" data-l="${esc(st.link)}">Open ↗</a>` : ''}</li>`).join('');
  $('gSteps').querySelectorAll('[data-l]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); gc.openUrl(a.dataset.l); }));
  $('gRedirect').value = c.redirectUri; $('gId').value = c.clientId; $('gSecret').value = '';
  $('gSecretHint').textContent = c.hasSecret ? 'saved — leave blank to keep it' : ''; gmsg('');
  $('googleDlg').showModal();
}
$('gRedirect').onclick = () => $('gRedirect').select();
$('gCancel').onclick = () => $('googleDlg').close();
async function saveGoogle() { const r = await gc.google.setClient({ clientId: $('gId').value, clientSecret: $('gSecret').value }); if (r.error) gmsg(r.error, false); else { $('gSecret').value = ''; $('gSecretHint').textContent = 'saved — leave blank to keep it'; } return !r.error; }
$('gSave').onclick = async () => { if (await saveGoogle()) { gmsg('Saved ✓', true); refreshMcp(); } };
$('gSignIn').onclick = async () => {
  if (!(await saveGoogle())) return;
  const b = $('gSignIn'); if (b.dataset.busy) return gc.mcp.cancelSignIn('gmail');
  b.dataset.busy = '1'; b.textContent = 'Cancel sign-in'; gmsg('Finish signing in in your browser…');
  const r = await gc.mcp.signIn('gmail').catch((e) => ({ ok: false, error: e.message }));
  delete b.dataset.busy; b.textContent = 'Save & sign in with Google';
  if (r.ok) { $('googleDlg').close(); toast('Signed in to Google' + (r.email ? ' as ' + r.email : '')); } else if (r.error !== 'Cancelled') gmsg(r.error, false); else gmsg('');
  refreshMcp(r.servers);
};
const lines = (t) => t.split('\n').map((x) => x.trim()).filter(Boolean);
function mType(t) { $('mType').dataset.v = t; document.querySelectorAll('#mType button').forEach((b) => b.classList.toggle('on', b.dataset.v === t)); $('mStdio').hidden = t !== 'stdio'; $('mHttp').hidden = t !== 'http'; }
document.querySelectorAll('#mType button').forEach((b) => (b.onclick = () => mType(b.dataset.v)));
function fillMcp(name, def, note) {
  $('mName').value = name || ''; mType(def.url !== undefined ? 'http' : 'stdio');
  $('mCmd').value = def.command || ''; $('mArgs').value = (def.args || []).join('\n'); $('mEnv').value = Object.entries(def.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'); $('mCwd').value = def.cwd || '';
  $('mOauthId').value = def.oauth?.clientId || ''; $('mOauthSecret').value = def.oauth?.clientSecret || '';
  $('mUrl').value = def.url || ''; $('mHdrs').value = Object.entries(def.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  $('mMsg').textContent = note || ''; $('mMsg').className = 'mmsg';
}
function openMcpDialog(name, def) {
  mcpEditing = name || null;
  $('mcpTitle').textContent = name ? `Edit “${name}”` : 'Add connector';
  $('mcpPresets').hidden = !!name;
  fillMcp(name, def || { command: '', args: [] });
  $('mcpDlg').showModal(); $('mName').focus();
}
function readMcp() {
  const name = $('mName').value.trim(); let def;
  if ($('mType').dataset.v === 'http') {
    const cid = $('mOauthId').value.trim();
    def = { url: $('mUrl').value.trim(), ...(cid ? { oauth: { clientId: cid, ...($('mOauthSecret').value ? { clientSecret: $('mOauthSecret').value } : {}) } } : {}), headers: Object.fromEntries(lines($('mHdrs').value).map((l) => { const i = l.indexOf(':'); return i < 0 ? [l, ''] : [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })) };
  } else {
    def = { command: $('mCmd').value.trim(), args: lines($('mArgs').value), env: Object.fromEntries(lines($('mEnv').value).map((l) => { const i = l.indexOf('='); return i < 0 ? [l, ''] : [l.slice(0, i).trim(), l.slice(i + 1)]; })), cwd: $('mCwd').value.trim() };
  }
  return { name, def };
}
$('mcpPresets').innerHTML = MCP_PRESETS.map((p, i) => `<button type="button" class="chip" data-i="${i}">${esc(p.label)}</button>`).join('');
$('mcpPresets').onclick = (e) => { const b = e.target.closest('[data-i]'); if (!b) return; const p = MCP_PRESETS[b.dataset.i]; fillMcp(p.name, p.type === 'http' ? { url: p.url } : { command: p.command, args: p.args }, p.note); };
$('mcpAdd').onclick = () => openMcpDialog();
$('mcpBrowse').onclick = () => showTab('extensions');
$('mCancel').onclick = () => $('mcpDlg').close();
const mmsg = (t, ok) => { $('mMsg').textContent = t; $('mMsg').className = 'mmsg ' + (ok === true ? 'ok' : ok === false ? 'bad' : ''); };
$('mTest').onclick = async () => {
  const { def } = readMcp(); $('mTest').disabled = true; mmsg('Starting server…');
  const r = await gc.mcp.test(def); $('mTest').disabled = false;
  if (r.ok) mmsg(`Connected ✓ ${r.tools.length} tool${r.tools.length === 1 ? '' : 's'}: ${r.tools.map((t) => t.name).slice(0, 8).join(', ')}${r.tools.length > 8 ? '…' : ''}`, true);
  else mmsg(r.error + (r.stderr ? '\n' + r.stderr.trim().split('\n').slice(-3).join('\n') : ''), false);
};
$('mSave').onclick = async () => {
  const { name, def } = readMcp(); $('mSave').disabled = true; mmsg('Saving and starting…');
  const r = await gc.mcp.saveServer({ name, def, oldName: mcpEditing || undefined }); $('mSave').disabled = false;
  if (r.error) return mmsg(r.error, false);
  $('mcpDlg').close(); refreshMcp(r.servers);
  const s = r.servers.find((x) => x.name === name); toast(s?.status === 'running' ? `${name} connected · ${s.tools.length} tools` : `${name} saved${s?.error ? ' – ' + s.error : ''}`);
};
$('mcpReload').onclick = async () => { $('mcpReload').disabled = true; await gc.mcp.save(await gc.mcp.config()); await refreshMcp(); $('mcpReload').disabled = false; toast('Connectors reloaded'); };
$('mcpImport').onclick = () => { $('impText').value = ''; $('impName').value = ''; $('impOver').checked = false; $('impMsg').textContent = ''; $('mcpImpDlg').showModal(); $('impText').focus(); };
$('impCancel').onclick = () => $('mcpImpDlg').close();
$('impGo').onclick = async () => {
  $('impGo').disabled = true; $('impMsg').className = 'mmsg'; $('impMsg').textContent = 'Importing…';
  const r = await gc.mcp.importJson($('impText').value, { overwrite: $('impOver').checked, name: $('impName').value.trim() || undefined }); $('impGo').disabled = false;
  if (r.error) { $('impMsg').className = 'mmsg bad'; $('impMsg').textContent = r.error; return; }
  $('mcpImpDlg').close(); refreshMcp(r.servers); toast(`Imported ${r.added.length}${r.skipped.length ? `, skipped ${r.skipped.length} existing` : ''}`);
};
async function renderSkills() {
  const l = await gc.skills.list(); $('skillList').innerHTML = '';
  for (const k of l) {
    const r = document.createElement('div'); r.className = 'srow'; r.innerHTML = `<span><b>${esc(k.name)}</b><br><span class="hint">${esc(k.description.slice(0, 100))}</span></span>`;
    const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Remove'; b.onclick = async () => { await gc.skills.remove(k.id); renderSkills(); };
    r.appendChild(b); $('skillList').appendChild(r);
  }
  if (!l.length) $('skillList').innerHTML = '<p class="hint">No skills installed.</p>';
}
$('skillImport').onclick = async () => { const r = await gc.skills.import(); if (r?.error) alert(r.error); renderSkills(); };
$('cliImport').onclick = async () => { $('cliResult').textContent = 'Importing…'; const r = await gc.importCli(); $('cliResult').textContent = r.none ? 'No CLI sessions found.' : `Imported ${r.imported} session${r.imported === 1 ? '' : 's'}${r.skipped ? `, skipped ${r.skipped}` : ''}.`; refreshList(); };
$('openSettings').onclick = openSettings;
$('sCancel').onclick = closeSettings;
// Settings apply as soon as they change; there is no Save button except for the connectors JSON.
async function commit(patch, msg) {
  settings = await gc.settings.set(patch);
  if (settings.shortcutOk === false) toast('That Quick Entry shortcut is invalid or already taken');
  else if (msg) toast(msg);
  syncComposer(); refreshList(); loadCatalog(false); return settings;
}
const bind = (id, ev, fn) => $(id).addEventListener(ev, fn);
bind('sTheme', 'change', async () => { await commit({ theme: $('sTheme').value }); applyAppearance(); });
bind('sMode', 'change', () => commit({ permissionMode: $('sMode').value }));
bind('sShortcut', 'change', () => commit({ quickShortcut: $('sShortcut').value.trim() || 'Alt+Space' }, 'Shortcut updated'));
bind('sProvider', 'change', () => commit({ provider: $('sProvider').value }));
bind('sBase', 'change', () => commit({ baseUrl: $('sBase').value.trim() }));
bind('sModel', 'change', () => commit({ model: $('sModel').value.trim() || settings.model }));
bind('sModels', 'change', () => commit({ models: $('sModels').value.split(',').map((x) => x.trim()).filter(Boolean) }));
bind('sSys', 'change', () => commit({ systemPrompt: $('sSys').value }));
bind('sMaxTok', 'change', () => { const n = Math.max(256, Math.min(64000, parseInt($('sMaxTok').value, 10) || 8192)); $('sMaxTok').value = n; commit({ maxTokens: n }); });
bind('sKey', 'change', async () => { const k = $('sKey').value.trim(); if (!k) return; await commit({ apiKey: k }, 'API key saved'); $('sKey').value = ''; $('sKey').placeholder = '•••••• (saved)'; });
const zoomPct = (z) => Math.round(100 * 1.2 ** z) + '%';
async function nudgeZoom(d) { const z = await gc.zoom(d); $('zReset').textContent = zoomPct(z); }
$('zIn').onclick = () => nudgeZoom(1); $('zOut').onclick = () => nudgeZoom(-1); $('zReset').onclick = () => nudgeZoom(0);
$('sTest').onclick = async () => {
  $('sTestOut').textContent = 'Testing…'; const r = await gc.testApi();
  $('sTestOut').textContent = r.ok ? 'Connected ✓' : r.error; $('sTestOut').style.color = r.ok ? 'var(--git-add)' : 'var(--git-del)';
};
$('mcpSave').onclick = async () => { try { const cfg = JSON.parse($('mcpCfg').value); await gc.mcp.save(cfg); await refreshMcp(); $('mcpJsonMsg').textContent = ''; toast('Connectors saved'); } catch (e) { $('mcpJsonMsg').textContent = 'Not valid JSON: ' + e.message; $('mcpJsonMsg').style.color = 'var(--git-del)'; } };
document.addEventListener('contextmenu', (e) => { if (e.target.closest('.item')) return; });

// ---------- settings pages ----------
// Generic binding: any control with data-s="key" reads/writes that setting (data-t="int" for numbers).
const sKeys = () => [...document.querySelectorAll('#settings [data-s]')];
function loadSettingFields() {
  for (const el of sKeys()) { const v = settings[el.dataset.s]; if (el.type === 'checkbox') el.checked = !!v; else el.value = v ?? ''; }
  $('devOnly').hidden = !settings.devMode; syncSeg();
}
async function commitField(el) {
  const k = el.dataset.s; let v = el.type === 'checkbox' ? el.checked : el.dataset.t === 'int' ? Number(el.value) : el.value;
  if (typeof v === 'string' && !['preferences', 'displayName'].includes(k)) v = v.trim();
  const r = await commit({ [k]: v });
  if (r.rejected?.includes(k)) { toast('That value isn’t valid, so it wasn’t saved'); el.value = settings[k] ?? ''; if (el.type === 'checkbox') el.checked = !!settings[k]; return; }
  for (const o of sKeys()) if (o !== el && o.dataset.s === k) { if (o.type === 'checkbox') o.checked = !!settings[k]; else o.value = settings[k] ?? ''; }
  afterSetting(k);
}
function afterSetting(k) {
  if (k === 'font') applyFont(settings.font); else if (k === 'textSize') applyAppearance(); else if (k === 'termFontSize') { for (const v of termViews.values()) { v.term.options.fontSize = settings.termFontSize; try { v.fit.fit(); } catch {} } }
  else if (['profileName', 'profileEmail', 'displayName'].includes(k)) renderProfile(); else if (k === 'capArtifacts') applyCaps(); else if (k === 'allowBypass') { syncComposer(); } else if (k === 'devMode') $('devOnly').hidden = !settings.devMode; else if (k === 'promptSuggestions' && !settings.promptSuggestions) clearSuggest();
  else if (k === 'hardwareAccel') $('hwRestart').hidden = false; else if (k === 'launchAtLogin') renderSystem(); else if (k === 'worktreeDir') updateWtNote();
}
document.querySelectorAll('#settings [data-s]').forEach((el) => el.addEventListener('change', () => commitField(el)));
function applyFont(f) { document.documentElement.dataset.font = f && f !== 'default' ? f : ''; }
// ---------- appearance: themes + accent ----------
let themeData = null, themeVarKeys = [];
const ACCENT_KEYS = ['--clay', '--clay-em', '--on-brand'];
async function applyAppearance() {
  if (!themeData) themeData = await gc.themes.list();
  const root = document.documentElement, th = themeData.themes.find((t) => t.id === settings.colorTheme) || themeData.themes[0];
  for (const k of [...themeVarKeys, ...ACCENT_KEYS]) root.style.removeProperty(k);
  themeVarKeys = Object.keys(th.vars);
  for (const [k, v] of Object.entries(th.vars)) root.style.setProperty(k, v);
  const a = settings.accent || 'theme'; let av = null;
  if (a === 'theme') av = th.id === 'default' ? null : themeData.accentVars[th.accent];
  else av = themeData.accentVars[themeData.accents.find((x) => x.id === a)?.color] || await gc.themes.accentVars(a);
  if (av) for (const [k, v] of Object.entries(av)) root.style.setProperty(k, v);
  root.dataset.textsize = settings.textSize && settings.textSize !== 'default' ? settings.textSize : '';
  root.dataset.colortheme = th.id;
  for (const v of termViews.values()) { try { v.term.options.theme = termTheme(); } catch {} }
  if (!$('settings').hidden) renderAppearance();
}
function renderAppearance() {
  if (!themeData) return;
  const cur = settings.colorTheme || 'default', th = themeData.themes.find((t) => t.id === cur) || themeData.themes[0];
  $('sTheme').value = settings.theme; syncSeg(); $('sTextSize').value = settings.textSize || 'default'; $('sFont').value = settings.font || 'default'; syncSeg();
  document.querySelectorAll('.seg[data-for=sTheme] button').forEach((b) => (b.disabled = !!th.mode));
  $('modeNote').textContent = th.mode ? `${th.name} is always ${th.mode}; pick Default to choose the mode.` : 'Light, dark, or follow the system.';
  const g = $('themeGrid'); g.innerHTML = '';
  for (const t of themeData.themes) {
    const v = t.id === 'default' ? { '--bg': '#f9f9f7', '--bg-side': '#f0efec', '--text-3': '#898781', '--line': '#e1e0d9' } : t.vars, b = document.createElement('button');
    b.type = 'button'; b.className = 'th' + (t.id === cur ? ' on' : ''); b.title = t.name;
    b.innerHTML = `<div class="pv" style="background:${v['--bg']}"><div class="sd" style="background:${v['--bg-side']}"></div><div class="mn"><i style="width:80%;background:${v['--text-3']}"></i><i style="width:55%;background:${v['--line']}"></i><i class="ac" style="background:${t.accent}"></i></div></div><div class="nm"><span>${esc(t.name)}</span><small>${t.mode || 'auto'}</small></div>`;
    b.onclick = async () => { await commit({ colorTheme: t.id }); await applyAppearance(); };
    g.appendChild(b);
  }
  const row = $('accentRow'); row.innerHTML = ''; const a = settings.accent || 'theme';
  const add = (cls, label, color, val) => { const x = document.createElement('button'); x.type = 'button'; x.className = 'ac ' + cls + (a === val ? ' on' : ''); x.title = label; if (color) x.style.background = color; else x.textContent = label; x.onclick = async () => { await commit({ accent: val }); await applyAppearance(); }; row.appendChild(x); };
  add('auto', 'Theme', '', 'theme');
  for (const x of themeData.accents) add('', x.name, x.color, x.id);
  const pick = document.createElement('input'); pick.type = 'color'; pick.title = 'Custom color'; pick.value = /^#[0-9a-f]{6}$/i.test(a) ? a : (themeData.accents.find((x) => x.id === a)?.color || th.accent);
  pick.onchange = async () => { await commit({ accent: pick.value }); await applyAppearance(); };
  row.appendChild(pick);
}
function applyCaps() { $('nArtifacts').hidden = settings.capArtifacts === false; }
document.querySelectorAll('#settings [data-goto]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); showTab(a.dataset.goto); }));
document.querySelectorAll('#settings [data-open]').forEach((b) => (b.onclick = () => gc.openUrl(b.dataset.open)));
function updateWtNote() { $('wtDirNote').textContent = settings.worktreeDir ? 'Worktrees are created in this folder.' : 'Where worktrees are created. Empty uses a hidden folder next to the repository.'; }

// Notifications / system
async function testNotif(out) { const r = await gc.system.testNotification(); out.textContent = r.ok ? 'Sent — check your notification center.' : 'Notifications aren’t supported here.'; }
$('notifTest').onclick = () => testNotif($('notifMsg')); $('sysNotifTest').onclick = () => testNotif($('sysNotifNote'));
async function renderSystem() {
  const st = await gc.system.status(); document.querySelector('[data-s="launchAtLogin"]').checked = st.loginItem;
  $('hwNote').textContent = 'Turn off if you see graphics glitches. Applies after a restart.';
}
$('hwRestart').onclick = () => gc.system.relaunch();

// Privacy
$('privExport').onclick = async () => { const r = await gc.privacy.export(); $('privMsg').textContent = r ? 'Saved to ' + r.path : ''; };
$('dataOpen').onclick = () => gc.data.open();
// Prompt suggestions
function clearSuggest() { const b = $('suggest'); b.hidden = true; b.innerHTML = ''; }
async function showSuggest(id) {
  if (!settings.promptSuggestions || cur?.mode !== 'code') return;
  const list = await gc.suggest(id);
  if (!list?.length || cur?.id !== id || busy.has(id) || $('input').value.trim()) return;
  const b = $('suggest'); b.innerHTML = '';
  for (const t of list) { const x = document.createElement('button'); x.type = 'button'; x.textContent = t; x.onclick = () => { $('input').value = t; $('input').dispatchEvent(new Event('input')); clearSuggest(); $('input').focus(); }; b.append(x); }
  b.hidden = false;
}
// Storage, permissions, updates
const fmtB = (n) => (n == null ? '—' : n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
$('stCalc').onclick = async () => {
  $('stMsg').textContent = 'Calculating…'; const u = await gc.storage.usage(); $('stMsg').textContent = '';
  $('stList').innerHTML = u.items.map((i) => `<div class="srow"><span>${esc(i.label)}</span><span>${fmtB(i.bytes)}</span></div>`).join('') + `<div class="srow"><b>Total</b><b>${fmtB(u.total)}</b></div><div class="srow"><span>Free disk space</span><span>${fmtB(u.free)}</span></div>`;
};
$('stOpen').onclick = () => gc.data.open();
$('stClean').onclick = async () => {
  if (!(await gc.confirm('Remove finished worktrees?', 'Deletes the worktree folder of every archived session that has no uncommitted changes. Branches and commits are kept.', 'Remove'))) return;
  const r = await gc.storage.cleanWorktrees(); $('stMsg').textContent = `Removed ${r.removed}${r.kept ? `, kept ${r.kept} with uncommitted changes` : ''}.`;
};
const PERMS = [['accessibility', 'Accessibility'], ['screen', 'Screen recording'], ['microphone', 'Microphone']];
async function renderPerms() {
  const st = await gc.perm.status(), box = $('permList'); box.innerHTML = '';
  $('permH').hidden = $('permHint').hidden = !st; if (!st) return;
  for (const [k, label] of PERMS) {
    const ok = st[k] === 'granted', row = document.createElement('div'); row.className = 'srow';
    row.innerHTML = `<span>${label} <span class="hint">· ${ok ? 'allowed' : st[k] === 'denied' ? 'denied' : 'not allowed'}</span></span>`;
    const b = document.createElement('button'); b.className = 'outline'; b.type = 'button'; b.textContent = 'Open settings'; b.onclick = () => gc.perm.open(k); row.append(b); box.append(row);
  }
}
renderPerms();
$('abUpdate').onclick = async () => {
  $('abMsg').textContent = 'Checking…'; const r = await gc.app.checkUpdate();
  if (r.error) { $('abMsg').textContent = r.error; return; }
  if (!r.newer) { $('abMsg').textContent = `You’re up to date (${r.current}).`; return; }
  $('abMsg').textContent = `Version ${r.latest} is available.`;
  if (await gc.confirm(`Version ${r.latest} is available`, `You have ${r.current}. Open the release page?`, 'Open')) gc.app.openUrl(r.url);
};
$('abFeedback').onclick = () => gc.app.feedback();
// Developer
$('devMcpLog').onclick = () => gc.dev.openMcpLog();
const devMsg = (t) => { $('devMsg').textContent = t; };
$('devLogs').onclick = () => gc.dev.openLogs();
$('devSettingsFile').onclick = () => gc.dev.openSettingsFile();
$('devMcpCfg').onclick = () => gc.dev.openMcpConfig();
$('devTools').onclick = () => gc.dev.devtools();
$('devReload').onclick = async () => { devMsg('Reloading…'); try { await gc.dev.reloadMcp(); devMsg('Connectors reloaded ✓'); refreshMcp(); } catch (e) { devMsg('Reload failed: ' + (e?.message || e)); } };
$('devReport').onclick = async () => { const r = await gc.dev.report(); devMsg(r ? 'Saved to ' + r.path : ''); };
$('devCache').onclick = () => gc.dev.clearCache();
$('devReset').onclick = () => gc.privacy.delete('everything');
$('delConvs').onclick = () => gc.privacy.delete('conversations');
$('delMem').onclick = async () => { await gc.privacy.delete('memory'); renderMemory(); };
$('delAll').onclick = () => gc.privacy.delete('everything');

// Billing
async function renderBilling() {
  const box = $('billOr'), est = $('billEst');
  if (!settings.providerKeys?.openrouter) box.innerHTML = '<p class="hint" style="margin:0">Not connected. Add an OpenRouter key on <a href="#" data-goto="account">Account</a> to see your credit balance here.</p>';
  else {
    box.innerHTML = '<p class="hint" style="margin:0">Loading balance…</p>'; const r = await gc.billing.openrouter();
    const usd = (n) => '$' + Number(n).toFixed(n >= 100 ? 0 : 2);
    box.innerHTML = r.error ? `<p class="hint" style="margin:0;color:var(--git-del)">${esc(r.error)}</p>` : `<div class="big">${usd(r.remaining)} <span class="hint">remaining</span></div><div class="ubarh"><i style="width:${r.total ? Math.min(100, (r.used / r.total) * 100) : 0}%"></i></div><p class="hint" style="margin:4px 0 8px">${usd(r.used)} used of ${usd(r.total)} purchased</p>`;
    const a = document.createElement('div'); a.className = 'pg-actions'; a.style.margin = '0';
    a.innerHTML = '<button class="outline" data-open="https://openrouter.ai/credits" type="button">Add credits ↗</button><button class="outline" id="billRefresh" type="button">Refresh</button>'; box.appendChild(a);
    a.querySelector('[data-open]').onclick = () => gc.openUrl('https://openrouter.ai/credits'); a.querySelector('#billRefresh').onclick = renderBilling;
  }
  box.querySelectorAll('[data-goto]').forEach((x) => (x.onclick = (e) => { e.preventDefault(); showTab(x.dataset.goto); }));
  const u = await gc.usage(); est.innerHTML = u.cost ? `<div class="big">${'$' + u.cost.toFixed(u.cost >= 1 ? 2 : 4)} <span class="hint">all time</span></div><p class="hint" style="margin:4px 0 0">Calculated from per-token prices that OpenRouter reports. Anthropic and other providers don’t report prices to apps, so their usage isn’t included.</p>` : '<p class="hint" style="margin:0">No priced usage yet. Spend is estimated for OpenRouter models only.</p>';
}

// Memory
async function renderMemory() {
  const l = await gc.memory.list(); $('memCount').textContent = l.length ? `· ${l.length}` : ''; const box = $('memList'); box.innerHTML = '';
  if (!l.length) box.innerHTML = '<p class="hint">Nothing saved yet. Add something above, or let GrizzyCode save what you tell it.</p>';
  for (const m of [...l].reverse()) {
    const r = document.createElement('div'); r.className = 'srow mem';
    r.innerHTML = `<span class="mtext"><span>${esc(m.text)}</span><br><span class="hint">${m.source === 'model' ? 'Saved by GrizzyCode' : 'Added by you'} · ${new Date(m.createdAt).toLocaleDateString()}</span></span>`;
    const ed = document.createElement('button'); ed.type = 'button'; ed.textContent = 'Edit';
    ed.onclick = () => {
      const i = document.createElement('input'); i.value = m.text; i.maxLength = 600; i.style.flex = '1'; r.querySelector('.mtext').replaceWith(i); i.focus();
      ed.textContent = 'Save'; ed.onclick = async () => { const x = await gc.memory.update(m.id, i.value); if (x.error) toast(x.error); else renderMemory(); };
      i.addEventListener('keydown', (e) => { if (e.key === 'Enter') ed.click(); else if (e.key === 'Escape') renderMemory(); });
    };
    const del = document.createElement('button'); del.type = 'button'; del.textContent = 'Delete'; del.onclick = async () => { await gc.memory.remove(m.id); renderMemory(); };
    const act = document.createElement('span'); act.className = 'inline'; act.append(ed, del); r.appendChild(act); box.appendChild(r);
  }
}
async function addMemory() { const t = $('memNew').value; if (!t.trim()) return; const r = await gc.memory.add(t); if (r.error) return toast(r.error); $('memNew').value = ''; if (r.duplicate) toast('Already remembered'); renderMemory(); }
$('memAdd').onclick = addMemory; $('memNew').addEventListener('keydown', (e) => { if (e.key === 'Enter') addMemory(); });
$('memClear').onclick = async () => { await gc.memory.clear(); renderMemory(); };

// Agents
let agents = [], agEditing = null, agSchema = null;
async function loadAgents() { agents = await gc.agents.list(); renderAgentPicker(); }
const agentById = (id) => agents.find((x) => x.id === id && x.enabled) || null;
const currentAgentId = () => (cur ? cur.agentId : settings.activeAgent) || '';
const currentAgent = () => agentById(currentAgentId()) || agentById('general') || agents[0] || null;
function renderAgentPicker() {
  const a = currentAgent(); $('agentIcon').textContent = a?.icon || '🐻'; $('agentLabel').textContent = a?.name || 'Agent';
  $('agentBtn').title = a?.description ? `Agent: ${a.description}` : 'Agent';
}
function openAgentMenu() {
  const m = $('agentMenu'), sel = currentAgent()?.id; m.innerHTML = '';
  for (const a of agents.filter((x) => x.enabled)) {
    const r = document.createElement('div'); r.className = 'ai' + (a.id === sel ? ' sel' : ''); r.setAttribute('role', 'option');
    r.innerHTML = `<span class="aic">${esc(a.icon || '🤖')}</span><span class="atx"><div class="an">${esc(a.name)}</div><div class="ad">${esc(a.description || '')}</div></span>${a.id === sel ? '<span class="ck">✓</span>' : ''}`;
    r.onclick = () => pickAgent(a.id); m.appendChild(r);
  }
  const mg = document.createElement('div'); mg.className = 'ai'; mg.innerHTML = '<span class="aic">⚙︎</span><span class="atx"><div class="an">Manage agents…</div></span>';
  mg.onclick = async () => { closeAgentMenu(); await openSettings(); showTab('agents'); }; m.appendChild(mg);
  m.hidden = false; $('agentBtn').classList.add('on');
}
function closeAgentMenu() { $('agentMenu').hidden = true; $('agentBtn').classList.remove('on'); }
async function pickAgent(id) {
  closeAgentMenu(); const a = agentById(id); if (!a) return;
  settings = await gc.settings.set({ activeAgent: id });
  if (cur) cur = await gc.conv.update(cur.id, { agentId: id });
  if (a.model) { if (cur) cur = await gc.conv.update(cur.id, { model: a.model }); else settings = await gc.settings.set({ model: a.model }); syncComposer(); }
  if (a.permissionMode && viewMode === 'code') {
    if (cur) cur = await gc.conv.update(cur.id, { permissionMode: a.permissionMode }); else settings = await gc.settings.set({ permissionMode: a.permissionMode });
    syncComposer();
  }
  renderAgentPicker();
}
$('agentBtn').onclick = (e) => { e.stopPropagation(); if ($('agentMenu').hidden) openAgentMenu(); else closeAgentMenu(); };
document.addEventListener('click', (e) => { if (!$('agentMenu').hidden && !$('agentWrap').contains(e.target)) closeAgentMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('agentMenu').hidden) closeAgentMenu(); });
async function renderAgents() {
  await loadAgents(); const box = $('agList'); box.innerHTML = '';
  for (const a of agents) {
    const r = document.createElement('div'); r.className = 'mcard'; const isActive = currentAgent()?.id === a.id;
    const bits = [a.model && `model ${esc(a.model)}`, a.permissionMode && `mode ${esc(a.permissionMode)}`, a.effort && `thinking ${esc(a.effort)}`, a.memory && 'remembers', a.steps && `${a.steps} steps`, a.gates?.length && `${a.gates.length} check${a.gates.length === 1 ? '' : 's'}`, a.guards?.length && `${a.guards.length} rule${a.guards.length === 1 ? '' : 's'}`, a.connectors && `${a.connectors.length} connector${a.connectors.length === 1 ? '' : 's'}`, a.tools && `${a.tools.length} tool${a.tools.length === 1 ? '' : 's'}`, a.paths?.length && `${a.paths.length} folder${a.paths.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
    r.innerHTML = `<div class="mhead"><b>${esc(a.icon || '🤖')} ${esc(a.name)}</b>${a.builtin ? '<span class="mbadge">built-in</span>' : ''}${isActive ? '<span class="mbadge">in use</span>' : ''}${a.enabled ? '' : '<span class="mbadge">off</span>'}</div><div class="msum" style="white-space:normal">${esc(a.description || '')}${bits ? ` <span class="hint">· ${bits}</span>` : ''}</div><div class="mact"></div>`;
    const act = r.querySelector('.mact'); const btn = (t, f) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'outline'; b.textContent = t; b.onclick = f; act.appendChild(b); };
    if (a.enabled && !isActive) btn('Use', async () => { await pickAgent(a.id); renderAgents(); });
    btn('Edit', () => openAgent(a));
    if (!a.builtin) btn('Delete', async () => { if (await gc.confirm(`Delete “${a.name}”?`, 'This agent is removed.', 'Delete')) { await gc.agents.remove(a.id); settings = await gc.settings.get(); renderAgents(); syncComposer(); } });
    else if (a.modified) btn('Reset', async () => { await gc.agents.remove(a.id); renderAgents(); });
    box.appendChild(r);
  }
}
// Every model from every enabled provider, grouped; a saved model that is no longer listed stays selectable.
function fillAgentModels(cur) {
  const groups = catalog.groups.filter((g) => g.models.length);
  const known = groups.some((g) => g.models.some((m) => (m.value || m.id) === cur));
  $('agModel').innerHTML = '<option value="">Default (current model)</option>'
    + (cur && !known ? `<option value="${esc(cur)}">${esc(cur)}</option>` : '')
    + groups.map((g) => `<optgroup label="${esc(g.label)}">${g.models.map((m) => `<option value="${esc(m.value || m.id || '')}">${esc(m.name || m.id)}</option>`).join('')}</optgroup>`).join('');
  $('agModel').value = cur;
}
// Access: a mode select (all / only the ones picked) plus a checkbox list that shows while "picked" is chosen.
const AG_TOOLS = [['read_file', 'Read files'], ['list_dir', 'List folders'], ['grep', 'Search'], ['write_file', 'Write files'], ['edit_file', 'Edit files'], ['bash', 'Shell'], ['web_fetch', 'Web fetch']];
function fillAgentPick(mode, list, items, chosen) {
  $(mode).value = chosen ? 'selected' : 'all'; $(list).hidden = !chosen;
  $(list).innerHTML = items.map(([v, label]) => `<label class="agchk"><input type="checkbox" value="${esc(v)}"${chosen?.includes(v) ? ' checked' : ''}> ${esc(label)}</label>`).join('') || '<span class="hint">None available yet.</span>';
  $(mode).onchange = () => { $(list).hidden = $(mode).value !== 'selected'; };
}
const agPicked = (mode, list) => ($(mode).value === 'selected' ? [...$(list).querySelectorAll('input:checked')].map((i) => i.value) : null);
async function renderAgentNotes(a) {
  const box = $('agNotes'); box.innerHTML = ''; if (!a?.id) return;
  const groups = (await gc.agents.notes(a.id).catch(() => [])) || []; if (!groups.length) return;
  for (const g of groups) {
    const h = document.createElement('div'); h.className = 'mgrp'; h.style.paddingLeft = '0';
    h.innerHTML = `<b>Notes for ${g.scope ? esc(g.scope.split('/').slice(-2).join('/')) : 'no project'}</b> <span class="hint">${g.notes.length}</span><span class="spacer"></span>`;
    const clr = document.createElement('button'); clr.type = 'button'; clr.className = 'outline'; clr.textContent = 'Clear'; clr.onclick = async () => { await gc.agents.clearNotes(a.id, g.scope); renderAgentNotes(a); }; h.appendChild(clr); box.appendChild(h);
    for (const n of g.notes) {
      const r = document.createElement('div'); r.className = 'mtool'; r.innerHTML = `<div>${esc(n.text)}</div>`;
      const d = document.createElement('button'); d.type = 'button'; d.className = 'outline'; d.textContent = 'Delete'; d.onclick = async () => { await gc.agents.forgetNote(a.id, g.scope, n.id); renderAgentNotes(a); }; r.appendChild(d); box.appendChild(r);
    }
  }
}
async function openAgent(a) {
  agEditing = a || null; $('agTitle').textContent = a ? `Edit “${a.name}”` : 'New agent';
  $('agName').value = a?.name || ''; $('agIcon').value = a?.icon || ''; $('agDesc').value = a?.description || ''; $('agInstr').value = a?.instructions || '';
  fillAgentModels(a?.model || ''); $('agMode').value = a?.permissionMode || ''; $('agOn').checked = a ? a.enabled : true; $('agMsg').textContent = '';
  const names = [...new Set([...((await gc.mcp.list().catch(() => [])) || []).map((c) => c.name), ...(a?.connectors || [])])];
  fillAgentPick('agConnMode', 'agConnList', names.map((n) => [n, n]), a?.connectors); fillAgentPick('agToolMode', 'agToolList', AG_TOOLS, a?.tools);
  $('agPaths').value = (a?.paths || []).join('\n');
  $('agMem').checked = !!a?.memory; renderAgentNotes(a);
  $('agEffort').value = a?.effort || ''; $('agSteps').value = a?.steps || ''; $('agReport').value = a?.report || '';
  agSchema ||= await gc.agents.schema().catch(() => ({ gates: {}, guards: {} }));
  const chk = (box, info, on) => { $(box).innerHTML = Object.entries(info).map(([k, label]) => `<label class="agchk"><input type="checkbox" value="${esc(k)}"${on?.includes(k) ? ' checked' : ''}> ${esc(label)}</label>`).join('') || '<span class="hint">None.</span>'; };
  chk('agGuardList', agSchema.guards, a?.guards); chk('agGateList', agSchema.gates, a?.gates);
  $('agDlg').showModal(); $('agName').focus();
}
$('agNew').onclick = () => openAgent(null); $('agCancel').onclick = () => $('agDlg').close();
$('agSave').onclick = async () => {
  const r = await gc.agents.save({ id: agEditing?.id, name: $('agName').value, icon: $('agIcon').value, description: $('agDesc').value, instructions: $('agInstr').value, model: $('agModel').value, permissionMode: $('agMode').value, connectors: agPicked('agConnMode', 'agConnList'), tools: agPicked('agToolMode', 'agToolList'), paths: $('agPaths').value.split('\n'), memory: $('agMem').checked, effort: $('agEffort').value, steps: Number($('agSteps').value) || 0, report: $('agReport').value, guards: [...$('agGuardList').querySelectorAll('input:checked')].map((i) => i.value), gates: [...$('agGateList').querySelectorAll('input:checked')].map((i) => i.value), enabled: $('agOn').checked });
  if (r.error) { $('agMsg').textContent = r.error; $('agMsg').className = 'mmsg bad'; return; }
  $('agDlg').close(); renderAgents();
};

// Design systems
let dsEditing = null;
async function renderDesign() {
  const l = await gc.designSystems.list(), box = $('dsList'); box.innerHTML = '';
  if (!l.length) box.innerHTML = '<p class="hint">No design systems yet. Create one, or import a Markdown or JSON file.</p>';
  for (const d of l) {
    const isDef = settings.defaultDesignSystem === d.id; const r = document.createElement('div'); r.className = 'mcard';
    const sw = Object.entries(d.tokens?.colors || {}).map(([k, v]) => `<i class="sw" title="${esc(k)} ${esc(v)}" style="background:${esc(v)}"></i>`).join('');
    r.innerHTML = `<div class="mhead"><b>${esc(d.name)}</b>${isDef ? '<span class="mbadge">default</span>' : ''}<span class="spacer"></span><span class="swatches">${sw}</span></div><div class="msum" style="white-space:normal">${esc((d.guidelines || '').slice(0, 140)) || '<span class="hint">No guidelines</span>'}</div><div class="mact"></div>`;
    const act = r.querySelector('.mact'); const btn = (t, f, cls = 'outline') => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = t; b.onclick = f; act.appendChild(b); };
    btn(isDef ? 'Stop using by default' : 'Use by default', async () => { await commit({ defaultDesignSystem: isDef ? '' : d.id }); renderDesign(); });
    btn('Edit', () => openDs(d)); btn('Delete', async () => { if (await gc.confirm(`Delete “${d.name}”?`, 'This design system is removed.', 'Delete')) { await gc.designSystems.remove(d.id); settings = await gc.settings.get(); renderDesign(); } });
    box.appendChild(r);
  }
}
function dsColorRow(name = '', value = '#d97757') {
  const r = document.createElement('div'); r.className = 'dscolor';
  r.innerHTML = `<input class="cn" placeholder="name" maxlength="32" value="${esc(name)}"><input class="cc" type="color" value="${esc(/^#[0-9a-f]{6}$/i.test(value) ? value : '#d97757')}"><input class="ch" maxlength="9" value="${esc(value)}"><button type="button" class="outline">✕</button>`;
  const cc = r.querySelector('.cc'), ch = r.querySelector('.ch'); cc.oninput = () => (ch.value = cc.value); ch.oninput = () => { if (/^#[0-9a-f]{6}$/i.test(ch.value)) cc.value = ch.value; }; r.querySelector('button').onclick = () => r.remove(); $('dsColors').appendChild(r);
}
function openDs(d) {
  dsEditing = d?.id || null; $('dsTitle').textContent = d?.id ? `Edit “${d.name}”` : 'New design system'; $('dsName').value = d?.name || ''; $('dsGuide').value = d?.guidelines || '';
  $('dsColors').innerHTML = ''; for (const [k, v] of Object.entries(d?.tokens?.colors || {})) dsColorRow(k, v);
  const f = d?.tokens?.fonts || {}; $('dsFontDisplay').value = f.display || ''; $('dsFontBody').value = f.body || ''; $('dsFontMono').value = f.mono || ''; $('dsRadius').value = d?.tokens?.radius || ''; $('dsSpacing').value = d?.tokens?.spacing || '';
  $('dsMsgDlg').textContent = ''; $('dsDlg').showModal(); $('dsName').focus();
}
$('dsNew').onclick = () => openDs(null); $('dsAddColor').onclick = () => dsColorRow(); $('dsCancel').onclick = () => $('dsDlg').close();
$('dsSave').onclick = async () => {
  const colors = {}; for (const r of $('dsColors').children) { const n = r.querySelector('.cn').value.trim(), v = r.querySelector('.ch').value.trim(); if (n) colors[n] = v; }
  const fonts = Object.fromEntries([['display', 'dsFontDisplay'], ['body', 'dsFontBody'], ['mono', 'dsFontMono']].map(([k, id]) => [k, $(id).value.trim()]).filter(([, v]) => v));
  const r = await gc.designSystems.save({ id: dsEditing || undefined, name: $('dsName').value, guidelines: $('dsGuide').value, tokens: { colors, fonts, radius: $('dsRadius').value.trim(), spacing: $('dsSpacing').value.trim() } });
  if (r.error) { $('dsMsgDlg').textContent = r.error; $('dsMsgDlg').className = 'mmsg bad'; return; }
  $('dsDlg').close(); if (!dsEditing && !settings.defaultDesignSystem) settings = await commit({ defaultDesignSystem: r.system.id }); renderDesign();
};
$('dsImport').onclick = async () => { const r = await gc.designSystems.import(); if (!r) return; if (r.error) { $('dsMsg').textContent = r.error; return; } $('dsMsg').textContent = ''; openDs({ name: r.draft.name, guidelines: r.draft.guidelines, tokens: r.draft.tokens }); };

// Claude Code page extras
$('folderAdd').onclick = async () => { const f = await gc.pickFolder(); if (!f || settings.trustedFolders.includes(f)) return; settings = await gc.settings.set({ trustedFolders: [...settings.trustedFolders, f] }); renderFolders(); refreshList(); };
$('wtChoose').onclick = async () => { const f = await gc.pickFolder(); if (!f) return; const el = document.querySelector('[data-s="worktreeDir"]'); el.value = f; commitField(el); };

// Browser tools (Playwright connector)
async function renderBrowser() {
  const c = (await gc.extensions.catalog()).find((x) => x.id === 'playwright'), box = $('browserCard'); if (!c) return;
  const on = c.installed, ok = c.status === 'running';
  box.innerHTML = `<div class="mcard"><div class="mhead"><span class="mdot ${ok ? 'ok' : on ? 'bad' : 'off'}"></span><b>Browser (Playwright)</b><span class="spacer"></span><span class="hint">${on ? (ok ? 'running' : esc(c.status || 'stopped')) : 'off'}</span></div>
    <div class="msum" style="white-space:normal">${esc(c.description)}</div>${c.error ? `<div class="merr">${esc(c.error)}</div>` : ''}${!c.available ? '<div class="merr">Node.js (npx) wasn’t found on this computer, so this connector can’t start. Install Node.js and try again.</div>' : ''}<div class="mact"></div></div>`;
  const act = box.querySelector('.mact'); const btn = (t, f, cls = 'outline') => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = t; b.onclick = f; act.appendChild(b); return b; };
  if (!on) btn('Turn on', async (e) => { e.target.disabled = true; e.target.textContent = 'Starting…'; const r = await gc.extensions.install('playwright', {}); if (r.error) toast(r.error); renderBrowser(); renderMcp(); }, 'primary');
  else { if (c.status === 'disabled') btn('Turn on', async (e) => { e.target.disabled = true; e.target.textContent = 'Starting…'; await gc.mcp.toggle('playwright', false); renderBrowser(); renderMcp(); }, 'primary');
    else btn('Restart', async (e) => { e.target.disabled = true; e.target.textContent = 'Restarting…'; await gc.mcp.restart('playwright'); renderBrowser(); renderMcp(); });
    btn('Turn off', async () => { await gc.extensions.uninstall('playwright'); renderBrowser(); renderMcp(); }); }
}

// Extensions
async function renderExtensions() {
  const l = await gc.extensions.catalog(), box = $('extList'); box.innerHTML = '';
  for (const c of l) {
    const d = document.createElement('div'); d.className = 'mcard';
    d.innerHTML = `<div class="mhead"><span class="mdot ${c.status === 'running' ? 'ok' : c.installed ? 'bad' : 'off'}"></span><b>${esc(c.name)}</b><span class="mbadge">${esc(c.needs)}</span><span class="spacer"></span><span class="hint">${c.installed ? esc(c.status || 'installed') : ''}</span></div><div class="msum" style="white-space:normal">${esc(c.description)}</div>${c.error ? `<div class="merr">${esc(c.error)}</div>` : ''}${!c.available && !c.installed ? `<div class="hint" style="margin:4px 0">Needs <code>${esc(c.needs)}</code> installed on this computer.</div>` : ''}<div class="mact"></div>`;
    const act = d.querySelector('.mact'); const btn = (t, f, cls = 'outline') => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = t; b.onclick = f; act.appendChild(b); return b; };
    if (!c.installed) btn('Install', async (e) => {
      const params = {};
      for (const p of c.params) { const f = await gc.pickFolder(); if (!f) return; params[p.key] = f; }
      e.target.disabled = true; e.target.textContent = 'Installing…'; const r = await gc.extensions.install(c.id, params); $('extMsg').textContent = r.error || `${c.name} installed`; renderExtensions(); renderMcp();
    }, 'primary'); else btn('Remove', async () => { await gc.extensions.uninstall(c.id); renderExtensions(); renderMcp(); });
    box.appendChild(d);
  }
}
$('extFile').onclick = async () => {
  const i = await gc.extensions.pickBundle(); if (!i) return; if (i.error) { $('extMsg').textContent = i.error; return; }
  if (!(await gc.confirm(`Install ${i.displayName || i.name}?`, `${i.description || 'No description.'}\n\nThis extension runs a program on your computer:\n${i.run}`, 'Install'))) return;
  $('extMsg').textContent = 'Installing…'; const r = await gc.extensions.installBundle(i.src); $('extMsg').textContent = r.error || `${i.displayName || i.name} installed (${r.server?.status || 'saved'})`; renderMcp(); renderExtensions();
};
$('extFolder').onclick = () => gc.extensions.openFolder();

// Plugins
let pluginCmds = [];
async function loadPluginCmds() { try { pluginCmds = await gc.plugins.commands(); } catch { pluginCmds = []; } }
async function renderPlugins() {
  const l = await gc.plugins.list(), box = $('plugList'); box.innerHTML = '';
  if (!l.length) box.innerHTML = '<p class="hint">No plugins installed.</p>';
  for (const p of l) {
    const d = document.createElement('div'); d.className = 'mcard';
    d.innerHTML = `<div class="mhead"><b>${esc(p.name)}</b>${p.version ? `<span class="mbadge">v${esc(p.version)}</span>` : ''}</div><div class="msum" style="white-space:normal">${esc(p.description || '')}</div><div class="hint">${p.skills.length} skill${p.skills.length === 1 ? '' : 's'} · ${p.servers.length} connector${p.servers.length === 1 ? '' : 's'} · ${p.commands.length} command${p.commands.length === 1 ? '' : 's'}</div><div class="mact"></div>`;
    const b = document.createElement('button'); b.type = 'button'; b.className = 'outline'; b.textContent = 'Remove'; b.onclick = async () => { if (await gc.confirm(`Remove “${p.name}”?`, 'Its skills, connectors and commands are removed.', 'Remove')) { await gc.plugins.remove(p.name); await loadPluginCmds(); renderPlugins(); renderSkills(); renderMcp(); } };
    d.querySelector('.mact').appendChild(b); box.appendChild(d);
  }
}
$('plugAdd').onclick = async () => {
  const i = await gc.plugins.pick(); if (!i) return; if (i.error) { $('plugMsg').textContent = i.error; return; }
  const det = [i.skills.length ? `Skills: ${i.skills.join(', ')}` : '', i.servers.length ? `Connectors (these run programs on your computer):\n${i.servers.map((x) => `  ${x.name}: ${x.run}`).join('\n')}` : '', i.commands.length ? `Commands: ${i.commands.join(', ')}` : ''].filter(Boolean).join('\n\n');
  if (!(await gc.confirm(`Install “${i.name}”?`, `${i.description || ''}\n\n${det}`.trim(), 'Install'))) return;
  $('plugMsg').textContent = 'Installing…'; const r = await gc.plugins.install(i.src);
  $('plugMsg').textContent = r.error || (r.errors?.length ? `Installed, but: ${r.errors.join('; ')}` : `${i.name} installed`); await loadPluginCmds(); renderPlugins(); renderSkills(); renderMcp();
};

// ---------- markets (plugins / skills / connectors) ----------
const MK = {
  plugins: { title: 'Plugin market', sub: 'Plugins from the official Claude plugin marketplace (anthropics/claude-plugins-official). They can include skills, connectors and commands.', load: () => gc.market.plugins(), cats: true },
  skills: { title: 'Skills market', sub: 'Skills from Anthropic’s public skills repository (anthropics/skills).', load: () => gc.market.skills() },
  connectors: { title: 'Connector market', sub: 'Servers from the official MCP registry. Connectors run a program on your computer or connect to a remote URL, so only add ones you trust.', search: true },
};
let mk = null;
async function openMarket(kind) {
  mk = { kind, cfg: MK[kind], items: [], next: '', q: '', cat: '', seq: 0 };
  $('mkTitle').textContent = mk.cfg.title; $('mkSub').textContent = mk.cfg.sub; $('mkQ').value = ''; $('mkMsg').textContent = ''; $('mkCat').hidden = true;
  $('marketDlg').showModal(); await mkFetch(false);
}
async function mkFetch(more) {
  const m = mk, seq = ++m.seq; $('mkMsg').textContent = 'Loading…'; $('mkMore').hidden = true;
  if (!more) { $('mkList').innerHTML = ''; m.items = []; m.next = ''; }
  const r = m.cfg.search ? await gc.market.connectors({ q: m.q, cursor: more ? m.next : '' }) : (m.loaded || (m.loaded = await m.cfg.load()));
  if (seq !== m.seq) return;
  if (r?.error) { $('mkMsg').textContent = ''; $('mkList').innerHTML = `<p class="merr">${esc(r.error)}</p><p><button class="outline" id="mkRetry" type="button">Retry</button></p>`; $('mkRetry').onclick = () => { m.loaded = null; mkFetch(false); }; return; }
  m.items = more ? m.items.concat(r.items) : r.items; m.next = r.next || '';
  if (m.cfg.cats) { const cats = [...new Set(m.items.map((x) => x.category).filter(Boolean))].sort(); $('mkCat').innerHTML = '<option value="">All categories</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join(''); $('mkCat').value = m.cat; $('mkCat').hidden = false; }
  mkRender();
}
function mkRender() {
  const m = mk, box = $('mkList'), q = m.q.toLowerCase();
  const shown = m.cfg.search ? m.items : m.items.filter((x) => (!m.cat || x.category === m.cat) && (!q || `${x.name} ${x.description} ${x.author || ''}`.toLowerCase().includes(q)));
  box.innerHTML = '';
  for (const it of shown) {
    const d = document.createElement('div'); d.className = 'mcard';
    const badge = it.category || (m.kind === 'connectors' ? (it.kind === 'remote' ? 'remote' : it.kind) : '');
    d.innerHTML = `<div class="mhead"><b>${esc(it.name)}</b>${badge ? `<span class="mbadge">${esc(badge)}</span>` : ''}<span class="spacer"></span><span class="hint">${esc(it.author || '')}</span></div><div class="msum" style="white-space:normal">${esc((it.description || 'No description.').slice(0, 280))}</div><div class="mfields"></div><div class="mact"></div>`;
    const act = d.querySelector('.mact'), b = document.createElement('button'); b.type = 'button';
    if (it.installed) { b.className = 'outline'; b.textContent = 'Installed'; b.disabled = true; } else { b.className = 'primary'; b.textContent = 'Install'; b.onclick = () => mkInstall(it, b, d); }
    act.appendChild(b); if (it.homepage) { const a = document.createElement('button'); a.type = 'button'; a.className = 'outline'; a.textContent = 'Details ↗'; a.onclick = () => gc.openUrl(it.homepage); act.appendChild(a); }
    box.appendChild(d);
  }
  if (!shown.length) box.innerHTML = '<p class="hint">Nothing matches.</p>';
  $('mkMsg').textContent = `${shown.length} shown`; $('mkMore').hidden = !m.next;
}
async function mkInstall(it, b, card) {
  const kind = mk.kind; let values = {};
  if (kind === 'connectors') {
    const f = await gc.market.connectorFields(it.id); if (f.error) { $('mkMsg').textContent = f.error; return; }
    const box = card.querySelector('.mfields');
    if (f.fields.length && !box.children.length) {
      box.innerHTML = f.fields.map((x, i) => `<div class="fld"><label>${esc(x.name)} <span class="hint">${esc(x.description).slice(0, 120)}</span><input data-f="${esc(x.name)}" ${x.secret ? 'type="password"' : ''} spellcheck="false" autocomplete="off"></label></div>`).join('');
      b.textContent = 'Install with these values'; return;
    }
    for (const i of box.querySelectorAll('input')) values[i.dataset.f] = i.value.trim();
    if (!box.children.length && !(await gc.confirm(`Add “${it.name}”?`, `${it.description || ''}\n\nThis connector will ${/^https?:/.test(f.run) ? 'connect to' : 'run'}: ${f.run}`, 'Add'))) return;
  } else if (kind === 'plugins' && !(await gc.confirm(`Install “${it.name}”?`, `${it.description || ''}\n\nPlugins can include connectors that run programs on your computer. Only install ones you trust.`, 'Install'))) return;
  b.disabled = true; b.textContent = 'Installing…'; $('mkMsg').textContent = '';
  const r = await (kind === 'plugins' ? gc.market.installPlugin(it.id) : kind === 'skills' ? gc.market.installSkill(it.id) : gc.market.installConnector(it.id, values));
  if (r.error) { b.disabled = false; b.textContent = 'Install'; $('mkMsg').textContent = r.error; toast(r.error); return; }
  it.installed = true; if (r.errors?.length) toast(`Installed, but: ${r.errors.join('; ')}`); else toast(`${it.name} installed`);
  if (kind === 'plugins') { await loadPluginCmds(); renderPlugins(); renderSkills(); renderMcp(); } else if (kind === 'skills') renderSkills(); else renderMcp();
  mkRender();
}
let mkT; $('mkQ').oninput = () => { if (!mk) return; mk.q = $('mkQ').value.trim(); if (mk.cfg.search) { clearTimeout(mkT); mkT = setTimeout(() => mkFetch(false), 350); } else mkRender(); };
$('mkCat').onchange = () => { mk.cat = $('mkCat').value; mkRender(); };
$('mkMore').onclick = () => mkFetch(true);
$('mkClose').onclick = () => $('marketDlg').close();
$('plugMarket').onclick = () => openMarket('plugins'); $('skillMarket').onclick = () => openMarket('skills'); $('mcpMarket').onclick = () => openMarket('connectors');

// ---------- providers ----------
const provOpen = new Set();
async function loadProviders() { try { providerCache = await gc.providers.list(); } catch { providerCache = []; } return providerCache; }
async function refreshAfterProviderChange() { settings = await gc.settings.get(); await loadProviders(); await loadCatalog(true); syncComposer(); renderAccount(); renderProviders(); }
async function saveProvider(patch, quiet) {
  const r = await gc.providers.save(patch);
  if (r.error) { toast(r.error); await renderProviders(); return r; }
  await refreshAfterProviderChange(); if (!quiet) $('provMsg').textContent = ''; return r;
}
async function renderProviders() {
  await loadProviders(); const box = $('provList'); box.innerHTML = '';
  for (const p of providerCache) {
    const open = provOpen.has(p.id), warn = p.enabled && p.needsKey && !p.hasKey;
    const d = document.createElement('div'); d.className = 'mcard prov' + (p.enabled ? '' : ' off');
    d.innerHTML = `<div class="mhead"><span class="mdot ${p.enabled ? (warn ? 'wait' : 'ok') : 'off'}"></span><b>${esc(p.name)}</b><span class="mbadge">${p.builtin ? 'built-in' : p.type === 'anthropic' ? 'Anthropic API' : 'OpenAI API'}</span>${p.hasKey ? '<span class="mbadge">key saved</span>' : p.needsKey ? '' : '<span class="mbadge">no key needed</span>'}<span class="spacer"></span><button type="button" class="outline pedit">${open ? 'Close' : 'Edit'}</button><input type="checkbox" class="switch ptoggle" ${p.enabled ? 'checked' : ''} title="Show in the model picker"></div>
      ${warn ? '<div class="merr" style="color:var(--text-3)">On, but needs an API key before its models can be used.</div>' : ''}
      <div class="msum" title="${esc(p.baseUrl || p.defaultBaseUrl)}">${esc(p.baseUrl || p.defaultBaseUrl || 'api.anthropic.com')}</div><div class="pbody" ${open ? '' : 'hidden'}></div>`;
    d.querySelector('.ptoggle').onchange = (e) => saveProvider({ id: p.id, enabled: e.target.checked });
    d.querySelector('.pedit').onclick = () => { open ? provOpen.delete(p.id) : provOpen.add(p.id); renderProviders(); };
    if (open) fillProviderBody(d.querySelector('.pbody'), p);
    box.appendChild(d);
  }
}
async function fillProviderBody(body, p) {
  const dl = `dl-${p.id}`;
  body.innerHTML = `
    ${p.builtin ? '' : `<div class="fld"><label>Name<input class="fn" value="${esc(p.name)}" maxlength="40"></label></div>`}
    <div class="fld"><label>Base URL${p.builtin ? ` <span class="hint">default: ${esc(p.defaultBaseUrl || 'https://api.anthropic.com')}</span>` : ''}<input class="fu" value="${esc(p.baseUrl)}" placeholder="${esc(p.defaultBaseUrl || 'https://api.anthropic.com')}" spellcheck="false"></label>${p.builtin && p.baseUrl !== p.defaultBaseUrl ? '<button type="button" class="outline fur" style="margin-top:6px">Reset URL</button>' : ''}</div>
    ${p.builtin ? '' : `<div class="fld"><label>Type</label><div class="seg ft"><button type="button" data-v="openai" class="${p.type === 'openai' ? 'on' : ''}">OpenAI-compatible</button><button type="button" data-v="anthropic" class="${p.type === 'anthropic' ? 'on' : ''}">Anthropic-compatible</button></div></div>`}
    <div class="fld"><label>API key${p.needsKey ? '' : ' <span class="hint">optional</span>'}<input class="fk" type="password" placeholder="${p.hasKey ? '•••••• (saved)' : 'sk-…'}" autocomplete="off" spellcheck="false"></label>
      <div class="pg-actions" style="margin:6px 0 0"><button type="button" class="outline fks">Save key</button>${p.hasKey ? '<button type="button" class="outline fkr">Remove key</button>' : ''}${p.keyUrl ? `<button type="button" class="outline fkg">Get a key ↗</button>` : ''}</div></div>
    <div class="fld"><label>Models <span class="hint fmc">loading…</span><input class="fm" list="${dl}" value="${esc(p.defaultModel)}" placeholder="Search or type a model" spellcheck="false" autocomplete="off"></label><datalist id="${dl}"></datalist>
      <div class="pg-actions" style="margin:6px 0 0"><button type="button" class="outline fmd">Use as default model</button><button type="button" class="outline fmr">Refresh list</button><span class="hint fms"></span></div></div>
    <div class="pg-actions"><button type="button" class="outline ftest">Test connection</button><span class="hint ftr"></span>${p.builtin ? '' : '<span class="spacer" style="flex:1"></span><button type="button" class="danger fdel">Delete provider</button>'}</div>`;
  const q = (c) => body.querySelector(c);
  const loadModels = async (force) => {
    q('.fmc').textContent = 'loading…'; const r = await gc.providers.models(p.id, force);
    q('.fmc').textContent = `${r.models.length} available${r.error ? ' · ' + r.error : ''}`; q('.fmc').style.color = r.error && !r.models.length ? 'var(--git-del)' : '';
    body.querySelector('datalist').innerHTML = r.models.slice(0, 600).map((m) => `<option value="${esc(m.id)}">${esc(m.name !== m.id ? m.name : '')}</option>`).join(''); body._ids = new Set(r.models.map((m) => m.id));
  };
  loadModels(false);
  const url = () => q('.fu').value.trim();
  q('.fu').onchange = () => saveProvider({ id: p.id, baseUrl: url() });
  if (q('.fur')) q('.fur').onclick = () => saveProvider({ id: p.id, baseUrl: p.defaultBaseUrl });
  if (q('.fn')) q('.fn').onchange = () => saveProvider({ id: p.id, name: q('.fn').value });
  body.querySelectorAll('.ft button').forEach((b) => (b.onclick = () => saveProvider({ id: p.id, type: b.dataset.v })));
  q('.fks').onclick = async () => { const k = q('.fk').value.trim(); if (!k) return toast('Paste a key first'); await saveProvider({ id: p.id, apiKey: k }); toast(`${p.name} key saved`); };
  q('.fk').addEventListener('keydown', (e) => { if (e.key === 'Enter') q('.fks').click(); });
  if (q('.fkr')) q('.fkr').onclick = async () => { if (await gc.confirm(`Remove the ${p.name} key?`, 'The key is deleted from this computer.', 'Remove')) saveProvider({ id: p.id, apiKey: '' }); };
  if (q('.fkg')) q('.fkg').onclick = () => gc.openUrl(p.keyUrl);
  q('.fmr').onclick = () => loadModels(true);
  const chooseModel = async (andDefault) => {
    const m = q('.fm').value.trim(); if (!m) return;
    const own = [...p.models]; if (body._ids && !body._ids.has(m) && !own.includes(m)) own.push(m);
    const r = await saveProvider({ id: p.id, defaultModel: m, models: own }, true); if (r.error) return;
    if (andDefault) { settings = await gc.settings.set({ model: `${p.id}:${m}` }); syncComposer(); loadCatalog(false); q('.fms').textContent = `Default model is now ${m}`; }
  };
  q('.fm').onchange = () => chooseModel(false); q('.fmd').onclick = () => chooseModel(true);
  q('.ftest').onclick = async () => { q('.ftr').textContent = 'Testing…'; q('.ftr').style.color = ''; const r = await gc.providers.test(p.id); q('.ftr').textContent = r.ok ? `Connected ✓ ${r.count} models` : r.error; q('.ftr').style.color = r.ok ? 'var(--git-add)' : 'var(--git-del)'; };
  if (q('.fdel')) q('.fdel').onclick = async () => { if (!(await gc.confirm(`Delete ${p.name}?`, 'The provider and its saved key are removed.', 'Delete'))) return; const r = await gc.providers.remove(p.id); if (r.error) return toast(r.error); provOpen.delete(p.id); await refreshAfterProviderChange(); };
}
$('provAdd').onclick = () => { $('pdName').value = ''; $('pdUrl').value = ''; $('pdKey').value = ''; $('pdMsg').textContent = ''; $('pdType').dataset.v = 'openai'; document.querySelectorAll('#pdType button').forEach((b) => b.classList.toggle('on', b.dataset.v === 'openai')); $('provDlg').showModal(); $('pdName').focus(); };
document.querySelectorAll('#pdType button').forEach((b) => (b.onclick = () => { $('pdType').dataset.v = b.dataset.v; document.querySelectorAll('#pdType button').forEach((x) => x.classList.toggle('on', x === b)); }));
$('pdCancel').onclick = () => $('provDlg').close();
$('pdSave').onclick = async () => {
  const r = await gc.providers.save({ name: $('pdName').value, type: $('pdType').dataset.v, baseUrl: $('pdUrl').value, apiKey: $('pdKey').value.trim() || undefined, needsKey: !!$('pdKey').value.trim() });
  if (r.error) { $('pdMsg').textContent = r.error; $('pdMsg').className = 'mmsg bad'; return; }
  $('provDlg').close(); provOpen.add(r.id); await refreshAfterProviderChange(); $('provMsg').textContent = 'Provider added — open it to pick a model.';
};

// ---------- mods: panels, bands and commands drawn from mod element trees ----------
const MCOLORS = { black: '#1b1b1b', red: '#d14343', green: '#16a34a', yellow: '#c58b00', blue: '#3b82f6', magenta: '#b455c4', cyan: '#0e9db5', white: '#f0efec', gray: '#8a8985', grey: '#8a8985', blackBright: '#6b6a65', redBright: '#ef6a6a', greenBright: '#3fd17e', yellowBright: '#e2b73a', blueBright: '#6ea0f7', magentaBright: '#d27ae0', cyanBright: '#4ec6da', whiteBright: '#ffffff', accent: 'var(--clay)', success: '#16a34a', error: '#d14343', warning: '#c58b00' };
const mcol = (c) => (!c ? '' : MCOLORS[c] || c);
const cx = (v) => (typeof v === 'number' ? v * 8 + 'px' : v);   // terminal cells → px across
const cy = (v) => (typeof v === 'number' ? v * 12 + 'px' : v);  // rows → px down
function modEl(n, ctx) {
  if (n === null || n === undefined || n === false) return document.createDocumentFragment();
  if (typeof n === 'string' || typeof n === 'number') return document.createTextNode(String(n));
  if (Array.isArray(n)) { const f = document.createDocumentFragment(); n.forEach((x) => f.appendChild(modEl(x, ctx))); return f; }
  const p = n.props || {}, kids = n.children || [];
  const add = (el) => { for (const k of kids) el.appendChild(modEl(k, ctx)); return el; };
  const press = (extra) => gc.mods.press({ plugin: n.press.plugin, handle: n.press.handle, element: p.key, component: ctx.component, requestId: ctx.requestId, ...extra }).then(() => scheduleModRender());
  switch (n.type) {
    case 'engine': return document.createDocumentFragment();
    case 'Box': {
      const d = document.createElement('div'), st = d.style; d.className = 'mx-box';
      st.display = p.display === 'none' ? 'none' : 'flex'; st.flexDirection = p.flexDirection || 'row';
      for (const k of ['flexGrow', 'flexShrink', 'flexWrap', 'alignItems', 'alignSelf', 'justifyContent']) if (p[k] !== undefined) st[k] = p[k] === 'flex-start' || p[k] === 'flex-end' ? p[k] : p[k];
      if (p.gap !== undefined) st.gap = cx(p.gap); if (p.columnGap !== undefined) st.columnGap = cx(p.columnGap); if (p.rowGap !== undefined) st.rowGap = cy(p.rowGap);
      const X = { padding: 'padding', margin: 'margin' };
      for (const base of ['padding', 'margin']) {
        if (p[base] !== undefined) st[base] = cy(p[base]) + ' ' + cx(p[base]);
        if (p[base + 'X'] !== undefined) { st[base + 'Left'] = cx(p[base + 'X']); st[base + 'Right'] = cx(p[base + 'X']); }
        if (p[base + 'Y'] !== undefined) { st[base + 'Top'] = cy(p[base + 'Y']); st[base + 'Bottom'] = cy(p[base + 'Y']); }
        for (const [side, f] of [['Top', cy], ['Bottom', cy], ['Left', cx], ['Right', cx]]) if (p[base + side] !== undefined) st[base + side] = f(p[base + side]);
      }
      if (p.width !== undefined) st.width = cx(p.width); if (p.height !== undefined) st.height = cy(p.height); if (p.minWidth !== undefined) st.minWidth = cx(p.minWidth); if (p.minHeight !== undefined) st.minHeight = cy(p.minHeight);
      if (p.borderStyle) { const c = mcol(p.borderColor) || 'var(--line-strong)'; st.border = `1px solid ${p.borderDimColor ? `color-mix(in srgb, ${c} 45%, transparent)` : c}`; st.borderRadius = p.borderStyle === 'round' ? '8px' : '3px'; }
      if (p.backgroundColor) st.background = mcol(p.backgroundColor); if (p.overflow === 'hidden') st.overflow = 'hidden';
      return add(d);
    }
    case 'Text': {
      const t = document.createElement('span'), st = t.style; t.className = 'mx-text';
      if (p.color) st.color = mcol(p.color); if (p.backgroundColor) st.background = mcol(p.backgroundColor);
      if (p.bold || p.weight === 'bold') st.fontWeight = '700'; else if (p.weight === 'semibold') st.fontWeight = '600'; else if (p.weight === 'medium') st.fontWeight = '500';
      if (p.dimColor) st.opacity = '.62'; if (p.italic) st.fontStyle = 'italic';
      const dec = [p.underline && 'underline', p.strikethrough && 'line-through'].filter(Boolean).join(' '); if (dec) st.textDecoration = dec;
      if (p.mono) st.fontFamily = 'var(--mono)'; if (p.tabular) st.fontVariantNumeric = 'tabular-nums';
      if (p.size === 'caption' || p.size === 'footnote') st.fontSize = '11.5px'; else if (p.size === 'heading') st.fontSize = '16px'; else if (p.size === 'title') st.fontSize = '20px';
      if (p.inverse) { st.background = 'var(--text)'; st.color = 'var(--bg)'; }
      if (p.wrap && String(p.wrap).startsWith('truncate') || p.wrap === 'end' || p.wrap === 'middle') { st.whiteSpace = 'nowrap'; st.overflow = 'hidden'; st.textOverflow = 'ellipsis'; st.minWidth = '0'; }
      return add(t);
    }
    case 'Button': {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'mx-btn' + (p.variant === 'primary' ? ' primary' : '') + (p.plain ? ' plain' : '') + (p.role === 'dismiss' ? ' dismiss' : '');
      if (p.dimColor) b.style.opacity = '.62'; if (p.label !== undefined) b.appendChild(document.createTextNode(p.label)); add(b);
      if (p.hotkey) b.title = `Shortcut: ${p.hotkey}`; if (n.press) b.onclick = (e) => { e.stopPropagation(); b.disabled = true; press().finally(() => { b.disabled = false; }); }; return b;
    }
    case 'Svg': { const i = document.createElement('img'); i.alt = p.alt || ''; i.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(p.source || ''); if (p.width) i.width = p.width; if (p.height) i.height = p.height; i.className = 'mx-svg'; return i; }
    case 'Link': { const a = document.createElement('a'); a.href = '#'; a.onclick = (e) => { e.preventDefault(); if (/^https?:/.test(p.url || p.href || '')) gc.openUrl(p.url || p.href); }; if (p.label) a.textContent = p.label; return add(a); }
    case 'Code': { const pre = document.createElement('pre'); pre.className = 'mx-code'; pre.textContent = p.code ?? p.text ?? kids.filter((k) => typeof k === 'string').join(''); return pre; }
    case 'Markdown': { const d = document.createElement('div'); d.className = 'mx-md b'; d.innerHTML = md(p.text ?? p.markdown ?? kids.filter((k) => typeof k === 'string').join('')); return d; }
    case 'Input': { const i = document.createElement('input'); i.className = 'mx-input'; i.placeholder = p.placeholder || p.label || ''; i.value = p.value || ''; i.onkeydown = (e) => { if (e.key === 'Enter' && n.on?.onSubmit) gc.mods.press({ plugin: n.press.plugin, handle: n.on.onSubmit, element: p.key, component: ctx.component, requestId: ctx.requestId, text: i.value }).then(() => scheduleModRender()); }; i.onchange = () => { if (n.on?.onInput) gc.mods.press({ plugin: n.press.plugin, handle: n.on.onInput, element: p.key, component: ctx.component, requestId: ctx.requestId, text: i.value }); }; return i; }
    case 'Select': { const sel = document.createElement('select'); sel.className = 'mx-input'; for (const o of p.options || []) { const op = document.createElement('option'); op.value = o.value ?? o; op.textContent = o.label ?? o.value ?? o; sel.appendChild(op); } sel.value = p.value ?? ''; sel.onchange = () => { if (n.on?.onSelect) gc.mods.press({ plugin: n.press.plugin, handle: n.on.onSelect, element: p.key, component: ctx.component, requestId: ctx.requestId, value: sel.value, text: sel.value }).then(() => scheduleModRender()); }; return sel; }
    default: return add(document.createElement('div'));
  }
}
function paintMod(container, tree, ctx) { container.innerHTML = ''; container.appendChild(modEl(tree, ctx)); }
let modRenderTimer = null, modRenderBusy = false, modActivePane = null;
function scheduleModRender() { clearTimeout(modRenderTimer); modRenderTimer = setTimeout(renderMods, 70); }
const emptyTree = (t) => t === null || t === undefined || (t && t.type === 'engine') || (Array.isArray(t) && !t.length);
async function renderMods() {
  if (modRenderBusy) { scheduleModRender(); return; } modRenderBusy = true;
  try {
    // band above the prompt
    const band = $('modBand');
    if (modInfo.band) {
      const cols = Math.max(40, Math.floor((($('composer').clientWidth || 700) - 24) / 9));
      const tree = await gc.mods.render('AbovePrompt', 'band', { hasSurvey: false, isWorking: !!(cur && busy.has(cur.id)), maxRows: 16, bodyColumns: cols, scroll: { bodyRows: 15, offset: 0 } });
      band.hidden = emptyTree(tree); if (!band.hidden) paintMod(band, tree, { component: 'AbovePrompt', requestId: 'band' });
    } else band.hidden = true;
    // side panes
    const panes = modInfo.panes, pane = $('modPane');
    if (!panes.length) { pane.hidden = true; modActivePane = null; }
    else {
      if (!panes.some((x) => x.id === modActivePane)) modActivePane = panes[panes.length - 1].id;
      pane.hidden = false;
      $('mpTabs').innerHTML = '';
      for (const pn of panes) {
        const t = document.createElement('div'); t.className = 'mp-tab' + (pn.id === modActivePane ? ' on' : ''); t.innerHTML = `<span>${esc(pn.title)}</span>`;
        t.onclick = () => { modActivePane = pn.id; renderMods(); };
        const x = document.createElement('button'); x.type = 'button'; x.className = 'mp-x'; x.textContent = '✕'; x.title = 'Close'; x.onclick = (e) => { e.stopPropagation(); gc.mods.closePane(pn.id); }; t.appendChild(x); $('mpTabs').appendChild(t);
      }
      const act = panes.find((x) => x.id === modActivePane);
      const cols = Math.max(24, Math.floor((($('mpBody').clientWidth || 380) - 28) / 9));
      const tree = await gc.mods.render('Pane', act.id, { title: act.title, isFocused: true, bodyColumns: cols, placement: 'dock', scroll: { bodyRows: 40, offset: 0 }, view: {} });
      paintMod($('mpBody'), tree, { component: 'Pane', requestId: act.id });
    }
    // status line
    const st = $('modStatus'); const lines = (modInfo.status || []).map((x) => x.text).filter(Boolean); st.hidden = !lines.length; st.textContent = lines.join(' · ');
  } catch (e) { console.warn('mod render failed', e); } finally { modRenderBusy = false; }
}
gc.mods.onDirty((info) => { modInfo = info; scheduleModRender(); if (!$('settings').hidden) renderMods2(); });
gc.mods.onToast((t) => toast(`${t.plugin}: ${t.text}`));
gc.mods.onLog((t) => infoLine(`<b>${esc(t.plugin)}</b> · ${esc(t.text)}`));
gc.mods.onOpenPane((x) => { modActivePane = x.id; });
let modSessionTimer = null;
function modSession() { clearTimeout(modSessionTimer); modSessionTimer = setTimeout(() => gc.mods.session({ convId: cur?.id || '', cwd: cur?.cwd || '' }), 50); }
async function runModCommand(c, args) {
  const r = await gc.mods.command(c.plugin, c.name, args);
  if (r && r.text) { const d = document.createElement('div'); d.className = 'sysnote'; d.style.whiteSpace = 'pre-wrap'; d.textContent = r.text; (document.body.classList.contains('home') ? document.body.classList.remove('home') : 0); $('msgs').appendChild(d); $('msgs').scrollTop = 1e9; }
  scheduleModRender();
}
// message rewrites (e.g. screen-share): ask the mods' ui.render hooks for the drawing of each message
function modMask(el, text) {
  clearTimeout(el._mmT); const token = (el._mm = (el._mm || 0) + 1);
  el._mmT = setTimeout(async () => {
    const r = await gc.mods.render('AssistantMessage', 'msg', { text, isFirstOfReply: false }); if (el._mm !== token || !r) return;
    if (r.type === 'engine') { const t = r.props?.text; if (typeof t === 'string' && t !== text) { el.innerHTML = md(t); decorate(el); } }
    else if (r.type) paintMod(el, r, { component: 'AssistantMessage', requestId: 'msg' });
  }, 40);
}
async function modMaskUser(el, text) {
  const r = await gc.mods.render('UserMessage', 'msg', { text }); if (!r) return;
  if (r.type === 'engine') { const t = r.props?.text; if (typeof t === 'string' && t !== text) el.textContent = t; } else if (r.type) paintMod(el, r, { component: 'UserMessage', requestId: 'msg' });
}
async function modMaskTool(d, summary, pre, name, input, output) {
  const r = await gc.mods.render('ToolUse', 'tool', { input: input, output: output ?? '' }); if (!r || r.type !== 'engine') return;
  const ni = r.props?.input, no = r.props?.output;
  if (JSON.stringify(ni) !== JSON.stringify(input) || (output != null && no !== output)) pre.textContent = JSON.stringify(ni ?? input, null, 2) + (output != null ? '\n\n' + (no ?? output) : '');
}
// Settings → Mods
async function renderMods2() {
  const l = await gc.mods.list(), box = $('modList'); box.innerHTML = '';
  if (!l.length) box.innerHTML = '<p class="hint">No mods found. Use “Install from folder or .zip…” (mods are kept in <code>~/.grizzycode/mods</code>), or install one in Claude Code.</p>';
  for (const m of l) {
    const d = document.createElement('div'); d.className = 'mcard';
    const dot = m.status === 'running' ? 'ok' : m.status === 'failed' ? 'bad' : 'off';
    d.innerHTML = `<div class="mhead"><span class="mdot ${dot}"></span><b>${esc(m.name)}</b>${m.version ? `<span class="mbadge">v${esc(m.version)}</span>` : ''}<span class="mbadge">${esc(m.source)}</span><span class="spacer"></span><input type="checkbox" class="switch" ${m.enabled ? 'checked' : ''}></div><div class="msum" style="white-space:normal">${esc(m.description)}</div>${m.error ? `<div class="merr">${esc(String(m.error).split('\n')[0])}</div>` : ''}<div class="hint">${m.enabled ? (m.status === 'running' ? `running · ${m.hooks} hooks` : esc(m.status)) : 'off'}</div><div class="pg-actions" style="margin:6px 0 0"><button class="outline" data-a="reload" type="button"${m.enabled ? '' : ' hidden'}>Reload</button><button class="outline" data-a="reveal" type="button">Show folder</button><button class="outline" data-a="export" type="button">Export .zip</button><button class="outline" data-a="publish" type="button">Publish…</button>${m.source === 'GrizzyCode' ? '<button class="outline" data-a="remove" type="button">Delete</button>' : ''}</div>`;
    const sw = d.querySelector('.switch');
    sw.onchange = async () => { const want = sw.checked; const r = await gc.mods.setEnabled(m.name, want); if (r?.cancelled) { sw.checked = !want; return; } if (r?.error) toast(r.error); modInfo = await gc.mods.info(); scheduleModRender(); renderMods2(); };
    d.querySelector('[data-a=reload]').onclick = async () => { const r = await gc.mods.reload(m.name); $('modMsg').textContent = r?.error || `${m.name} reloaded.`; modInfo = await gc.mods.info(); scheduleModRender(); renderMods2(); };
    d.querySelector('[data-a=reveal]').onclick = () => gc.mods.reveal(m.name);
    d.querySelector('[data-a=export]').onclick = async () => { const r = await gc.mods.export(m.name); if (r) $('modMsg').textContent = r.error || `Saved ${r.file}`; };
    d.querySelector('[data-a=publish]').onclick = async () => {
      const r = await gc.mods.publish(m.name); if (!r || r.cancelled) return;
      $('modMsg').textContent = r.error || `Published ${m.name} to ${r.marketName}${r.replaced ? ' (replaced)' : ''}. In Claude Code: ${r.install.join('  then  ')}`;
    };
    const del = d.querySelector('[data-a=remove]');
    if (del) del.onclick = async () => { const r = await gc.mods.remove(m.name); if (!r || r.cancelled) return; $('modMsg').textContent = r.error || `${m.name} deleted.`; modInfo = await gc.mods.info(); scheduleModRender(); renderMods2(); };
    box.appendChild(d);
  }
}
$('modRefresh').onclick = renderMods2;
$('modNew').onclick = () => { $('modNewForm').hidden = false; $('modNewName').focus(); };
$('modNewCancel').onclick = () => { $('modNewForm').hidden = true; };
$('modNewGo').onclick = async () => {
  const r = await gc.mods.create({ name: $('modNewName').value, description: $('modNewDesc').value });
  if (!r || r.error) { $('modMsg').textContent = r?.error || 'Could not create the mod.'; return; }
  $('modNewForm').hidden = true; $('modNewName').value = ''; $('modNewDesc').value = '';
  $('modMsg').textContent = `Created ${r.name} in ${r.root} — edit hooks/register.tsx, then turn it on below.`; renderMods2();
};
$('modInstall').onclick = async () => { const r = await gc.mods.pickInstall(); if (!r) return; $('modMsg').textContent = r.error || (r.unchanged ? `${r.name} is already installed.` : `${r.name} ${r.replaced ? 'updated' : 'installed'} — turn it on below.`); renderMods2(); };
// ui.ask from a mod
gc.mods.onAsk((q) => {
  const dlg = $('modAsk'); $('maTitle').textContent = q.plugin; $('maQ').textContent = q.question; $('maChip').hidden = !q.header; $('maChip').textContent = q.header || ''; $('maOther').value = '';
  const opts = $('maOpts'); opts.innerHTML = ''; const picked = new Set(); let done = false;
  const finish = (ans) => { if (done) return; done = true; if (dlg.open) dlg.close(); gc.mods.askAnswer(q.id, ans); };
  for (const o of q.options || []) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'outline mopt'; b.textContent = o;
    b.onclick = () => { if (q.multiSelect) { picked.has(o) ? picked.delete(o) : picked.add(o); b.classList.toggle('on', picked.has(o)); } else finish(o); }; opts.appendChild(b);
  }
  $('maOk').hidden = !q.multiSelect && !!(q.options || []).length && false;
  $('maOk').onclick = () => { const other = $('maOther').value.trim(); finish(other || [...picked].join(', ')); };
  $('maOther').onkeydown = (e) => { if (e.key === 'Enter') $('maOk').click(); };
  $('maCancel').onclick = () => finish(null); dlg.oncancel = (e) => { e.preventDefault(); finish(null); };
  dlg.showModal();
});

// ---------- right sidebar: overview of the session (environment, context, connectors, outputs) ----------
let liveOutputs = [], rsTab = 'overview', rsOpenCards = new Set(['outputs']), rsMore = false, rsDir = '', rsTimer = null;
const rsOpen = () => !$('rside').hidden;
function toggleRs(force) { const show = force ?? !rsOpen(); $('rside').hidden = !show; $('rsBtn').classList.toggle('on', show); commit({ rsOpen: show }); if (show) rsRefresh(); }
function rsRefresh() { if (!rsOpen()) return; clearTimeout(rsTimer); rsTimer = setTimeout(renderRs, 60); }
function outputsOf() {
  const seen = new Set(), out = [];
  const add = (p) => { if (p && !seen.has(p)) { seen.add(p); out.push(p); } };
  liveOutputs.forEach(add);
  for (const m of [...(cur?.messages || [])].reverse()) if (Array.isArray(m.content)) for (const b of [...m.content].reverse()) if (b.type === 'tool_use' && (b.name === 'write_file' || b.name === 'edit_file')) add(b.input?.path);
  return out;
}
function rsCard(id, title, right, bodyFn) {
  const open = rsOpenCards.has(id), c = document.createElement('div'); c.className = 'rscard';
  c.innerHTML = `<div class="rshead"><span>${esc(title)}</span><span class="rsarrow">${open ? '⌄' : '›'}</span><span class="spacer"></span><span class="rsright">${right || ''}</span></div>`;
  c.querySelector('.rshead').onclick = () => { open ? rsOpenCards.delete(id) : rsOpenCards.add(id); renderRs(); };
  if (open && bodyFn) { const b = document.createElement('div'); b.className = 'rsbodyc'; bodyFn(b); c.appendChild(b); }
  return c;
}
async function renderRs() {
  const box = $('rsBody'); document.querySelectorAll('#rsTabs .rt[data-t]').forEach((b) => b.classList.toggle('on', b.dataset.t === rsTab));
  box.innerHTML = '';
  if (rsTab === 'files') { await rsFiles(box); return; }
  if (!cur) { box.innerHTML = '<p class="hint" style="padding:14px">Open or start a session to see its overview.</p>'; return; }
  // Environment
  const env = document.createElement('div'); env.className = 'rscard';
  const where = cur.ssh ? `SSH · ${cur.ssh.host}` : 'This computer';
  env.innerHTML = `<div class="rshead"><span>Environment</span><span class="rsarrow">⌄</span></div><div class="rsrow"><svg viewBox="0 0 16 16"><rect x="3" y="3.500" width="10" height="7" rx="1"/><path d="M2 12.500h12"/></svg><span>${esc(where)}</span></div>${cur.mode === 'code' ? `<div class="rsrow" title="${esc(cur.cwd || '')}"><svg viewBox="0 0 16 16"><path d="M2.500 4.500h4l1 1.500h6v6.500h-11z"/></svg><span>${esc((cur.cwd || '').split('/').pop() || '/')}</span><span class="hint rspath">${esc(cur.cwd || '')}</span></div>` : ''}${cur.worktree ? `<div class="rsrow"><svg viewBox="0 0 16 16"><circle cx="4.500" cy="3.500" r="1.500"/><circle cx="4.500" cy="12.500" r="1.500"/><circle cx="11.500" cy="6" r="1.500"/><path d="M4.500 5v6M11.500 7.500c0 2-2 2.500-7 3"/></svg><span>${esc(cur.worktree.branch)}</span></div>` : ''}`;
  box.appendChild(env);
  // Context
  const { used, max, pct } = ctxState(); const p100 = Math.round(pct * 100);
  box.appendChild(rsCard('context', 'Context', max ? `${p100}% <span class="rsbar ${pct >= 0.95 ? 'full' : pct >= 0.8 ? 'warn' : ''}"><i style="width:${Math.max(3, p100)}%"></i></span>` : `${fmt(used)}`, (b) => { b.innerHTML = ctxPopHtml().replace(/<div class="act">[\s\S]*$/, ''); }));
  // Connectors
  let mcp = []; try { mcp = (await gc.mcp.list()).filter((m) => !m.builtin || m.status === 'running' || m.disabled); } catch {} // built-in Google apps appear here once signed in
  const bad = mcp.filter((m) => !m.disabled && m.status !== 'running');
  box.appendChild(rsCard('connectors', 'Connectors', mcp.length ? (bad.length ? `${bad.length} to reconnect` : `${mcp.length} connected`) : 'None', (b) => {
    if (!mcp.length) { b.innerHTML = '<div class="hint" style="padding:4px 2px">No connectors. Add one in Settings → Connectors.</div>'; return; }
    for (const m of mcp) { const r = document.createElement('div'); r.className = 'rsrow'; r.innerHTML = `<span class="mdot ${m.status === 'running' ? 'ok' : m.disabled ? 'off' : 'bad'}"></span><span>${esc(m.name)}</span><span class="spacer"></span>`; if (!m.disabled && m.status !== 'running') { const bt = document.createElement('button'); bt.type = 'button'; bt.className = 'outline'; bt.textContent = 'Reconnect'; bt.onclick = async () => { bt.textContent = '…'; await gc.mcp.restart(m.name); renderRs(); }; r.appendChild(bt); } b.appendChild(r); }
  }));
  // Outputs
  const outs = outputsOf();
  const oc = rsCard('outputs', 'Outputs', outs.length ? '' : 'None yet', (b) => {
    if (!outs.length) { b.innerHTML = '<div class="hint" style="padding:4px 2px">Files written in this session appear here.</div>'; return; }
    for (const f of (rsMore ? outs : outs.slice(0, 5))) { const full = f.startsWith('/') ? f : `${(cur.cwd || '').replace(/\/$/, '')}/${f}`; const r = document.createElement('div'); r.className = 'rsrow link'; r.title = full; r.innerHTML = `<svg viewBox="0 0 16 16"><path d="M5.500 5 2.500 8l3 3M10.500 5l3 3-3 3"/></svg><span>${esc(f.split('/').pop())}</span>`; r.onclick = () => gc.artifacts.open(full); b.appendChild(r); }
    if (outs.length > 5) { const m = document.createElement('div'); m.className = 'rsmore'; m.textContent = rsMore ? 'Show less' : 'Show more'; m.onclick = () => { rsMore = !rsMore; renderRs(); }; b.appendChild(m); }
  });
  box.appendChild(oc);
}
async function rsFiles(box) {
  if (!cur?.cwd || cur.ssh) { box.innerHTML = '<p class="hint" style="padding:14px">Files are shown for local code sessions.</p>'; return; }
  const r = await gc.files.list(cur.cwd, rsDir);
  const head = document.createElement('div'); head.className = 'rsrow'; head.style.padding = '8px 12px'; head.innerHTML = `<b>${esc(rsDir || (cur.cwd.split('/').pop() || '/'))}</b>`; box.appendChild(head);
  if (rsDir) { const up = document.createElement('div'); up.className = 'rsrow link'; up.style.padding = '4px 12px'; up.textContent = '↑ ..'; up.onclick = () => { rsDir = rsDir.split('/').slice(0, -1).join('/'); renderRs(); }; box.appendChild(up); }
  if (r.error) { const e = document.createElement('p'); e.className = 'hint'; e.style.padding = '8px 12px'; e.textContent = r.error; box.appendChild(e); return; }
  for (const f of r.entries) { const row = document.createElement('div'); row.className = 'rsrow link'; row.style.padding = '4px 12px'; row.innerHTML = `<span>${f.dir ? '▸ ' : ''}${esc(f.name)}</span>`; row.onclick = () => { if (f.dir) { rsDir = rsDir ? `${rsDir}/${f.name}` : f.name; renderRs(); } else gc.artifacts.open(`${cur.cwd.replace(/\/$/, '')}/${rsDir ? rsDir + '/' : ''}${f.name}`); }; box.appendChild(row); }
}
$('rsBtn').onclick = () => toggleRs();
document.querySelectorAll('#rsTabs .rt[data-t]').forEach((b) => (b.onclick = () => {
  const t = b.dataset.t;
  if (t === 'terminal') { toggle('term'); return; } if (t === 'changes') { toggle('diff'); return; }
  rsTab = t; rsDir = ''; renderRs();
}));
$('rsMore').onclick = () => toggleRs(false);

// ---------- resizable sidebars ----------
function makeResizable(handle, { cssVar, key, def, min, max, fromRight }) {
  const root = document.documentElement, el = handle.parentElement;
  const set = (w) => { root.style.setProperty(cssVar, Math.round(Math.max(min, Math.min(max, w))) + 'px'); window.dispatchEvent(new Event('resize')); };
  if (settings[key]) set(settings[key]);
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault(); handle.setPointerCapture(e.pointerId); handle.classList.add('on'); document.body.classList.add('rzing');
    const x0 = e.clientX, w0 = el.getBoundingClientRect().width;
    const move = (m) => set(w0 + (fromRight ? x0 - m.clientX : m.clientX - x0));
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); handle.classList.remove('on'); document.body.classList.remove('rzing'); gc.settings.set({ [key]: Math.round(parseFloat(root.style.getPropertyValue(cssVar)) || def) }); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('dblclick', () => { root.style.removeProperty(cssVar); window.dispatchEvent(new Event('resize')); gc.settings.set({ [key]: 0 }); });
}

// ---------- boot ----------
(async () => {
  settings = await gc.settings.get();
  makeResizable($('rzSide'), { cssVar: '--side-w', key: 'sideW', def: 280, min: 200, max: 520 });
  makeResizable($('rzRs'), { cssVar: '--rs-w', key: 'rsW', def: 300, min: 240, max: 640, fromRight: true });
  makeResizable($('rzDiff'), { cssVar: '--diff-w', key: 'diffW', def: 420, min: 280, max: 800, fromRight: true });
  homeFolder = settings.pinnedFolders?.[0] || settings.trustedFolders?.[0] || null;
  if (settings.rsOpen) { $('rside').hidden = false; $('rsBtn').classList.add('on'); }
  applyFont(settings.font); applyAppearance(); applyCaps(); loadPluginCmds(); loadProviders(); gc.mods.info().then((i) => { modInfo = i; scheduleModRender(); });
  document.body.classList.toggle('nosidebar', !!settings.sidebarHidden);
  setView(viewMode, false);
  const q = new URLSearchParams(location.search).get('conv');
  if (q) return open(q);
  goHome();
})();
