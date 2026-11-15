// Team map page: departments as panels (drag a panel to place it, drag a card to move an agent), shared instructions, shared memory,
// authority, usage by department, and a message bar that sends @Department / @agent / @everyone messages through a normal conversation.
// Shares app.js / pages.js globals ($, esc, gc, toast, settings, open, send, ensureTrusted, setView, openSettings, showTab, openAgent, shell, P).
let tmDays = 7, tmDraft = { folder: null, text: '' }, tmNames = [], tmNamesAt = 0;
const tmNameList = (secs) => [...secs.filter((x) => !x.general || x.count).map((x) => ({ n: x.name, k: 'department', hint: x.lead ? 'lead ' + x.lead.name : 'department' })), ...secs.flatMap((x) => [x.lead, ...x.members]).filter(Boolean).map((a) => ({ n: a.name, k: 'agent', hint: a.description })), { n: 'everyone', k: 'everyone', hint: 'the chief hands it to every department' }];
const TM = { W: 290, CARD: 74, GAP: 10, HEAD: 58, PAD: 14 };
const tmKindIcon = { person: '👤', place: '📍', decision: '✅', term: '📖' };
const tmFmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));

// A small modal: html in, the dialog out (closed and removed when dismissed).
function tmDialog(html, width = 560) {
  const d = document.createElement('dialog'); d.className = 'tmdlg'; d.style.width = width + 'px'; d.innerHTML = `<div class="body" style="padding:20px 24px">${html}</div>`;
  document.body.appendChild(d); d.addEventListener('close', () => d.remove()); d.addEventListener('cancel', () => d.remove()); d.showModal(); return d;
}
const tmErr = (r) => { if (r && r.error) { toast(r.error); return true; } return false; };

async function pgTeam() {
  const snap = await gc.teams.snapshot(), usage = await gc.teams.usage(tmDays), secs = snap.sections;
  tmNames = tmNameList(secs); tmNamesAt = Date.now();
  const maxTok = Math.max(1, ...usage.map((u) => u.tokens));
  $('page').innerHTML = `<div class="tm">
    <div class="pg-head"><h1>Team map</h1><span class="hint">Departments of agents. Tag one in any message: <code>@App-Coder build a login page</code> goes to its lead, who hands the work to the team and reports one result.</span><span class="grow"></span><button class="primary" id="tmNew">New department</button></div>
    ${snap.error ? `<div class="tm-warn">${esc(snap.error)}</div>` : ''}
    <div class="tm-canvas" id="tmCanvas"></div>
    <div class="tm-msg"><div class="tm-msgrow"><input id="tmText" placeholder="Message the team, e.g. @App-Coder build a todo app" autocomplete="off" value="${esc(tmDraft.text)}"><button class="outline" id="tmFolder" title="Code sessions can read and write files in a folder">${tmDraft.folder ? '📁 ' + esc(folderName(tmDraft.folder)) : 'Chat (no folder)'}</button>${tmDraft.folder ? '<button class="outline" id="tmNoFolder" title="Back to chat without a folder">✕</button>' : ''}<button class="primary" id="tmSend">Send</button></div>
      <div class="hint">${tmDraft.folder ? 'Starts a code session in this folder, so the team can read, write and run things there.' : 'Without a folder this is a chat: agents can talk and research but cannot touch files. Choose a folder to let a coder build something.'}</div></div>
    <div class="tm-usage"><div class="tm-uhead"><b>Usage by department</b><span class="seg" id="tmDays">${[7, 30].map((d) => `<button type="button" data-d="${d}" class="${tmDays === d ? 'on' : ''}">${d} days</button>`).join('')}</span></div>
      ${usage.map((u) => `<div class="tm-urow"><span class="tm-uname">${esc(u.name)}</span><span class="tm-ubar"><i style="width:${Math.max(u.tokens ? 2 : 0, Math.round((u.tokens / maxTok) * 100))}%"></i></span><span class="tm-unum">${u.runs ? u.runs + ' run' + (u.runs === 1 ? '' : 's') + ' · ' : ''}${tmFmt(u.tokens)} tokens</span></div>`).join('')}
      <div class="hint">Counted in the department an agent was in when it ran, so moving an agent never rewrites its past.</div></div></div>`;
  tmLayout(secs); tmWire(snap);
}

