// Built-in artifact types and starter templates. Every template is a single self-contained HTML page that runs inside the artifact
// sandbox (no network). They use the host bridge `window.cowork` when it is there and degrade to localStorage when exported.
// Template bodies avoid backticks and ${} so they can live in String.raw literals.

const TYPES = {
  page: { title: 'Page / app', description: 'A small interactive web page or tool: calculators, games, forms, visualizations.',
    guide: 'One self-contained HTML document. Inline all CSS and JS. Make it responsive and keyboard-friendly. Use the CSS variables --bg --fg --muted --line --card --accent already defined for light/dark.' },
  dashboard: { title: 'Dashboard', description: 'KPI tiles, charts and a table over data that is embedded in the page or kept in cowork.db.',
    guide: 'Put the data in one `const DATA = {...}` object at the top so it is easy to update with the edit action. Use Chart.js from https://cdn.jsdelivr.net/npm/chart.js@4.5.0/dist/chart.umd.min.js (served locally by the sandbox). Lead with 3-5 KPI tiles, then charts, then a detail table. Label axes and units; never invent numbers the user did not give you.' },
  slides: { title: 'Slide deck', description: 'A presentation: one <section class="slide"> per slide, arrow-key navigation, fullscreen, print to PDF.',
    guide: 'Each slide is <section class="slide">. Keep the navigation script from the template (arrows, space, F for fullscreen, P to print). One idea per slide, big type, at most ~30 words per slide. Optional speaker notes go in data-notes.' },
  doc: { title: 'Document', description: 'A long-form editable document with a formatting toolbar that saves itself.',
    guide: 'A contenteditable article that autosaves its HTML to cowork.db collection "doc" id "main". Use real headings (h1-h3), paragraphs and lists. Keep the print stylesheet.' },
  design: { title: 'Design prototype', description: 'A visual design or UI mock-up with a live tweak panel for color, radius and type scale.',
    guide: 'Build the design with CSS variables and expose the important ones in a small tweak panel (see template). Prefer system fonts, real copy over lorem ipsum, and inline SVG for icons and illustrations.' },
  tracker: { title: 'Tracker', description: 'A persistent board, list or log that keeps its records in cowork.db.',
    guide: 'Records live in cowork.db (set/update/delete/list) so they survive reloads and are not baked into the HTML. Render from db.list() on load and after each write.' },
  diagram: { title: 'Diagram', description: 'A flowchart, sequence, ER or Gantt diagram drawn with Mermaid, with an editable source pane.',
    guide: 'Use Mermaid from https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js (served locally). Keep the source in a textarea, render with mermaid.render, and show parse errors inline.' },
};

const T = {};