function tmLayout(secs) {
  // Two passes: build every panel, measure its real height, then place the ones without a saved position in the shortest column.
  const cv = $('tmCanvas'); cv.innerHTML = '';
  secs.forEach((sec) => {
    const cards = (sec.lead ? [sec.lead] : []).concat(sec.members);
    const el = document.createElement('section'); el.className = 'tm-panel' + (sec.general ? ' general' : ''); el.dataset.id = sec.id; el.style.cssText = `left:0;top:0;width:${TM.W}px;visibility:hidden`;
    el.innerHTML = `<div class="tm-ph" title="Drag to place this department"><div class="tm-ph1"><b>${esc(sec.name)}</b><span class="tm-count">${sec.count}</span>${sec.hasInstructions ? '<span title="Has shared instructions">📝</span>' : ''}${sec.pending ? `<span class="tm-pend" title="Notes waiting for your review">${sec.pending}</span>` : ''}</div>
      <div class="tm-ph2"><button class="tm-ib" data-act="instr" title="Shared instructions">Instructions</button><button class="tm-ib" data-act="mem" title="Shared memory">Memory</button>${sec.general ? '' : '<button class="tm-ib" data-act="rename" title="Rename">Rename</button><button class="tm-ib danger" data-act="del" title="Delete department (agents are kept and move to General)">Delete</button>'}</div></div>
      <div class="tm-cards">${cards.length ? cards.map((a) => tmCard(a, sec, secs)).join('') : '<div class="tm-drop">Drag an agent here</div>'}</div>`;
    cv.appendChild(el);
  });
  const cols = Math.max(1, Math.floor((Math.max(cv.clientWidth, 320) - 20) / (TM.W + 24))), colY = Array(cols).fill(10); let maxY = 0;
  secs.forEach((sec) => {
    const el = cv.querySelector(`.tm-panel[data-id="${sec.id}"]`), h = el.offsetHeight, c = colY.indexOf(Math.min(...colY)), pos = sec.position || { x: 10 + c * (TM.W + 24), y: colY[c] };
    if (!sec.position) colY[c] += h + 24;
    el.style.left = pos.x + 'px'; el.style.top = pos.y + 'px'; el.style.visibility = ''; maxY = Math.max(maxY, pos.y + h);
  });
  cv.style.height = Math.max(260, maxY + 30) + 'px';
}
function tmCard(a, sec, secs) {
  const isLead = sec.lead && sec.lead.id === a.id;
  return `<div class="tm-card${isLead ? ' lead' : ''}" draggable="true" data-id="${esc(a.id)}"><div class="tm-ct"><span class="tm-ic">${esc(a.icon)}</span><b>${esc(a.name)}</b>${isLead ? '<span class="tm-badge">Lead</span>' : ''}</div><div class="tm-cd">${esc((a.description || '').length > 90 ? a.description.slice(0, 88) + '…' : a.description || '')}</div>
    <div class="tm-ca"><select class="tm-move" title="Move to another department" aria-label="Move ${esc(a.name)} to">${secs.map((s) => `<option value="${esc(s.id)}"${s.id === sec.id ? ' selected' : ''}>${s.id === sec.id ? 'In ' : 'Move to '}${esc(s.name)}</option>`).join('')}</select>
    <button class="tm-ib" data-act="lead" title="${isLead ? 'Remove as lead' : 'Make this agent the lead of the department'}">${isLead ? 'Unlead' : 'Make lead'}</button>${isLead ? '<button class="tm-ib" data-act="auth" title="Which other departments this lead is in charge of">Authority</button>' : ''}<button class="tm-ib" data-act="edit" title="Edit this agent">Edit</button></div></div>`;
}

function tmWire(snap) {
  const secs = snap.sections, byId = (id) => secs.find((x) => x.id === id), cv = $('tmCanvas');
  P('#tmNew').onclick = () => tmNewDialog(snap);
  P('#tmDays').querySelectorAll('button').forEach((b) => (b.onclick = () => { tmDays = Number(b.dataset.d); pgTeam(); }));
  P('#tmFolder').onclick = async () => { const f = await gc.pickFolder(); if (f) { tmDraft.folder = f; tmDraft.text = P('#tmText').value; pgTeam(); } };
  P('#tmNoFolder')?.addEventListener('click', () => { tmDraft.folder = null; tmDraft.text = P('#tmText').value; pgTeam(); });
  P('#tmSend').onclick = tmSend; P('#tmText').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.defaultPrevented) tmSend(); });
  tmAtComplete(P('#tmText'));
  cv.querySelectorAll('.tm-panel').forEach((p) => {
    const sec = byId(p.dataset.id);
    p.querySelectorAll('.tm-ph .tm-ib').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); ({ instr: () => tmInstrDialog(sec), mem: () => tmMemDialog(sec), rename: () => tmRename(sec), del: () => tmDelete(sec) })[b.dataset.act](); }));
    // dragging a panel by its header places it
    p.querySelector('.tm-ph').addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return; const sx = e.clientX, sy = e.clientY, ox = p.offsetLeft, oy = p.offsetTop; let moved = false; p.classList.add('dragging');
      const mv = (ev) => { moved = true; p.style.left = Math.max(0, ox + ev.clientX - sx) + 'px'; p.style.top = Math.max(0, oy + ev.clientY - sy) + 'px'; };
      const up = async () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); p.classList.remove('dragging'); if (moved) { await gc.teams.setPosition(sec.id, { x: p.offsetLeft, y: p.offsetTop }); pgTeam(); } };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
    // dropping a card on a panel moves the agent there, at the position under the pointer
    p.addEventListener('dragover', (e) => { e.preventDefault(); p.classList.add('over'); }); p.addEventListener('dragleave', (e) => { if (!p.contains(e.relatedTarget)) p.classList.remove('over'); });
    p.addEventListener('drop', async (e) => {
      e.preventDefault(); p.classList.remove('over'); const id = e.dataTransfer.getData('text/plain'); if (!id) return;
      const others = [...p.querySelectorAll('.tm-card')].filter((c) => c.dataset.id !== id && !c.classList.contains('lead')); let idx = others.findIndex((c) => e.clientY < c.getBoundingClientRect().top + c.offsetHeight / 2); if (idx < 0) idx = others.length;
      if (!tmErr(await gc.teams.move(id, sec.id, idx))) pgTeam();
    });
    p.querySelectorAll('.tm-card').forEach((c) => {
      const a = [sec.lead, ...sec.members].find((x) => x && x.id === c.dataset.id);
      c.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', c.dataset.id); e.dataTransfer.effectAllowed = 'move'; c.classList.add('dragging'); }); c.addEventListener('dragend', () => c.classList.remove('dragging'));
      c.querySelector('.tm-move').onchange = async (e) => { if (!tmErr(await gc.teams.move(a.id, e.target.value))) { toast(`Moved ${a.name} to ${byId(e.target.value).name}.`); pgTeam(); } };
      c.querySelectorAll('.tm-ca .tm-ib').forEach((b) => (b.onclick = async () => {
        if (b.dataset.act === 'lead') { if (!tmErr(await gc.teams.setLead(sec.id, sec.lead && sec.lead.id === a.id ? '' : a.id))) pgTeam(); }
        else if (b.dataset.act === 'auth') tmAuthDialog(sec, secs);
        else { await openSettings(); showTab('agents'); const full = (await gc.agents.list()).find((x) => x.id === a.id); if (full) openAgent(full); }
      }));
    });
  });
}

async function tmSend() {
  const text = P('#tmText').value.trim(); if (!text) return; tmDraft.text = '';
  if (tmDraft.folder) { if (!(await ensureTrusted(tmDraft.folder))) return; setView('code', false); const c = await gc.conv.create({ mode: 'code', cwd: tmDraft.folder, permissionMode: 'acceptEdits' }); await open(c.id); }
  else { setView('chat', false); const c = await gc.conv.create({ mode: 'chat' }); await open(c.id); }
  $('input').value = text; send();
}

function tmNewDialog(snap) {
  const d = tmDialog(`<h2>New department</h2><label class="fld">Name<input id="tdName" placeholder="e.g. App-Coder" autocomplete="off"></label>
    <div class="sub">Start from</div><div class="tm-tpls">${snap.templates.map((t, i) => `<label class="tm-tpl"><input type="radio" name="tdT" value="${t.id}"${i === 0 ? ' checked' : ''}><span><b>${esc(t.name)}</b><br><i>${esc(t.summary)}</i>${t.roles.length ? `<br><i>${t.roles.map(esc).join(' · ')}</i>` : ''}</span></label>`).join('')}</div>
    <p class="hint">A preset creates its agents as new copies owned by this department (the lead delegates to the others). Edit them later under Settings → Agents.</p>
    <div class="foot" style="padding:12px 0 0;display:flex;gap:8px;justify-content:flex-end"><button class="outline" id="tdCancel" type="button">Cancel</button><button class="primary" id="tdOk" type="button">Create</button></div>`);
  const q = (s) => d.querySelector(s); q('#tdName').focus(); q('#tdCancel').onclick = () => d.close();
  const go = async () => { const r = await gc.teams.create(q('#tdName').value, d.querySelector('input[name=tdT]:checked').value); if (!tmErr(r)) { d.close(); toast(`Created ${q('#tdName').value.trim()}.`); pgTeam(); } };
  q('#tdOk').onclick = go; q('#tdName').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}