T.dashboard = { type: 'dashboard', title: 'Sales dashboard', description: 'KPI tiles, a revenue line chart, a region bar chart and a sortable table.', html: String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sales dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.5.0/dist/chart.umd.min.js"></script>
<style>
body{margin:0;padding:24px;max-width:1100px;margin-inline:auto}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 20px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.kpi b{display:block;font-size:26px;letter-spacing:-.02em}.kpi span{color:var(--muted);font-size:12px}.up{color:#2e9e5b}.down{color:#d6453d}
.charts{display:grid;grid-template-columns:2fr 1fr;gap:12px;margin-bottom:16px}@media(max-width:720px){.charts{grid-template-columns:1fr}}
canvas{max-height:260px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line)}th{cursor:pointer;color:var(--muted);font-weight:600;font-size:12px}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
button{background:var(--accent);color:var(--accent-fg);border:0;border-radius:8px;padding:8px 12px;font:inherit;cursor:pointer}
#insight{white-space:pre-wrap;margin-top:10px;color:var(--muted)}
</style></head><body>
<h1>Sales dashboard</h1><p class="sub">Sample data - edit the DATA object at the top of the script.</p>
<div class="kpis" id="kpis"></div>
<div class="charts"><div class="card"><canvas id="line"></canvas></div><div class="card"><canvas id="bar"></canvas></div></div>
<div class="card"><table id="tbl"></table></div>
<p><button id="ask" hidden>Ask for insights</button></p><div id="insight"></div>
<script>
const DATA = {
  months: ['Jan','Feb','Mar','Apr','May','Jun'],
  revenue: [42, 47, 51, 49, 58, 64],
  regions: [{name:'North',revenue:120,orders:840,growth:.12},{name:'South',revenue:95,orders:710,growth:.04},{name:'East',revenue:80,orders:590,growth:-.03},{name:'West',revenue:116,orders:802,growth:.09}]
};
const total = DATA.revenue.reduce((a,b)=>a+b,0), orders = DATA.regions.reduce((a,r)=>a+r.orders,0);
const kpis = [['Revenue ($k)',total,.08],['Orders',orders,.05],['Avg order ($)',Math.round(total*1000/orders),.02],['Best region',DATA.regions.slice().sort((a,b)=>b.revenue-a.revenue)[0].name,null]];
document.getElementById('kpis').innerHTML = kpis.map(function(k){return '<div class="card kpi"><span>'+k[0]+'</span><b>'+k[1]+'</b>'+(k[2]==null?'':'<span class="'+(k[2]>=0?'up':'down')+'">'+(k[2]>=0?'+':'')+(k[2]*100).toFixed(0)+'% vs last period</span>')+'</div>';}).join('');
const css = getComputedStyle(document.documentElement), accent = css.getPropertyValue('--accent').trim(), grid = css.getPropertyValue('--line').trim(), fg = css.getPropertyValue('--muted').trim();
Chart.defaults.color = fg; Chart.defaults.borderColor = grid;
new Chart(document.getElementById('line'), {type:'line',data:{labels:DATA.months,datasets:[{label:'Revenue ($k)',data:DATA.revenue,borderColor:accent,backgroundColor:accent+'33',fill:true,tension:.3}]},options:{plugins:{legend:{display:false}}}});
new Chart(document.getElementById('bar'), {type:'bar',data:{labels:DATA.regions.map(function(r){return r.name;}),datasets:[{label:'Revenue ($k)',data:DATA.regions.map(function(r){return r.revenue;}),backgroundColor:accent}]},options:{plugins:{legend:{display:false}}}});
let sort = {k:'revenue',d:-1};
function table(){ const rows = DATA.regions.slice().sort(function(a,b){return (a[sort.k]>b[sort.k]?1:-1)*sort.d;});
  const cols = [['name','Region'],['revenue','Revenue ($k)'],['orders','Orders'],['growth','Growth']];
  document.getElementById('tbl').innerHTML = '<tr>'+cols.map(function(c){return '<th class="'+(c[0]==='name'?'':'n')+'" data-k="'+c[0]+'">'+c[1]+'</th>';}).join('')+'</tr>'+rows.map(function(r){return '<tr><td>'+r.name+'</td><td class="n">'+r.revenue+'</td><td class="n">'+r.orders+'</td><td class="n '+(r.growth>=0?'up':'down')+'">'+(r.growth*100).toFixed(0)+'%</td></tr>';}).join('');
  document.querySelectorAll('th').forEach(function(th){th.onclick=function(){sort={k:th.dataset.k,d:sort.k===th.dataset.k?-sort.d:-1};table();};}); }
table();
if (window.cowork && window.cowork.askClaude) { const b = document.getElementById('ask'); b.hidden = false;
  b.onclick = async function(){ b.disabled = true; document.getElementById('insight').textContent = 'Thinking...';
    try { document.getElementById('insight').textContent = await cowork.askClaude('Give 3 short, concrete insights about this sales data.', DATA); } catch (e) { document.getElementById('insight').textContent = String(e.message || e); }
    b.disabled = false; }; }
</script></body></html>` };

T.slides = { type: 'slides', title: 'Slide deck', description: 'Five-slide starter deck with arrow-key navigation, fullscreen and print-to-PDF.', html: String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Slide deck</title>
<style>
html,body{height:100%;margin:0;overflow:hidden}
.slide{position:absolute;inset:0;display:none;flex-direction:column;justify-content:center;padding:8vh 9vw;box-sizing:border-box}
.slide.on{display:flex}
.slide h1{font-size:clamp(34px,6vw,76px);line-height:1.05;margin:0 0 .4em;letter-spacing:-.03em}
.slide h2{font-size:clamp(26px,4vw,52px);margin:0 0 .6em;letter-spacing:-.02em}
.slide p,.slide li{font-size:clamp(16px,2.2vw,28px);line-height:1.45;color:var(--muted)}
.slide li{margin:.35em 0;color:var(--fg)}
.accent{color:var(--accent)}
.bar{position:fixed;left:0;bottom:0;height:4px;background:var(--accent);transition:width .2s}
.num{position:fixed;right:18px;bottom:12px;color:var(--muted);font-size:12px}
.hint{position:fixed;left:18px;bottom:12px;color:var(--muted);font-size:12px}
@media print{html,body{height:auto;overflow:visible}.slide{position:relative;display:flex;min-height:100vh;page-break-after:always}.bar,.num,.hint{display:none}}
</style></head><body>
<section class="slide"><h1>Your <span class="accent">big idea</span></h1><p>A one-line subtitle that says why it matters.</p></section>
<section class="slide"><h2>The problem</h2><ul><li>What hurts today</li><li>Who feels it most</li><li>What it costs</li></ul></section>
<section class="slide"><h2>The approach</h2><p>Explain the single insight behind your solution in two sentences.</p></section>
<section class="slide"><h2>Results so far</h2><ul><li>Metric one, with a number</li><li>Metric two, with a number</li><li>One quote from a real user</li></ul></section>
<section class="slide"><h1>Thank you</h1><p>Questions?</p></section>
<div class="bar" id="bar"></div><div class="hint">&larr; &rarr; navigate &middot; F fullscreen &middot; P print</div><div class="num" id="num"></div>
<script>
const S = Array.prototype.slice.call(document.querySelectorAll('.slide')); let i = 0;
try { i = Math.min(S.length-1, Math.max(0, parseInt(location.hash.slice(1),10)-1 || 0)); } catch (e) {}
function show(n){ i = Math.max(0, Math.min(S.length-1, n)); S.forEach(function(s,k){s.classList.toggle('on',k===i);});
  document.getElementById('bar').style.width = ((i+1)/S.length*100)+'%'; document.getElementById('num').textContent = (i+1)+' / '+S.length; try{history.replaceState(null,'','#'+(i+1));}catch(e){} }
document.addEventListener('keydown', function(e){
  if (e.key==='ArrowRight'||e.key===' '||e.key==='PageDown') { e.preventDefault(); show(i+1); }
  else if (e.key==='ArrowLeft'||e.key==='PageUp') { e.preventDefault(); show(i-1); }
  else if (e.key==='Home') show(0); else if (e.key==='End') show(S.length-1);
  else if (e.key==='f'||e.key==='F') { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(); }
  else if (e.key==='p'||e.key==='P') window.print(); });
document.addEventListener('click', function(e){ if (e.clientX > innerWidth/2) show(i+1); else show(i-1); });
show(i);
</script></body></html>` };