function tmRename(sec) {
  const d = tmDialog(`<h2>Rename department</h2><label class="fld">Name<input id="trName" value="${esc(sec.name)}" autocomplete="off"></label><div class="foot" style="padding:12px 0 0;display:flex;gap:8px;justify-content:flex-end"><button class="outline" id="trC" type="button">Cancel</button><button class="primary" id="trOk" type="button">Rename</button></div>`, 420);
  d.querySelector('#trC').onclick = () => d.close(); const go = async () => { if (!tmErr(await gc.teams.rename(sec.id, d.querySelector('#trName').value))) { d.close(); pgTeam(); } };
  d.querySelector('#trOk').onclick = go; d.querySelector('#trName').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); }); d.querySelector('#trName').select();
}
async function tmDelete(sec) {
  if (!(await gc.confirm(`Delete “${sec.name}”?`, 'Its agents are kept and move to General. Its shared instructions and memory are removed.', 'Delete department'))) return;
  if (!tmErr(await gc.teams.remove(sec.id))) { toast('Department deleted; its agents moved to General.'); pgTeam(); }
}

async function tmInstrDialog(sec) {
  const cur = await gc.teams.getInstructions(sec.id);
  const d = tmDialog(`<h2>Shared instructions · ${esc(sec.name)}</h2><p class="hint">Added to the prompt of every agent in this department on every turn, the lead included. Only you can edit them. Your own standing instructions and the current request still win over them.</p>
    <textarea id="tiText" rows="10" spellcheck="true" placeholder="Goals, house rules, tone, facts everyone here should know…">${esc(cur.text)}</textarea><div class="hint"><span id="tiCount"></span></div>
    <div class="foot" style="padding:12px 0 0;display:flex;gap:8px;justify-content:flex-end"><button class="outline" id="tiC" type="button">Cancel</button><button class="primary" id="tiOk" type="button">Save</button></div>`, 620);
  const t = d.querySelector('#tiText'), count = () => { const b = new Blob([t.value]).size; d.querySelector('#tiCount').textContent = `${b.toLocaleString()} of 24,000 bytes${b > 24000 ? ' — too long' : ''}`; }; count(); t.addEventListener('input', count);
  d.querySelector('#tiC').onclick = () => d.close();
  d.querySelector('#tiOk').onclick = async () => { if (!tmErr(await gc.teams.setInstructions(sec.id, t.value))) { d.close(); toast(t.value.trim() ? 'Instructions saved.' : 'Instructions cleared.'); pgTeam(); } };
}

async function tmAuthDialog(sec, secs) {
  const own = sec.id, on = new Set(sec.managed || []);
  const d = tmDialog(`<h2>Authority · ${esc(sec.lead.name)}</h2><p class="hint">A lead is always in charge of its own department. Being in charge lets it dismiss a delegated agent in that department (dismiss_agent) even if it did not start it. It can still message any agent. Tick the other departments it should answer for.</p>
    ${secs.filter((x) => x.id !== own).map((x) => `<label class="srow"><span>${esc(x.name)}</span><input type="checkbox" value="${esc(x.id)}"${on.has(x.id) ? ' checked' : ''}></label>`).join('') || '<p class="hint">There are no other departments.</p>'}
    <div class="foot" style="padding:12px 0 0;display:flex;gap:8px;justify-content:flex-end"><button class="outline" id="taC" type="button">Cancel</button><button class="primary" id="taOk" type="button">Save</button></div>`, 460);
  d.querySelector('#taC').onclick = () => d.close();
  d.querySelector('#taOk').onclick = async () => { if (!tmErr(await gc.teams.setManaged(sec.lead.id, [...d.querySelectorAll('input:checked')].map((i) => i.value)))) { d.close(); toast('Authority saved.'); pgTeam(); } };
}

// Shared memory: what agents proposed (to review), what is accepted (in every prompt), search, add, edit, pin, undo.
async function tmMemDialog(sec, q = '') {
  const all = await gc.teams.facts(sec.id), word = q.trim().toLowerCase();
  const shown = word ? all.filter((f) => [f.name, f.detail, ...f.aliases].join(' ').toLowerCase().includes(word)) : all, pend = shown.filter((f) => f.status === 'proposed'), acc = shown.filter((f) => f.status === 'accepted');
  const row = (f) => `<div class="tm-fact" data-id="${f.id}" data-rev="${f.revision}"><div class="tm-ft"><span>${tmKindIcon[f.kind] || ''}</span><b>${esc(f.name)}</b>${f.pinned ? '<span title="Pinned: loaded first">📌</span>' : ''}<span class="grow"></span><i>${f.sourceName ? 'from ' + esc(f.sourceName) : ''}</i></div><div class="tm-fd">${esc(f.detail)}</div>${f.aliases.length ? `<div class="hint">also: ${esc(f.aliases.join(', '))}</div>` : ''}${f.status === 'proposed' && f.replaces.length ? '<div class="hint">Replaces an accepted note with the same key.</div>' : ''}
    <div class="tm-fa">${f.status === 'proposed' ? '<button class="primary" data-a="accept">Accept</button><button class="outline" data-a="reject">Reject</button>' : `<button class="outline" data-a="pin">${f.pinned ? 'Unpin' : 'Pin'}</button>${f.canUndo ? '<button class="outline" data-a="undo" title="Take back this accept and put back any note it replaced">Undo accept</button>' : ''}`}<button class="outline" data-a="edit">Edit</button>${f.status === 'accepted' ? '<button class="outline danger" data-a="del">Delete</button>' : ''}</div></div>`;
  const d = tmDialog(`<h2>Shared memory · ${esc(sec.name)}</h2><p class="hint">Facts every agent in this department shares. Agents <b>propose</b> notes while they work; you review each one. Only accepted notes reach a prompt.</p>
    <input id="tmQ" placeholder="Search notes" value="${esc(q)}" autocomplete="off" style="width:100%;margin:6px 0 10px">
    ${pend.length ? `<div class="sub">To review (${pend.length})</div>${pend.map(row).join('')}` : ''}<div class="sub">Accepted (${acc.length})</div>${acc.length ? acc.map(row).join('') : `<p class="hint">${word ? 'No accepted notes match.' : 'No accepted notes yet.'}</p>`}
    <div class="sub">${'Add a note'}</div><div class="tm-add"><select id="tmK">${['decision', 'person', 'place', 'term'].map((k) => `<option>${k}</option>`).join('')}</select><input id="tmN" placeholder="Short title" maxlength="120" autocomplete="off"><input id="tmD" placeholder="The fact, its context and why it matters" maxlength="600" autocomplete="off"><button class="primary" id="tmAdd" type="button">Add</button></div>
    <div class="foot" style="padding:12px 0 0;display:flex;justify-content:flex-end"><button class="outline" id="tmX" type="button">Close</button></div>`, 680);
  d.classList.add('tmmem'); d.querySelector('#tmX').onclick = () => d.close(); d.addEventListener('close', () => { if (pageName === 'team') pgTeam(); }); // closing refreshes the map's badges
  const qi = d.querySelector('#tmQ'); qi.addEventListener('keydown', (e) => { if (e.key === 'Enter') { d.remove(); tmMemDialog(sec, qi.value); } });
  d.querySelector('#tmAdd').onclick = async () => { if (!tmErr(await gc.teams.memAdd(sec.id, { kind: d.querySelector('#tmK').value, name: d.querySelector('#tmN').value, detail: d.querySelector('#tmD').value }))) { d.remove(); tmMemDialog(sec, q); } };
  d.querySelectorAll('.tm-fact').forEach((el) => el.querySelectorAll('[data-a]').forEach((b) => (b.onclick = async () => {
    const id = el.dataset.id, rev = Number(el.dataset.rev), f = all.find((x) => x.id === id), a = b.dataset.a; let r;
    if (a === 'edit') return tmEditFact(d, sec, f, q);
    if (a === 'accept') r = await gc.teams.memResolve(sec.id, id, true, rev); else if (a === 'reject') r = await gc.teams.memResolve(sec.id, id, false, rev);
    else if (a === 'pin') r = await gc.teams.memUpdate(sec.id, id, { pinned: !f.pinned }, rev); else if (a === 'undo') r = await gc.teams.memUndo(sec.id, id);
    else if (a === 'del') { if (!(await gc.confirm(`Delete “${f.name}”?`, 'It is removed from every agent’s prompt.', 'Delete'))) return; r = await gc.teams.memRemove(sec.id, id, rev); }
    if (!tmErr(r)) { d.remove(); tmMemDialog(sec, q); }
  })));
}
function tmEditFact(parent, sec, f, q) {
  const d = tmDialog(`<h2>Edit note</h2><label class="fld">Title<input id="efN" value="${esc(f.name)}" maxlength="120"></label><label class="fld">Detail<textarea id="efD" rows="4" maxlength="600">${esc(f.detail)}</textarea></label><label class="fld">Also known as (comma separated)<input id="efA" value="${esc(f.aliases.join(', '))}"></label>
    ${f.status === 'proposed' ? '<p class="hint">Saving an edit to a proposal accepts it.</p>' : ''}<div class="foot" style="padding:12px 0 0;display:flex;gap:8px;justify-content:flex-end"><button class="outline" id="efC" type="button">Cancel</button><button class="primary" id="efOk" type="button">Save</button></div>`, 520);
  d.querySelector('#efC').onclick = () => d.close();
  d.querySelector('#efOk').onclick = async () => { const r = await gc.teams.memUpdate(sec.id, f.id, { name: d.querySelector('#efN').value, detail: d.querySelector('#efD').value, aliases: d.querySelector('#efA').value.split(',').map((x) => x.trim()).filter(Boolean) }, f.revision); if (!tmErr(r)) { d.close(); parent.remove(); tmMemDialog(sec, q); } };
}