T.doc = { type: 'doc', title: 'Document', description: 'An editable document with a formatting toolbar that autosaves, plus an "improve selection" action.', html: String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Document</title>
<style>
body{margin:0}.tb{position:sticky;top:0;display:flex;gap:6px;align-items:center;padding:8px 16px;background:var(--bg);border-bottom:1px solid var(--line);z-index:2}
.tb button{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 9px;font:inherit;cursor:pointer}.tb button:hover{border-color:var(--accent)}
.tb .grow{flex:1}.tb small{color:var(--muted)}
article{max-width:720px;margin:32px auto 80px;padding:0 24px;font:17px/1.7 Georgia,'Iowan Old Style',serif;outline:none}
article h1{font:700 34px/1.2 var(--font);letter-spacing:-.02em}article h2{font:650 24px/1.3 var(--font);margin-top:1.6em}article h3{font:650 18px/1.3 var(--font)}
article blockquote{border-left:3px solid var(--accent);margin:1em 0;padding-left:16px;color:var(--muted)}
@media print{.tb{display:none}article{margin:0}}
</style></head><body>
<div class="tb"><button data-c="formatBlock:h1">H1</button><button data-c="formatBlock:h2">H2</button><button data-c="formatBlock:p">P</button><button data-c="bold"><b>B</b></button><button data-c="italic"><i>I</i></button>
<button data-c="insertUnorderedList">&bull; List</button><button data-c="formatBlock:blockquote">Quote</button><span class="grow"></span><button id="imp" hidden>Improve selection</button><small id="st">Saved</small></div>
<article id="doc" contenteditable="true" spellcheck="true"><h1>Untitled document</h1><p>Start writing here. Your changes are saved automatically.</p><h2>A section</h2><p>Use the toolbar for headings, emphasis, lists and quotes.</p></article>
<script>
const doc = document.getElementById('doc'), st = document.getElementById('st'), db = window.cowork && window.cowork.db; let t;
function words(){ return (doc.innerText.trim().match(/\S+/g)||[]).length; }
function saved(){ st.textContent = 'Saved · '+words()+' words'; }
async function save(){ try { if (db) await db.set('doc','main',{html:doc.innerHTML,at:Date.now()}); else localStorage.setItem('doc',doc.innerHTML); saved(); } catch(e){ st.textContent='Not saved: '+e.message; } }
doc.addEventListener('input', function(){ st.textContent='Editing...'; clearTimeout(t); t=setTimeout(save,500); });
document.querySelectorAll('[data-c]').forEach(function(b){ b.onmousedown=function(e){e.preventDefault();}; b.onclick=function(){ const p=b.dataset.c.split(':'); document.execCommand(p[0],false,p[1]||null); doc.dispatchEvent(new Event('input')); }; });
(async function(){ try { const d = db ? await db.get('doc','main') : {html:localStorage.getItem('doc')}; if (d && d.html) doc.innerHTML = d.html; } catch(e){} saved(); })();
if (window.cowork && window.cowork.askClaude) { const b=document.getElementById('imp'); b.hidden=false; b.onmousedown=function(e){e.preventDefault();};
  b.onclick=async function(){ const sel=getSelection(); const txt=sel.toString(); if(!txt) { st.textContent='Select some text first'; return; }
    st.textContent='Improving...'; try { const r=await cowork.askClaude('Rewrite this text to be clearer and tighter. Keep the meaning and tone. Reply with only the rewritten text.', {text:txt}); document.execCommand('insertText',false,r.trim()); doc.dispatchEvent(new Event('input')); } catch(e){ st.textContent=String(e.message||e); } }; }
</script></body></html>` };

T.design = { type: 'design', title: 'Landing page design', description: 'A landing-page mock-up with a live tweak panel (accent, radius, type scale, dark mode).', html: String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Landing page design</title>
<style>
:root{--a:#d97757;--r:14px;--s:1}
body{margin:0;font-size:calc(16px*var(--s))}
nav{display:flex;align-items:center;gap:20px;padding:18px 6vw}nav b{font-size:1.2em;margin-right:auto}nav a{color:var(--muted);text-decoration:none}
.hero{padding:9vh 6vw 6vh;max-width:900px}.hero h1{font-size:calc(clamp(38px,6vw,68px)*var(--s));line-height:1.04;letter-spacing:-.03em;margin:0 0 .4em}
.hero p{font-size:1.25em;color:var(--muted);max-width:34em}.btn{display:inline-block;background:var(--a);color:#fff;padding:.7em 1.2em;border-radius:var(--r);text-decoration:none;font-weight:600;margin-right:10px}
.btn.o{background:none;color:var(--fg);border:1px solid var(--line)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;padding:0 6vw 10vh}
.c{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:22px}.c i{display:grid;place-items:center;width:38px;height:38px;border-radius:calc(var(--r)*.7);background:var(--a);color:#fff;font-style:normal;margin-bottom:12px}
.c h3{margin:0 0 6px}.c p{margin:0;color:var(--muted)}
#tw{position:fixed;right:16px;bottom:16px;width:210px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;font-size:12px;box-shadow:0 8px 30px #0003}
#tw label{display:block;margin:8px 0 2px;color:var(--muted)}#tw input[type=range]{width:100%}#tw input[type=color]{width:100%;height:28px;border:0;background:none;padding:0}
</style></head><body>
<nav><b>Northwind</b><a href="#">Product</a><a href="#">Pricing</a><a href="#">Docs</a></nav>
<section class="hero"><h1>Ship the thing you meant to build.</h1><p>A calm, fast workspace for small teams. Plan, write and review in one place without the noise.</p><a class="btn" href="#">Start free</a><a class="btn o" href="#">Book a demo</a></section>
<section class="grid"><div class="c"><i>1</i><h3>Plan</h3><p>Turn ideas into a clear sequence of work.</p></div><div class="c"><i>2</i><h3>Write</h3><p>Docs and specs that stay next to the code.</p></div><div class="c"><i>3</i><h3>Review</h3><p>Comments, approvals and history in one thread.</p></div></section>
<div id="tw"><b>Tweaks</b><label>Accent</label><input type="color" id="a" value="#d97757"><label>Corner radius</label><input type="range" id="r" min="0" max="32" value="14"><label>Type scale</label><input type="range" id="s" min="85" max="125" value="100"><label><input type="checkbox" id="d"> Force dark</label></div>
<script>
const root=document.documentElement, db=window.cowork&&window.cowork.db;
function apply(v){ root.style.setProperty('--a',v.a); root.style.setProperty('--r',v.r+'px'); root.style.setProperty('--s',v.s/100); root.style.colorScheme=v.d?'dark':''; if(v.d){root.style.setProperty('--bg','#1c1c1b');root.style.setProperty('--fg','#f2f2ef');root.style.setProperty('--card','#262625');root.style.setProperty('--line','#3a3a38');root.style.setProperty('--muted','#a5a5a0');}else{['--bg','--fg','--card','--line','--muted'].forEach(function(k){root.style.removeProperty(k);});} }
function read(){ return {a:a.value,r:+r.value,s:+s.value,d:d.checked}; }
['a','r','s','d'].forEach(function(id){ document.getElementById(id).oninput=function(){ const v=read(); apply(v); if(db) db.set('tweaks','v',v); }; });
(async function(){ try{ const v=db&&await db.get('tweaks','v'); if(v){ a.value=v.a; r.value=v.r; s.value=v.s; d.checked=v.d; apply(v); } }catch(e){} })();
</script></body></html>` };