// @-completion for a message box: type @ then a few letters; Tab/Enter/click inserts the full name.
function tmAtComplete(input) {
  if (input._at) return; input._at = true; let box = null, sel = 0, items = [];
  const close = () => { box?.remove(); box = null; items = []; };
  const token = () => { const v = input.value, pos = input.selectionStart, m = /(?:^|[^\p{L}\p{N}_])([@＠])([^@＠\n]*)$/u.exec(v.slice(0, pos)); return m && !/\s$/.test(m[2]) ? { start: pos - m[2].length - 1, q: m[2].toLowerCase(), end: pos } : null; }; // a trailing space means the name is finished
  const names = async () => { if (!tmNames.length || Date.now() - tmNamesAt > 4000) { tmNames = tmNameList((await gc.teams.snapshot()).sections); tmNamesAt = Date.now(); } return tmNames; };
  const show = async () => {
    const t = token(); if (!t) return close(); const all = await names();
    items = all.filter((x) => x.n.toLowerCase().includes(t.q)).sort((a, b) => (b.n.toLowerCase().startsWith(t.q) - a.n.toLowerCase().startsWith(t.q)) || (a.k === 'department' ? -1 : 1)).slice(0, 8); if (!items.length) return close();
    sel = Math.min(sel, items.length - 1); if (!box) { box = document.createElement('div'); box.className = 'tm-at'; document.body.appendChild(box); }
    const r = input.getBoundingClientRect(); box.style.left = r.left + 'px'; box.style.bottom = window.innerHeight - r.top + 6 + 'px'; box.style.minWidth = Math.min(r.width, 360) + 'px';
    box.innerHTML = items.map((x, i) => `<div class="${i === sel ? 'on' : ''}" data-i="${i}"><b>@${esc(x.n)}</b><span>${x.k === 'department' ? '🏢 ' : x.k === 'everyone' ? '👥 ' : '🤖 '}${esc((x.hint || '').slice(0, 60))}</span></div>`).join('');
    box.querySelectorAll('div').forEach((el) => (el.onmousedown = (e) => { e.preventDefault(); pick(Number(el.dataset.i)); }));
  };
  const pick = (i) => { const t = token(), x = items[i]; if (!t || !x) return; input.value = input.value.slice(0, t.start) + '@' + x.n + ' ' + input.value.slice(t.end); const p = t.start + x.n.length + 2; input.setSelectionRange(p, p); close(); input.dispatchEvent(new Event('input', { bubbles: true })); };
  input.addEventListener('input', () => { sel = 0; show(); }); input.addEventListener('blur', () => setTimeout(close, 120));
  (input.form || input.parentElement).addEventListener('keydown', (e) => {
    if (!box || e.target !== input) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopImmediatePropagation(); sel = (sel + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; show(); }
    else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); e.stopImmediatePropagation(); pick(sel); }
    else if (e.key === 'Escape') { e.stopImmediatePropagation(); close(); }
  }, true);
}
// The main composer gets the same @-completion; the team names are refreshed whenever the Team page or the composer needs them.
tmAtComplete($('input'));