T.kanban = { type: 'tracker', title: 'Kanban board', description: 'Three-column board with drag-and-drop that persists in the artifact database.', html: String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kanban board</title>
<style>
body{margin:0;padding:20px}h1{font-size:18px;margin:0 0 14px}
.cols{display:grid;grid-template-columns:repeat(3,minmax(200px,1fr));gap:12px;align-items:start}
.col{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px;min-height:140px}.col.over{border-color:var(--accent)}
.col h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:2px 4px 8px}
.card{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin-bottom:8px;cursor:grab;display:flex;gap:8px;align-items:flex-start}
.card span{flex:1;word-break:break-word}.card button{background:none;border:0;color:var(--muted);cursor:pointer;font-size:16px;line-height:1}
form{display:flex;gap:8px;margin-bottom:16px}input{flex:1;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:inherit}
form button{background:var(--accent);color:var(--accent-fg);border:0;border-radius:8px;padding:8px 14px;font:inherit;cursor:pointer}
</style></head><body>
<h1>Kanban board</h1><form id="f"><input id="t" placeholder="Add a card and press Enter" autocomplete="off"><button>Add</button></form>
<div class="cols" id="cols"></div>
<script>
const COLS=[['todo','To do'],['doing','In progress'],['done','Done']]; const db=window.cowork&&window.cowork.db; const mem={};
const store={ async list(){ if(db) return db.list('cards'); return Object.keys(mem).map(function(k){return Object.assign({id:k},mem[k]);}); },
  async set(id,v){ if(db) return db.set('cards',id,v); mem[id]=v; }, async del(id){ if(db) return db.delete('cards',id); delete mem[id]; } };
async function render(){ const cards=await store.list(); cards.sort(function(a,b){return (a.at||0)-(b.at||0);});
  const el=document.getElementById('cols'); el.innerHTML='';
  COLS.forEach(function(c){ const col=document.createElement('div'); col.className='col'; col.innerHTML='<h2>'+c[1]+' ('+cards.filter(function(x){return x.col===c[0];}).length+')</h2>';
    col.ondragover=function(e){e.preventDefault();col.classList.add('over');}; col.ondragleave=function(){col.classList.remove('over');};
    col.ondrop=async function(e){ e.preventDefault(); const id=e.dataTransfer.getData('text/plain'); const k=cards.find(function(x){return x.id===id;}); if(k){ await store.set(id,{title:k.title,col:c[0],at:k.at}); render(); } };
    cards.filter(function(x){return x.col===c[0];}).forEach(function(k){ const d=document.createElement('div'); d.className='card'; d.draggable=true; d.ondragstart=function(e){e.dataTransfer.setData('text/plain',k.id);};
      const s=document.createElement('span'); s.textContent=k.title; const x=document.createElement('button'); x.textContent='×'; x.title='Delete'; x.onclick=async function(){ await store.del(k.id); render(); }; d.append(s,x); col.append(d); });
    el.append(col); }); }
document.getElementById('f').onsubmit=async function(e){ e.preventDefault(); const i=document.getElementById('t'); const v=i.value.trim(); if(!v) return; i.value=''; await store.set('c'+Date.now().toString(36),{title:v,col:'todo',at:Date.now()}); render(); };
render();
</script></body></html>` };

T.diagram = { type: 'diagram', title: 'Mermaid diagram', description: 'Editable Mermaid source with live rendering and inline error messages.', html: String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mermaid diagram</title>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<style>
body{margin:0;height:100vh;display:grid;grid-template-columns:minmax(260px,32%) 1fr}@media(max-width:720px){body{grid-template-columns:1fr;grid-template-rows:200px 1fr;height:auto}}
textarea{border:0;border-right:1px solid var(--line);background:var(--card);color:var(--fg);font:13px/1.5 var(--mono);padding:14px;resize:none;outline:none}
#out{padding:20px;overflow:auto;display:flex;justify-content:center;align-items:flex-start}#err{color:#d6453d;white-space:pre-wrap;font:12px var(--mono)}
</style></head><body>
<textarea id="src" spellcheck="false">flowchart TD
  A[Idea] --> B{Worth building?}
  B -- yes --> C[Prototype]
  B -- no --> D[Archive]
  C --> E[Ship]
  E --> F[Learn]
  F --> A</textarea>
<div id="out"></div>
<script>
const dark = matchMedia('(prefers-color-scheme: dark)').matches; mermaid.initialize({startOnLoad:false, theme: dark ? 'dark' : 'default', securityLevel:'strict'});
const src=document.getElementById('src'), out=document.getElementById('out'), db=window.cowork&&window.cowork.db; let n=0,t;
async function draw(){ try{ const r=await mermaid.render('m'+(++n), src.value); out.innerHTML=r.svg; if(db) db.set('diagram','src',{text:src.value}); }catch(e){ out.innerHTML='<div id="err"></div>'; document.getElementById('err').textContent=String(e.message||e); var b=document.getElementById('dmermaid'+n); if(b) b.remove(); } }
src.oninput=function(){ clearTimeout(t); t=setTimeout(draw,250); };
(async function(){ try{ const d=db&&await db.get('diagram','src'); if(d&&d.text) src.value=d.text; }catch(e){} draw(); })();
</script></body></html>` };

T.assistant = { type: 'page', title: 'Ask Claude panel', description: 'A chat panel inside an artifact that calls the model through cowork.askClaude.', html: String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Assistant panel</title>
<style>
body{margin:0;height:100vh;display:flex;flex-direction:column}header{padding:12px 18px;border-bottom:1px solid var(--line);font-weight:600}
#log{flex:1;overflow:auto;padding:16px 18px;display:flex;flex-direction:column;gap:10px}
.m{max-width:80%;padding:9px 13px;border-radius:14px;white-space:pre-wrap;word-break:break-word}.u{align-self:flex-end;background:var(--accent);color:var(--accent-fg)}.a{align-self:flex-start;background:var(--card);border:1px solid var(--line)}
form{display:flex;gap:8px;padding:12px 18px;border-top:1px solid var(--line)}input{flex:1;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:10px;padding:10px 12px;font:inherit}
button{background:var(--accent);color:var(--accent-fg);border:0;border-radius:10px;padding:0 16px;font:inherit;cursor:pointer}button:disabled{opacity:.5}
</style></head><body>
<header>Assistant</header><div id="log"></div>
<form id="f"><input id="q" placeholder="Ask anything..." autocomplete="off"><button id="go">Send</button></form>
<script>
const log=document.getElementById('log'), q=document.getElementById('q'), go=document.getElementById('go'), db=window.cowork&&window.cowork.db; let hist=[];
function add(role,text){ const d=document.createElement('div'); d.className='m '+(role==='user'?'u':'a'); d.textContent=text; log.append(d); log.scrollTop=log.scrollHeight; return d; }
document.getElementById('f').onsubmit=async function(e){ e.preventDefault(); const v=q.value.trim(); if(!v) return; q.value=''; add('user',v); go.disabled=true; const w=add('assistant','...');
  try{ if(!window.cowork) throw new Error('This panel only works inside GrizzyCode.'); const r=await cowork.askClaude(v,{conversation:hist.slice(-10)}); w.textContent=r; hist.push({role:'user',text:v},{role:'assistant',text:r}); if(db) db.set('chat','history',{items:hist.slice(-40)}); }
  catch(err){ w.textContent=String(err.message||err); } go.disabled=false; q.focus(); };
(async function(){ try{ const d=db&&await db.get('chat','history'); if(d&&d.items){ hist=d.items; hist.forEach(function(m){add(m.role,m.text);}); } }catch(e){} })();
</script></body></html>` };

T.poll = { type: 'tracker', title: 'Poll', description: 'A one-question poll with live result bars, kept in the artifact database.', html: String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Poll</title>
<style>
body{margin:0;padding:32px 20px;display:grid;place-items:start center}.w{width:min(520px,100%)}h1{font-size:22px;margin:0 0 18px;letter-spacing:-.01em}
.o{position:relative;display:block;width:100%;text-align:left;margin-bottom:8px;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--fg);font:inherit;cursor:pointer;overflow:hidden}
.o i{position:absolute;inset:0 auto 0 0;background:var(--accent);opacity:.18;transition:width .3s}.o span{position:relative;display:flex;justify-content:space-between}
.o:hover{border-color:var(--accent)}.o.me{border-color:var(--accent)}small{color:var(--muted)}
</style></head><body><div class="w"><h1 id="q">Which should we build first?</h1><div id="opts"></div><small id="tot"></small></div>
<script>
const OPTIONS=['Dark mode','Offline sync','Team sharing','Faster search']; const db=window.cowork&&window.cowork.db; const mem={};
// One document per option holds its tally ("tally" collection, id = option index); this browser's own pick is kept in "me".
async function get(c,id){ return db ? db.get(c,id) : (mem[c+id]||null); }
async function put(c,id,v){ return db ? db.set(c,id,v) : (mem[c+id]=v); }
async function render(){ const counts=[]; for(let i=0;i<OPTIONS.length;i++){ const d=await get('tally','o'+i); counts.push(d?d.n:0); }
  const me=await get('me','pick'); const total=counts.reduce(function(a,b){return a+b;},0); const el=document.getElementById('opts'); el.innerHTML='';
  OPTIONS.forEach(function(o,i){ const n=counts[i], b=document.createElement('button'); b.className='o'+(me&&me.i===i?' me':''); b.innerHTML='<i style="width:'+(total?n/total*100:0)+'%"></i><span><b></b><em>'+n+'</em></span>'; b.querySelector('b').textContent=o;
    b.onclick=async function(){ if(me&&me.i===i) return; if(me) await put('tally','o'+me.i,{n:Math.max(0,counts[me.i]-1)}); await put('tally','o'+i,{n:n+1}); await put('me','pick',{i:i}); render(); }; el.append(b); });
  document.getElementById('tot').textContent=total+' vote'+(total===1?'':'s'); }
render();
</script></body></html>` };

const list = () => Object.entries(T).map(([key, t]) => ({ key, type: t.type, title: t.title, description: t.description }));
const get = (key) => T[key] || null;

module.exports = { TYPES, list, get };
