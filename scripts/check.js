// Run with: npx electron scripts/check.js   (headless smoke test against a mock Anthropic API)
const { app } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'gc-check-')));
app.setAppLogsPath(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-logs-')));
const store = require('../src/main/store');
const agent = require('../src/main/agent');
const mcp = require('../src/main/mcp');
const skills = require('../src/main/skills');
const git = require('../src/main/git');
const importer = require('../src/main/importer');
const features = require('../src/main/features');
const term = require('../src/main/terminal');
const tools = require('../src/main/tools');
const auth = require('../src/main/auth');
const models = require('../src/main/models');
const providers = require('../src/main/providers');
const modHost = require('../src/main/mods/host');
const memory = require('../src/main/memory');
const designsystems = require('../src/main/designsystems');
const agents = require('../src/main/agents');
const plugins = require('../src/main/plugins');
const extensions = require('../src/main/extensions');
const dataops = require('../src/main/dataops');
const logger = require('../src/main/logger');
const { cleanSettings } = require('../src/main/validate');
const savings = require('../src/main/savings');

const sse = (res, evs) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const e of evs) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); res.end(); };
const toolTurn = (name, input) => [
  { type: 'message_start', message: { usage: { input_tokens: 10 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Working…' } },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't' + Math.random(), name } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }];
const textTurn = (t) => [
  { type: 'message_start', message: { usage: { input_tokens: 20 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }];
let script = []; let seenTools = []; let router = null;
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
    const body = JSON.parse(b); seenTools.push((body.tools || []).map((t) => t.name));
    const next = router ? router(body) : script.shift();
    sse(res, typeof next === 'function' ? next(body) : next || textTurn('done'));
  });
});
let failed = 0;
const assert = (c, m) => { if (!c) { failed++; console.error('FAIL', m); return; } console.log('ok  ', m); };
const lastResult = (c) => c.messages.at(-1).content[0];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gc-w-'));

app.whenReady().then(() => srv.listen(0, async () => {
  store.saveSettings({ apiKey: 'k', baseUrl: `http://127.0.0.1:${srv.address().port}` });
  assert(store.getSettings().hasKey && store.getSettings({ reveal: true }).apiKey === 'k', 'api key roundtrip (encrypted)');

  // bypass mode: tool loop + usage
  const w = tmp();
  let c = store.newConversation({ mode: 'code', cwd: w, permissionMode: 'bypassPermissions' });
  script = [toolTurn('bash', { command: 'echo hello' }), (body) => textTurn('got:' + body.messages.at(-1).content[0].content.trim())];
  let evs = []; await agent.send(c.id, 'say hello', (e) => evs.push(e));
  c = store.getConversation(c.id);
  assert(c.messages.at(-1).content[0].text === 'got:hello', 'bypass: tool ran and result fed back');
  assert(c.usage.in === 30 && c.usage.out === 12 && store.getUsage().total.in === 30, 'usage tracked per conversation and globally');
  assert(store.searchConversations('hello').length === 1, 'search finds conversation');

  // default mode: ask -> deny
  c = store.newConversation({ mode: 'code', cwd: w });
  script = [toolTurn('write_file', { path: 'a.txt', content: 'x' })];
  evs = []; await agent.send(c.id, 'x', (e) => { evs.push(e); if (e.type === 'approval') agent.answer(e.approvalId, 'deny'); });
  assert(!fs.existsSync(path.join(w, 'a.txt')) && JSON.stringify(store.getConversation(c.id).messages).includes('denied'), 'default: denied write does not run');

  // default mode: allow for session persists
  script = [toolTurn('write_file', { path: 'b.txt', content: 'x' }), toolTurn('write_file', { path: 'c.txt', content: 'y' })];
  let asks = 0; await agent.send(c.id, 'y', (e) => { if (e.type === 'approval') { asks++; agent.answer(e.approvalId, 'session'); } });
  assert(asks === 1 && fs.existsSync(path.join(w, 'b.txt')) && fs.existsSync(path.join(w, 'c.txt')), 'allow-for-session asks only once');

  // acceptEdits: edits auto, bash asks
  c = store.newConversation({ mode: 'code', cwd: w, permissionMode: 'acceptEdits' });
  script = [toolTurn('write_file', { path: 'd.txt', content: 'z' }), toolTurn('bash', { command: 'echo no' })];
  asks = 0; await agent.send(c.id, 'z', (e) => { if (e.type === 'approval') { asks++; agent.answer(e.approvalId, 'deny'); } });
  assert(fs.existsSync(path.join(w, 'd.txt')) && asks === 1, 'acceptEdits: edit auto-approved, bash still asks');

  // plan mode: only read tools offered; write denied; exit_plan_mode approves -> acceptEdits
  c = store.newConversation({ mode: 'code', cwd: w, permissionMode: 'plan' });
  seenTools = []; script = [toolTurn('write_file', { path: 'e.txt', content: 'q' }), toolTurn('exit_plan_mode', { plan: '1. do it' })];
  evs = []; await agent.send(c.id, 'plan it', (e) => { evs.push(e); if (e.type === 'approval' && e.plan) agent.answer(e.approvalId, 'approve'); });
  assert(!seenTools[0].includes('write_file') && seenTools[0].includes('exit_plan_mode'), 'plan: only read tools + exit_plan_mode offered');
  assert(!fs.existsSync(path.join(w, 'e.txt')), 'plan: write refused');
  assert(evs.some((e) => e.type === 'mode' && e.permissionMode === 'acceptEdits') && store.getConversation(c.id).permissionMode === 'acceptEdits', 'plan approval switches to acceptEdits');

  // archive / reopen
  const cc = store.getConversation(c.id); cc.archived = true; cc.closedAt = Date.now(); store.saveConversation(cc);
  assert(!store.listConversations().some((m) => m.id === c.id) && store.lastClosed().id === c.id, 'closed session hidden, lastClosed finds it');

  // git
  execSync('git init -q && git config user.email a@b.c && git config user.name t && git add -A && git commit -qm i', { cwd: w });
  fs.writeFileSync(path.join(w, 'b.txt'), 'changed');
  const st = await git.status(w); const df = await git.diff(w, 'b.txt');
  assert(st.branch && st.files.some((f) => f.path === 'b.txt'), 'git status lists changed file');
  assert(/^\+changed/m.test(df) || df.includes('+changed'), 'git diff returns hunk');

  // projects: instructions reach the system prompt
  const proj = store.saveProject({ name: 'Docs', instructions: 'Always answer in haiku.' });
  c = store.newConversation({ mode: 'chat', projectId: proj.id });
  let sysSeen = ''; script = [(body) => { sysSeen = body.system.map((b) => b.text).join('\n'); return textTurn('ok'); }];
  await agent.send(c.id, 'hi', () => {});
  assert(/Always answer in haiku/.test(sysSeen) && store.listProjects()[0].chats === 1, 'project instructions applied; chat counted');
  store.deleteProject(proj.id);
  assert(store.getConversation(c.id).projectId === null, 'deleting a project detaches its chats');

  // scheduled tasks: next-run math, due task runs unattended and records status
  const mon = new Date(2026, 9, 23, 18, 0).getTime(); // Fri 18:00
  assert(new Date(features.computeNext({ every: 'weekdays', time: '09:00' }, mon)).getDay() === 1, 'weekday schedule skips the weekend');
  assert(features.computeNext({ every: 'interval', minutes: 30 }, mon) === mon + 1800000, 'interval schedule');
  const evsS = []; features.init({ emit: (e) => evsS.push(e), broadcast: () => {} });
  const sched = features.saveSchedule({ name: 'Brief', prompt: 'summarise', mode: 'chat', every: 'interval', minutes: 60 });
  script = [textTurn('summary text')];
  await features.runSchedule(sched.id); await new Promise((r) => setTimeout(r, 400));
  const ran = features.listSchedules()[0];
  assert(ran.lastStatus === 'ok' && store.getConversation(ran.lastConvId).title === '⏰ Brief' && ran.nextRun > Date.now(), 'schedule runs, titles the chat, records status');

  // dispatch: unattended code session auto-denies approvals, records status
  script = [toolTurn('bash', { command: 'echo nope > dispatched.txt' }), textTurn('could not')];
  const task = features.startDispatch({ prompt: 'make a file', cwd: w, permissionMode: 'acceptEdits' });
  await new Promise((r) => setTimeout(r, 600));
  assert(features.listDispatch()[0].status === 'done' && !fs.existsSync(path.join(w, 'dispatched.txt')) && JSON.stringify(store.getConversation(task.convId).messages).includes('denied'), 'dispatch: runs in background, unapproved tool denied');

  // artifacts: html fence + write_file become artifacts
  c = store.newConversation({ mode: 'code', cwd: w });
  c.messages = [{ role: 'assistant', content: [{ type: 'text', text: 'Here:\n```html\n<h1>Hi</h1>\n```' }, { type: 'tool_use', id: 'a', name: 'write_file', input: { path: 'x/app.py', content: 'print(1)\n' } }] }];
  store.saveConversation(c);
  const arts = features.listArtifacts().filter((a) => a.convId === c.id);
  assert(arts.length === 2 && arts.some((a) => a.preview && a.lang === 'html') && arts.some((a) => a.name === 'app.py' && a.lang === 'python'), 'artifacts extracted from fences and written files');
  features.stop();

  // CLI importer
  const cfg = tmp(); const pd = path.join(cfg, 'projects', '-tmp-proj'); fs.mkdirSync(pd, { recursive: true });
  const rec = (o) => JSON.stringify(o);
  fs.writeFileSync(path.join(pd, 's1.jsonl'), [
    rec({ type: 'user', cwd: '/tmp/proj', message: { role: 'user', content: 'list files please' } }),
    rec({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Sure' }] } }),
    rec({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'bash', input: { command: 'ls' } }, { type: 'tool_use', id: 'orphan', name: 'bash', input: {} }] } }),
    rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'a b' }] } }),
    rec({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] } })].join('\n'));
  const r1 = importer.importAll(cfg); const r2 = importer.importAll(cfg);
  const imp = store.getConversation('cli-s1');
  assert(r1.imported === 1 && r2.imported === 0 && imp.cwd === '/tmp/proj' && imp.title === 'list files please', 'CLI import creates session once, with cwd + title');
  assert(!JSON.stringify(imp.messages).includes('orphan') && !JSON.stringify(imp.messages).includes('thinking'), 'import drops thinking blocks and orphan tool calls');

  // skills
  const d = tmp(); fs.writeFileSync(path.join(d, 'SKILL.md'), '---\nname: demo\ndescription: A demo\n---\nBody');
  skills.importBundle(d);
  assert(skills.list()[0].name === 'demo' && skills.read('demo') === 'Body', 'skill import/read');

  // MCP
  const mock = path.join(os.tmpdir(), 'mock-mcp.js');
  fs.writeFileSync(mock, `const rl=require('readline').createInterface({input:process.stdin});rl.on('line',l=>{const m=JSON.parse(l);if(m.id==null)return;const r=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'m',version:'1'}}:m.method==='tools/list'?{tools:[{name:'ping',description:'p',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'pong'}]};console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:r}))})`);
  mcp.writeConfig({ mcpServers: { m: { command: process.execPath, args: [mock], env: { ELECTRON_RUN_AS_NODE: '1' } } } });
  await mcp.startAll();
  assert(mcp.toolDefs()[0]?.name === 'mcp__m__ping' && (await mcp.callTool('mcp__m__ping', {})) === 'pong', 'MCP tools listed and callable');

  // real pty terminal: interactive shell sees a tty, echoes input, resizes, exits
  assert(term.available(), 'node-pty loads');
  let tdata = ''; let texit = null;
  term.open('t1', w, (m) => { if (m.type === 'data') tdata += m.data; else if (m.type === 'exit') texit = m.code; }, { cols: 90, rows: 30 });
  const until = async (f, ms = 15000) => { for (let t = 0; t < ms && !f(); t += 100) await new Promise((r) => setTimeout(r, 100)); };
  await until(() => /[%$#] ?$/.test(tdata.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').trimEnd() + ' ') && tdata.length > 5); // wait for the first prompt
  term.input('t1', 'test -t 0 && echo TTY_$((6*7)); stty size\r');
  await until(() => /30 90/.test(tdata)); term.resize('t1', 100, 40);
  assert(tdata.includes('TTY_42') && /30 90/.test(tdata), 'pty: shell has a tty and the initial size');
  term.input('t1', 'exit\r'); await until(() => texit !== null);
  assert(texit === 0, 'pty: exit event delivered');
  term.killAll();

  // git worktrees: new branch in a sibling dir; removal refuses to discard changes
  const repo = tmp(); execSync('git init -q && git config user.email a@b.c && git config user.name t && echo a > a.txt && git add . && git commit -qm init', { cwd: repo });
  const wt = await git.worktreeAdd(repo, 'My Task');
  assert(wt.path && /^grizzy\/my-task-/.test(wt.branch) && fs.existsSync(path.join(wt.path, 'a.txt')), 'worktree created on its own branch');
  assert((await git.worktreeList(repo)).length === 2 && (await git.status(wt.path)).branch === wt.branch, 'worktree listed; status reports the branch');
  fs.writeFileSync(path.join(wt.path, 'b.txt'), 'x');
  assert(!(await git.worktreeRemove(wt)).removed && fs.existsSync(wt.path), 'worktree with changes is kept');
  fs.unlinkSync(path.join(wt.path, 'b.txt'));
  assert((await git.worktreeRemove(wt)).removed && !fs.existsSync(wt.path), 'clean worktree is removed');
  assert((await git.worktreeAdd(tmp(), 'x')).error, 'worktree on non-repo reports an error');

  // SSH tools: stub `ssh` on PATH that runs the remote command locally (last argument, after options)
  const bin = tmp(); fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\nwhile [ "$1" = "-o" ]; do shift 2; done\nshift\nexec /bin/sh -c "$1"\n', { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = bin + ':' + oldPath;
  const rem = tmp(); const ssh = { host: 'fake' };
  await tools.run('write_file', { path: "sub/it's.txt", content: 'one\ntwo\nthree\n' }, rem, undefined, ssh);
  assert(fs.readFileSync(path.join(rem, "sub/it's.txt"), 'utf8') === 'one\ntwo\nthree\n', 'ssh: write_file over the wire (quoting safe)');
  assert((await tools.run('read_file', { path: "sub/it's.txt", offset: 2, limit: 1 }, rem, undefined, ssh)).trim() === '2\ttwo', 'ssh: read_file offset/limit');
  await tools.run('edit_file', { path: "sub/it's.txt", old_string: 'two', new_string: 'TWO' }, rem, undefined, ssh);
  assert(fs.readFileSync(path.join(rem, "sub/it's.txt"), 'utf8').includes('TWO'), 'ssh: edit_file');
  assert((await tools.run('bash', { command: 'pwd; echo hi' }, rem, undefined, ssh)).includes('hi') && (await tools.run('list_dir', { path: '.' }, rem, undefined, ssh)).includes('sub/'), 'ssh: bash and list_dir run in the remote cwd');
  assert((await tools.run('grep', { pattern: 'TWO', path: '.' }, rem, undefined, ssh)).includes('TWO'), 'ssh: grep');
  process.env.PATH = oldPath;

  // bundled skills are seeded once and not restored after removal
  skills.seedBundled();
  const ids = skills.list().map((x) => x.id);
  assert(['docx', 'pdf', 'pptx', 'xlsx', 'frontend-design'].every((x) => ids.includes(x)), 'bundled skills seeded');
  skills.remove('pdf'); skills.seedBundled();
  assert(!skills.list().some((x) => x.id === 'pdf'), 'removed bundled skill stays removed');

  // artifact libraries resolve from node_modules
  assert(['chart.js/dist/chart.umd.js', 'mermaid/dist/mermaid.min.js', 'gridjs/dist/gridjs.umd.js', 'gridjs/dist/theme/mermaid.min.css'].every((m) => fs.existsSync(path.join(__dirname, '..', 'node_modules', m))), 'artifact libs resolvable');

  // browser sign-in (OpenRouter OAuth + PKCE) against a fake OpenRouter
  const crypto = require('crypto');
  let seenExchange = null;
  const orSrv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
      if (req.url === '/api/v1/auth/keys') { seenExchange = JSON.parse(b); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(seenExchange.code === 'good-code' ? { key: 'sk-or-test-123' } : { error: { message: 'bad code' } })); }
      else if (req.url === '/api/v1/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'openai/gpt-x' }, { id: 'anthropic/claude-a-4' }, { id: 'anthropic/claude-b-5' }, { id: 'anthropic/claude-c-9:batch' }] })); }
      else { res.statusCode = 404; res.end(); }
    });
  });
  await new Promise((r) => orSrv.listen(0, r));
  const orBase = `http://127.0.0.1:${orSrv.address().port}`;
  let authUrl = null;
  const flow = auth.signInOpenRouter({ base: orBase, open: (u) => { authUrl = new URL(u); } });
  await new Promise((r) => setTimeout(r, 300));
  const cbUrl = new URL(authUrl.searchParams.get('callback_url'));
  assert(authUrl.pathname === '/auth' && authUrl.searchParams.get('code_challenge_method') === 'S256' && cbUrl.hostname === 'localhost', 'oauth: auth URL has PKCE S256 and a localhost callback');
  const bad = await fetch(`http://127.0.0.1:${cbUrl.port}/callback?code=good-code&state=wrong`);
  assert(bad.status === 400 && !seenExchange, 'oauth: callback with the wrong state is rejected before any exchange');
  const okc = await fetch(`http://127.0.0.1:${cbUrl.port}/callback?code=good-code&state=${authUrl.searchParams.get('state')}`);
  const fr = await flow;
  assert(okc.status === 200 && fr.ok, 'oauth: valid callback completes sign-in');
  const expectChallenge = crypto.createHash('sha256').update(seenExchange.code_verifier).digest('base64url');
  assert(expectChallenge === authUrl.searchParams.get('code_challenge'), 'oauth: code_verifier matches the S256 challenge');
  const after = store.getSettings({ reveal: true });
  assert(after.keys.openrouter === 'sk-or-test-123' && after.account.method === 'openrouter' && after.apiKey === 'k', 'oauth: OpenRouter key stored (encrypted) without replacing the existing default endpoint');
  assert(after.model === 'openrouter:anthropic/claude-b-5', 'oauth: default model switches to the newest live Claude model on OpenRouter');
  assert(auth.status().signedIn && auth.signOut().hasKey === false && store.getSettings().account === null, 'sign out clears the key and account');
  const fl2 = auth.signInOpenRouter({ base: orBase, open: () => {}, timeoutMs: 200 });
  assert((await fl2).error.includes('timed out'), 'oauth: times out when the browser never returns');
  const fl3 = auth.signInOpenRouter({ base: orBase, open: () => {} }); await new Promise((r) => setTimeout(r, 100)); auth.cancel();
  assert((await fl3).error === 'Cancelled', 'oauth: cancel ends the flow');
  orSrv.close();
  const { clipboard } = require('electron');
  await clipboard.writeText('hello'); assert(!(await auth.peekAnthropicKey()).found && !(await auth.useAnthropicKey()).ok, 'anthropic: non-key clipboard is ignored');
  await clipboard.writeText('sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV_wxyz'); const pk = await auth.peekAnthropicKey();
  const used = await auth.useAnthropicKey();
  assert(pk.found && !JSON.stringify(pk).includes('ABCDEFGH') && used.ok && store.getSettings({ reveal: true }).apiKey.startsWith('sk-ant-') && store.getSettings().provider === 'anthropic' && (await clipboard.readText()) === '', 'anthropic: copied key detected (masked), saved, clipboard cleared');
  auth.signOut();

  // connector management: add/edit/rename/disable/remove, test, import, remote HTTP server, error reporting
  const stdioDef = { command: process.execPath, args: [mock], env: { ELECTRON_RUN_AS_NODE: '1' } };
  let r = await mcp.saveServer({ name: 'bad name!', def: stdioDef }); assert(r.error && /Name must/.test(r.error), 'connector: invalid name rejected');
  r = await mcp.saveServer({ name: 'x', def: { command: '' } }); assert(/command/i.test(r.error), 'connector: missing command rejected');
  r = await mcp.saveServer({ name: 'local', def: stdioDef });
  assert(r.ok && r.servers.find((x) => x.name === 'local').status === 'running' && r.servers.find((x) => x.name === 'local').tools[0].name === 'ping', 'connector: add local server starts it and lists tools');
  r = await mcp.saveServer({ name: 'local2', def: stdioDef, oldName: 'local' });
  assert(r.ok && !r.servers.some((x) => x.name === 'local') && r.servers.find((x) => x.name === 'local2').status === 'running' && (await mcp.callTool('mcp__local2__ping', {})) === 'pong', 'connector: rename restarts under the new name');
  assert((await mcp.saveServer({ name: 'm', def: stdioDef, oldName: 'local2' })).error?.includes('already exists'), 'connector: renaming onto an existing name is refused');
  let list = await mcp.setDisabled('local2', true);
  assert(list.find((x) => x.name === 'local2').status === 'disabled' && !mcp.toolDefs().some((t) => t.name.startsWith('mcp__local2__')), 'connector: disable stops it and removes its tools');
  r = await mcp.saveServer({ name: 'local2', def: { ...stdioDef, args: [mock] }, oldName: 'local2' });
  assert(r.servers.find((x) => x.name === 'local2').disabled === true, 'connector: editing keeps the disabled flag');
  list = await mcp.setDisabled('local2', false); assert(list.find((x) => x.name === 'local2').status === 'running', 'connector: enable starts it');
  list = await mcp.restartServer('local2'); assert(list.find((x) => x.name === 'local2').status === 'running', 'connector: restart');
  const t1 = await mcp.testServer(stdioDef); assert(t1.ok && t1.tools.length === 1 && !mcp.list().some((x) => x.name === 'test'), 'connector: test lists tools without saving');
  const t2 = await mcp.testServer({ command: '/nonexistent/cmd' }); assert(!t2.ok && /not found/i.test(t2.error), 'connector: missing command reports a clear error');
  const crash = path.join(os.tmpdir(), 'crash-mcp.js'); fs.writeFileSync(crash, "console.error('boom: missing API_KEY'); process.exit(3)");
  const t3 = await mcp.testServer({ command: process.execPath, args: [crash], env: { ELECTRON_RUN_AS_NODE: '1' } }); assert(!t3.ok && /boom/.test(t3.stderr), 'connector: a crashing server shows its stderr');
  // remote Streamable-HTTP server (JSON reply for most calls, SSE for tools/list); requires a session id + auth header
  let httpSeen = [];
  const hsrv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
      if (req.headers.authorization !== 'Bearer s3cret') { res.statusCode = 401; return res.end('no'); }
      const m = b ? JSON.parse(b) : {}; httpSeen.push([m.method, req.headers['mcp-session-id']]);
      if (req.method === 'DELETE') return res.end();
      if (m.id == null) { res.statusCode = 202; return res.end(); }
      const result = m.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'h', version: '1' } } : m.method === 'tools/list' ? { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }] } : { content: [{ type: 'text', text: 'echo:' + JSON.stringify(m.params.arguments) }] };
      if (m.method === 'initialize') res.setHeader('mcp-session-id', 'sess-1');
      if (m.method === 'tools/list') { res.setHeader('content-type', 'text/event-stream'); return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result })}\n\n`); }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
    });
  });
  await new Promise((r2) => hsrv.listen(0, r2));
  const hurl = `http://127.0.0.1:${hsrv.address().port}/mcp`;
  const noAuth = await mcp.testServer({ url: hurl }); assert(!noAuth.ok && /Not authorized/.test(noAuth.error), 'connector: remote 401 explained');
  r = await mcp.saveServer({ name: 'remote', def: { url: hurl, headers: { Authorization: 'Bearer s3cret' } } });
  assert(r.servers.find((x) => x.name === 'remote').status === 'running' && r.servers.find((x) => x.name === 'remote').type === 'http', 'connector: remote server connects (JSON + SSE replies)');
  assert((await mcp.callTool('mcp__remote__echo', { a: 1 })) === 'echo:{"a":1}' && httpSeen.some(([mth, sid]) => mth === 'tools/call' && sid === 'sess-1'), 'connector: remote tool call carries the session id');
  // import
  const impr = await mcp.importJson(JSON.stringify({ mcpServers: { imp1: stdioDef, remote: { url: hurl } } }));
  assert(impr.added.join() === 'imp1' && impr.skipped.join() === 'remote', 'connector: import adds new and skips existing by default');
  assert((await mcp.importJson(JSON.stringify({ command: 'x' }))).error.includes('name'), 'connector: single-server import asks for a name');
  assert((await mcp.importJson(JSON.stringify(stdioDef), { name: 'single' })).added.join() === 'single', 'connector: single-server import with a name');
  assert((await mcp.importJson('{nope')).error.includes('valid JSON') && (await mcp.importJson('{"a":1}')).error.includes('Expected'), 'connector: bad import text explained');
  list = await mcp.removeServer('imp1'); assert(!list.some((x) => x.name === 'imp1') && !mcp.readConfig().mcpServers.imp1, 'connector: remove deletes config and stops it');
  assert((await mcp.warmShellPath()).includes('/') && mcp.fullPath().includes('/usr/bin'), 'connector: login-shell PATH resolved for npx/uvx');
  hsrv.close();

  // OpenRouter API key
  const orKeySrv = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); if (req.url === '/api/v1/key') { if (req.headers.authorization === 'Bearer sk-or-v1-goodkey1234567890') res.end('{"data":{}}'); else { res.statusCode = 401; res.end('{}'); } } else if (req.url === '/api/v1/models') res.end(JSON.stringify({ data: [{ id: 'anthropic/claude-z-1' }, { id: 'meta/llama' }] })); else { res.statusCode = 404; res.end(); } });
  await new Promise((r2) => orKeySrv.listen(0, r2));
  const kb = `http://127.0.0.1:${orKeySrv.address().port}`;
  assert((await auth.saveOpenRouterKey('hello', kb)).error.includes('sk-or-'), 'openrouter key: wrong format rejected');
  assert((await auth.saveOpenRouterKey('sk-or-v1-wrongkey123456789', kb)).error.includes('rejected') && !store.getSettings().hasKey, 'openrouter key: rejected key is not saved');
  assert((await auth.saveOpenRouterKey('sk-or-v1-goodkey1234567890', kb)).ok, 'openrouter key: valid key accepted');
  const ks = store.getSettings({ reveal: true });
  assert(ks.apiKey === 'sk-or-v1-goodkey1234567890' && ks.provider === 'openai' && ks.baseUrl === kb + '/api/v1' && ks.account.method === 'openrouter-key' && ks.model === 'openrouter:anthropic/claude-z-1' && ks.models.join() === 'anthropic/claude-z-1', 'openrouter key: becomes the default endpoint when none exists, with live Claude models');
  auth.signOut(); orKeySrv.close();

  // multi-provider model routing + catalog
  store.saveSettings({ provider: 'anthropic', baseUrl: '', apiKey: 'sk-ant-main', model: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5'], keys: { openrouter: 'sk-or-v1-routekey' } });
  let rs = store.getSettings({ reveal: true });
  assert(models.canon(rs, 'claude-haiku-5-5') === 'anthropic:claude-haiku-5-5' && models.canon(rs, 'openrouter:a/b') === 'openrouter:a/b', 'models: bare ids follow the default provider');
  let rt = models.route(rs, 'claude-haiku-5-5'); assert(rt.provider === 'anthropic' && rt.apiKey === 'sk-ant-main' && rt.model === 'claude-haiku-5-5' && rt.baseUrl === '', 'route: bare id → default Anthropic key');
  rt = models.route(rs, 'openrouter:meta/llama-3:free'); assert(rt.provider === 'openai' && rt.baseUrl === 'https://openrouter.ai/api/v1' && rt.apiKey === 'sk-or-v1-routekey' && rt.model === 'meta/llama-3:free', 'route: openrouter:<id> → OpenRouter key and base URL (ids with ":" kept)');
  let threw = ''; try { models.route({ ...rs, keys: { anthropic: 'sk-ant-main' } }, 'openrouter:x/y'); } catch (e) { threw = e.message; } assert(/No OpenRouter key/.test(threw), 'route: a provider without a key gives a clear error');
  store.saveSettings({ provider: 'openai', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'llama3', models: ['llama3', 'qwen'], keys: { anthropic: '' } });
  rs = store.getSettings({ reveal: true }); assert(models.route(rs, 'llama3').model === 'llama3' && models.canon(rs, 'llama3') === 'llama3', 'route: custom endpoint keeps bare ids');
  const cat = await models.catalog({ force: true });
  assert(cat.groups.some((g) => g.id === 'openrouter' && Array.isArray(g.models)) && cat.groups.some((g) => g.id === 'custom' && g.models.length === 2), 'catalog: OpenRouter + custom groups listed for connected providers');
  store.saveSettings({ provider: 'anthropic', baseUrl: '', apiKey: 'sk-ant-bad', keys: { openrouter: '' } });
  const cat2 = await models.catalog({ force: true }); const ag = cat2.groups.find((g) => g.id === 'anthropic');
  assert(ag && ag.models.some((m) => m.id === 'claude-sonnet-5-5') && cat2.groups.find((g) => g.id === 'openrouter')?.note, 'catalog: Anthropic falls back to known models when the live list fails; a provider without a key is listed with a note');
  assert(auth.removeProvider('anthropic').providerKeys.anthropic === false && !store.getSettings().hasKey, 'removing a provider also clears the default key when it is that provider');

  // token usage: cache fields, context size, prompt-cache breakpoints, per-model/mode/day records, cost
  const llm = require('../src/main/llm');
  const wc = llm.withCache('SYS', [{ role: 'user', content: 'hi' }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] }]);
  assert(wc.system[0].cache_control && wc.messages[1].content[0].cache_control && !wc.messages[0].content.cache_control, 'cache: system + newest message carry breakpoints; older messages untouched');
  const orig = [{ role: 'user', content: 'hello' }]; llm.withCache('S', orig); assert(orig[0].content === 'hello', 'cache: stored messages are never mutated');
  store.saveSettings({ provider: 'anthropic', baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: 'k', model: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5'] });
  const uBefore = store.getUsage();
  let seenBody = null;
  const cacheTurn = (body) => { seenBody = body; return [
    { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } }]; };
  c = store.newConversation({ mode: 'chat' }); script = [cacheTurn]; await agent.send(c.id, 'count my tokens', () => {});
  c = store.getConversation(c.id);
  assert(c.usage.in === 100 && c.usage.out === 20 && c.usage.cr === 900 && c.usage.cw === 50, 'usage: input, output, cache read and cache write tracked per session');
  assert(c.ctx.used === 1050 && c.ctx.max === 200000 && c.ctx.model === 'claude-sonnet-5-5', 'usage: context size = input + cache read + cache write, with the model’s window');
  assert(Array.isArray(seenBody.system) && seenBody.system[0].cache_control && seenBody.messages.at(-1).content.at(-1).cache_control, 'cache: request sent to Anthropic carries cache_control');
  const uAfter = store.getUsage();
  assert(uAfter.total.cr - uBefore.total.cr === 900 && uAfter.requests === uBefore.requests + 1 && uAfter.sessions.includes(c.id) && uAfter.models['claude-sonnet-5-5'].n >= 1 && uAfter.modes.chat.out - uBefore.modes.chat.out === 20 && uAfter.days[new Date().toISOString().slice(0, 10)].cr >= 900, 'usage: recorded by day, model, tab and session');
  store.addUsage({ in: 1000, out: 500, cr: 0, cw: 0 }, { model: 'openrouter:p/m', mode: 'code', conv: 'zz', price: { in: 1e-6, out: 2e-6 } });
  const uc = store.getUsage(); assert(Math.abs(uc.models['openrouter:p/m'].cost - 0.002) < 1e-9 && Math.abs(uc.cost - uAfter.cost - 0.002) < 1e-9 && uc.modes.code.in >= 1000, 'usage: estimated cost from provider-reported per-token prices');
  store.clearUsage(); assert(store.getUsage().requests === 0 && store.getUsage().total.in === 0, 'usage: reset clears everything');
  // OpenAI-compatible usage: prompt_tokens includes cached + cache-write tokens
  const oaSrv = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hey' } }] }) + '\n\n'); res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 } } }) + '\n\n'); res.end('data: [DONE]\n\n'); }); });
  await new Promise((r2) => oaSrv.listen(0, r2));
  const oa = await llm.stream({ provider: 'openai', baseUrl: `http://127.0.0.1:${oaSrv.address().port}`, apiKey: 'k', model: 'm', maxTokens: 50 }, { system: 's', messages: [{ role: 'user', content: 'x' }], tools: [] }, () => {});
  assert(oa.usage.in === 300 && oa.usage.cr === 600 && oa.usage.cw === 100 && oa.usage.out === 40, 'usage: OpenAI-compatible cached / cache-write tokens split out of prompt_tokens'); oaSrv.close();
  assert(models.contextWindow({ ...store.getSettings({ reveal: true }) }, 'claude-opus-5-5') === 200000 && models.contextWindow(store.getSettings({ reveal: true }), 'llama3') === 0, 'models: Claude window guessed when the provider does not report one; unknown models report none');

  // ===== settings pages: memory, design systems, capabilities, plugins, extensions, privacy, validation =====
  store.saveSettings({ provider: 'anthropic', baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: 'k', model: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5'], keys: { anthropic: '', openrouter: '' } });
  // validation
  let cv = cleanSettings({ maxSteps: 999, termFontSize: 2, retentionDays: 45, branchPrefix: '../x', font: 'comic', worktreeDir: '/no/such/dir', shellPath: '/etc', displayName: 'x'.repeat(100) });
  assert(cv.out.maxSteps === 200 && cv.out.termFontSize === 9 && cv.out.displayName.length === 60 && cv.bad.join() === 'retentionDays,branchPrefix,font,worktreeDir,shellPath', 'validate: out-of-range values clamped, invalid ones rejected');
  cv = cleanSettings({ branchPrefix: 'feature', shellPath: '/bin/zsh', worktreeDir: os.tmpdir(), retentionDays: 30, font: 'serif' });
  assert(cv.out.branchPrefix === 'feature/' && cv.out.shellPath === '/bin/zsh' && cv.out.retentionDays === 30 && !cv.bad.length, 'validate: good values accepted, branch prefix gets a slash');
  // memory
  memory.clear(); const m1 = memory.add('Prefers metric units'); assert(m1.ok && memory.add('prefers METRIC units').duplicate && memory.list().length === 1, 'memory: add and de-duplicate');
  assert(memory.update(m1.memory.id, 'Prefers metric units and tea').ok && memory.update('nope', 'x').error && memory.add('   ').error, 'memory: edit, missing id and empty text rejected');
  assert(memory.promptBlock({ memoryEnabled: true }).includes('tea') && memory.promptBlock({ memoryEnabled: false }) === '', 'memory: prompt block only when enabled');
  // design systems
  const ag0 = agents.list(); assert(ag0.length >= 5 && ag0.every((a) => a.enabled) && ag0.some((a) => a.id === 'reviewer' && a.builtin), 'agents: built-ins are listed and enabled');
  const agr = agents.save({ name: 'Auditor', instructions: 'Audit security.', permissionMode: 'bogus' });
  const cust = agr.agents.find((a) => a.name === 'Auditor'); assert(agr.ok && cust && !cust.builtin && cust.permissionMode === '' && agents.save({ name: ' ' }).error, 'agents: custom agent saved, bad mode dropped, name required');
  assert(agents.promptBlock(cust.id).includes('Audit security.') && agents.promptBlock('general') === '', 'agents: instructions reach the system prompt; empty ones add nothing');
  agents.save({ id: 'writer', name: 'Writer', instructions: 'Be terse.', enabled: false }); assert(agents.get('writer').modified && agents.promptBlock('writer') === '', 'agents: built-in override applies and a disabled agent adds nothing');
  assert(!agents.remove('writer').find((a) => a.id === 'writer').modified && !agents.remove(cust.id).some((a) => a.id === cust.id), 'agents: reset restores a built-in, delete drops a custom agent');
  const ds = designsystems.save({ name: 'Acme', guidelines: 'Rounded cards.', tokens: { colors: { brand: '#d97757', bad: 'red', 'x y': '#fff' }, fonts: { body: 'Inter' }, radius: '12px' } });
  assert(ds.ok && Object.keys(ds.system.tokens.colors).join() === 'brand' && designsystems.save({ name: ' ' }).error, 'design systems: tokens sanitised, name required');
  store.saveSettings({ defaultDesignSystem: ds.system.id }); const dp = designsystems.promptBlock(store.getSettings());
  assert(/Acme/.test(dp) && /brand #d97757/.test(dp) && /Rounded cards/.test(dp), 'design systems: default one reaches the prompt');
  assert(designsystems.parseImport('{"name":"J","colors":{"a":"#fff"}}', 'f').tokens.colors.a === '#fff' && designsystems.parseImport('# Guide\ntext', 'g').guidelines.startsWith('# Guide'), 'design systems: import JSON and markdown');
  // capability gating
  const names = (caps, mode = 'code', pm = 'default') => tools.publicDefs(mode, pm, caps).map((t) => t.name);
  assert(!names({ capShell: false }).includes('bash') && names({ capShell: false }).includes('write_file') && !names({ capEdit: false }).includes('write_file') && names({ capEdit: false }).includes('bash'), 'capabilities: shell and file-editing tools switch off independently');
  assert(!names({}).includes('web_fetch') && names({ capWeb: true }).includes('web_fetch') && names({ capWeb: true }, 'chat').includes('web_fetch') && !names({ capWeb: true }, 'code', 'plan').includes('web_fetch'), 'capabilities: web fetch is opt-in, works in chat, hidden in plan mode');
  assert(names({ memoryEnabled: true, memoryAuto: true }, 'chat').includes('save_memory') && !names({ memoryEnabled: false }, 'chat').includes('save_memory') && !names({ memoryAuto: false }, 'chat').includes('save_memory'), 'capabilities: save_memory follows the memory switches');
  assert(!names({ capSkills: false }).includes('use_skill'), 'capabilities: skills tool can be turned off');
  assert(agent.decide({ permissionMode: 'bypassPermissions' }, 'bash', { allowBypass: false }) === 'ask' && agent.decide({ permissionMode: 'bypassPermissions' }, 'bash', {}) === 'allow', 'claude code: bypass mode is ignored when disallowed');
  // web_fetch safety
  const bl = async (u) => { try { await tools.run('web_fetch', { url: u }, '/tmp'); return ''; } catch (e) { return e.message; } };
  assert(/blocked/.test(await bl('http://127.0.0.1:1/')) && /blocked/.test(await bl('http://localhost/')) && /blocked/.test(await bl('http://169.254.169.254/latest/meta-data')) && /blocked/.test(await bl('http://[::1]/')) && /Only http/.test(await bl('file:///etc/passwd')) && /not a valid/.test(await bl('nope')), 'web_fetch: loopback, link-local, IPv6 and file: URLs refused');
  assert(tools.isPrivateIp('10.1.2.3') && tools.isPrivateIp('192.168.0.9') && tools.isPrivateIp('172.20.0.1') && tools.isPrivateIp('100.64.0.1') && !tools.isPrivateIp('8.8.8.8') && !tools.isPrivateIp('172.32.0.1') && tools.isPrivateIp('::ffff:10.0.0.1'), 'web_fetch: private-range detection');
  assert(tools.htmlToText('<html><style>x{}</style><script>evil()</script><h1>Hi &amp; bye</h1><p>One</p><p>Two</p></html>') === 'Hi & bye\n\nOne\n\nTwo', 'web_fetch: HTML reduced to readable text without scripts/styles');
  // agent: memory tool, prompt additions, disabled tool, step limit
  store.saveSettings({ capShell: true, capEdit: true, memoryEnabled: true, memoryAuto: true, displayName: 'Sam', preferences: 'Answer in one sentence.', maxSteps: 40 }); memory.clear();
  c = store.newConversation({ mode: 'chat' }); let sysAfter = '';
  script = [toolTurn('save_memory', { text: 'Sam likes tea' }), (body) => { sysAfter = body.system.map((b) => b.text).join('\n'); return textTurn('noted'); }];
  await agent.send(c.id, 'remember I like tea', () => {});
  assert(memory.list().some((m) => m.text === 'Sam likes tea' && m.source === 'model') && /Sam likes tea/.test(sysAfter) && /name is Sam/.test(sysAfter) && /one sentence/.test(sysAfter), 'agent: model saves a memory; memory, name and preferences reach the next prompt');
  store.saveSettings({ memoryEnabled: false }); let sysOff = '';
  c = store.newConversation({ mode: 'chat' }); script = [(body) => { sysOff = body.system.map((b) => b.text).join('\n'); return textTurn('ok'); }]; await agent.send(c.id, 'hi', () => {});
  assert(!/Sam likes tea/.test(sysOff), 'agent: memory off → nothing injected'); store.saveSettings({ memoryEnabled: true });
  store.saveSettings({ capShell: false }); const w2 = tmp();
  c = store.newConversation({ mode: 'code', cwd: w2, permissionMode: 'bypassPermissions' }); script = [toolTurn('bash', { command: 'echo hi > nope.txt' }), textTurn('done')];
  await agent.send(c.id, 'run it', () => {});
  assert(!fs.existsSync(path.join(w2, 'nope.txt')) && JSON.stringify(store.getConversation(c.id).messages).includes('not enabled'), 'agent: a disabled tool is refused even if the model asks for it');
  store.saveSettings({ capShell: true, maxSteps: 2 }); let calls = 0;
  c = store.newConversation({ mode: 'code', cwd: w2, permissionMode: 'bypassPermissions' }); script = [0, 1, 2, 3, 4].map(() => (body) => { calls++; return toolTurn('list_dir', { path: '.' }); });
  await agent.send(c.id, 'loop', () => {}); assert(calls === 2, 'claude code: max steps per message is honoured (' + calls + ')'); store.saveSettings({ maxSteps: 40 });

  // agents: delegate_agent / message_agent
  {
    const wa = tmp(); store.saveSettings({ capShell: true, capEdit: true, capAgents: true, maxSteps: 40 });
    const resultsOf = (cv) => cv.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_result').map((b) => b.content) : []));
    const toolsOf = (b) => (b.tools || []).map((x) => x.name);
    const textOf = (m) => (typeof m.content === 'string' ? m.content : m.content.filter((x) => x.type === 'text').map((x) => x.text).join(''));
    // delegate: the agent runs with its own persona, a read-only toolset when its mode is plan, and its report comes back
    let subSys = '', subTools = [], parentTools = [], subPrompts = [];
    fs.writeFileSync(path.join(wa, 'a.txt'), 'hello');
    c = store.newConversation({ mode: 'code', cwd: wa, permissionMode: 'default' });
    script = [
      (b) => { parentTools = toolsOf(b); return toolTurn('delegate_agent', { agent: 'reviewer', task: 'review the thing' }); },
      (b) => { subSys = b.system.map((x) => x.text).join('\n'); subTools = toolsOf(b); subPrompts.push(textOf(b.messages[0])); return toolTurn('write_file', { path: 'x.txt', content: 'no' }); },
      () => toolTurn('read_file', { path: 'a.txt' }),
      () => textTurn('No issues found. review report: looks fine'),
      (b) => { const r = b.messages.at(-1).content[0].content; return textTurn('parent got: ' + r); }];
    evs = []; await agent.send(c.id, 'delegate it', (e) => evs.push(e));
    c = store.getConversation(c.id); const [r1] = resultsOf(c); const aid = (/agent_[0-9a-f]{6}/.exec(r1 || '') || [])[0];
    assert(parentTools.includes('delegate_agent') && parentTools.includes('message_agent'), 'agents: the main agent is offered delegate_agent and message_agent');
    assert(/meticulous code reviewer/.test(subSys) && /delegated agent/.test(subSys) && subPrompts[0] === 'review the thing', 'agents: the delegated agent gets its own persona and the task as its only input');
    assert(!subTools.includes('write_file') && !subTools.includes('exit_plan_mode') && subTools.includes('read_file'), 'agents: a plan-mode agent has read-only tools and no exit_plan_mode');
    assert(/review report: looks fine/.test(r1) && aid && !fs.existsSync(path.join(wa, 'x.txt')), 'agents: its report returns as the delegate_agent result; its refused write changed nothing');
    assert(evs.some((e) => e.type === 'tool_call' && e.parentId && e.name === 'write_file' && e.agent === 'Reviewer') && evs.some((e) => e.type === 'tool_result' && e.parentId), 'agents: the delegated agent\'s tool calls are reported with their parent call and agent name');
    assert(subTools.includes('delegate_agent') && !tools.publicDefs('code', 'default', {}, { depth: 2, sub: true }).some((d) => d.name === 'delegate_agent') && tools.publicDefs('code', 'default', {}, { depth: 2 }).some((d) => d.name === 'message_agent'), 'agents: delegation is limited to two levels; messaging is always available');
    assert(c.usage.in >= 3 * 20 || c.usage.in > 30, 'agents: delegated agents\' tokens count toward the conversation');

    // message_agent: a follow-up continues the same agent with its history; a stranger id is an error; a busy agent is refused
    let followMsgs = null;
    script = [toolTurn('message_agent', { id: aid, message: 'also check Y' }), (b) => { followMsgs = JSON.stringify(b.messages); return textTurn('follow-up answer'); }, (b) => textTurn('relay: ' + b.messages.at(-1).content[0].content)];
    await agent.send(c.id, 'follow up', () => {}); c = store.getConversation(c.id);
    assert(/review the thing/.test(followMsgs) && /review report: looks fine/.test(followMsgs) && /Message from the main agent: also check Y/.test(followMsgs), 'agents: message_agent continues the agent with its earlier history');
    assert(/follow-up answer/.test(resultsOf(c).at(-1)), 'agents: the reply comes back as the message_agent result');
    script = [toolTurn('message_agent', { id: 'agent_nope', message: 'hi' }), textTurn('ok')]; await agent.send(c.id, 'x', () => {}); c = store.getConversation(c.id);
    assert(/^ERROR: No agent with id "agent_nope"/.test(resultsOf(c).at(-1)) && resultsOf(c).at(-1).includes(aid), 'agents: messaging an unknown id fails and lists the agents that exist');

    // restart: delegated agents are saved with the conversation and still answer after the in-memory state is gone
    assert((store.getConversation(c.id).agents || []).some((x) => x.id === aid && x.messages.length >= 4), 'agents: delegated agents are saved in the conversation file');
    agent.__test.forgetAgents(); let afterSys = '', afterMsgs = '';
    script = [(b) => { afterSys = b.system.map((x) => x.text).join('\n'); return toolTurn('message_agent', { id: aid, message: 'still there?' }); }, (b) => { afterMsgs = JSON.stringify(b.messages); return textTurn('yes, still here'); }, textTurn('end')];
    await agent.send(c.id, 'after restart', () => {}); c = store.getConversation(c.id);
    assert(new RegExp(aid + ': Reviewer').test(afterSys) && /also check Y/.test(afterMsgs) && /yes, still here/.test(resultsOf(c).at(-1)), 'agents: after a restart the agent is listed, remembers its history and answers');
    const cu = agents.save({ name: 'Temp', instructions: 'Temporary persona.' }).agents.find((x) => x.name === 'Temp');
    c = store.newConversation({ mode: 'code', cwd: wa, permissionMode: 'default' }); script = [toolTurn('delegate_agent', { agent: cu.id, task: 't' }), textTurn('temp report'), textTurn('end')];
    await agent.send(c.id, 'go', () => {}); const tid = (store.getConversation(c.id).agents || [])[0]?.id; agents.remove(cu.id); agent.__test.forgetAgents(); let tempSys = '';
    script = [toolTurn('message_agent', { id: tid, message: 'again' }), (b) => { tempSys = b.system.map((x) => x.text).join('\n'); return textTurn('temp again'); }, textTurn('end')];
    await agent.send(c.id, 'again', () => {}); assert(tid && /Temporary persona/.test(tempSys) && /temp again/.test(resultsOf(store.getConversation(c.id)).at(-1)), 'agents: an agent whose definition was deleted still works from its saved persona');

    // parallel: two delegate calls in one turn both run, each with its own task, and both reports come back in call order
    const two = (names) => [
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      ...names.flatMap((n, i) => [{ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: 'p' + i + Math.random(), name: 'delegate_agent' } }, { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(n) } }]),
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }];
    c = store.newConversation({ mode: 'code', cwd: wa, permissionMode: 'default' }); let inflight = 0, peak = 0;
    router = (b) => {
      const first = textOf(b.messages[0]);
      if (first === 'fan out') { const last = b.messages.at(-1); return Array.isArray(last.content) && last.content[0]?.type === 'tool_result' ? textTurn('merged') : two([{ agent: 'engineer', task: 'task A' }, { agent: 'Researcher', task: 'task B' }]); }
      return textTurn('report for ' + first);
    };
    await agent.send(c.id, 'fan out', () => {}); router = null; c = store.getConversation(c.id); const rs = resultsOf(c);
    assert(rs.length === 2 && /report for task A/.test(rs[0]) && /report for task B/.test(rs[1]) && /\[Engineer · agent_/.test(rs[0]) && /\[Researcher · agent_/.test(rs[1]), 'agents: several delegate_agent calls in one turn each run their own agent and return in call order');

    // permissions: a delegated agent's risky tool asks the user (naming the agent); it can never exceed the conversation's mode
    c = store.newConversation({ mode: 'code', cwd: wa, permissionMode: 'default' }); let ask = null;
    script = [toolTurn('delegate_agent', { agent: 'engineer', task: 'run it' }), toolTurn('bash', { command: 'echo hi > ran.txt' }), textTurn('could not'), textTurn('end')];
    await agent.send(c.id, 'go', (e) => { if (e.type === 'approval') { ask = e; agent.answer(e.approvalId, 'deny'); } });
    assert(ask && ask.agent === 'Engineer' && ask.name === 'bash' && !fs.existsSync(path.join(wa, 'ran.txt')), 'agents: a delegated agent\'s risky tool call asks the user, names the agent, and honours a denial');
    c = store.newConversation({ mode: 'code', cwd: wa, permissionMode: 'plan' }); let planSubTools = [];
    script = [toolTurn('delegate_agent', { agent: 'engineer', task: 'edit things' }), (b) => { planSubTools = toolsOf(b); return textTurn('read only'); }, textTurn('end')];
    await agent.send(c.id, 'go', () => {}); assert(planSubTools.length && !planSubTools.includes('write_file') && !planSubTools.includes('bash'), 'agents: in a plan-mode conversation every delegated agent is read-only, whatever its own mode');
    // real agents: each built-in has its own tools and step budget, and cannot finish until its completion gates pass
    {
      const by = (id) => agents.get(id);
      const toolSet = (id) => new Set(require('../src/main/access').keep([agents.accessOf(by(id))], tools.publicDefs('code', 'bypassPermissions', { capWeb: true })).map((d) => d.name));
      assert(!toolSet('researcher').has('bash') && !toolSet('researcher').has('write_file') && toolSet('researcher').has('web_fetch') && toolSet('writer').has('edit_file') && !toolSet('writer').has('bash') && toolSet('engineer').has('bash'), 'real agents: researcher is read-only with the web, writer edits without a shell, engineer has everything');
      assert(by('engineer').steps === 40 && by('reviewer').gates.includes('findings') && by('grizzy').gates === undefined && by('grizzy').steps === undefined && by('general').gates === undefined, 'real agents: profiles are set on the built-ins; Grizzy and the default assistant are untouched');
      assert(/Report format:/.test(agents.promptBlock('reviewer')) && /cannot finish/.test(agents.promptBlock('engineer')), 'real agents: the report contract and the gate warning reach the system prompt');
      const st = (calls, text = '', can = ['bash', 'read_file']) => ({ ...agents.gateState(can), calls: calls.map((n) => ({ name: n })), text });
      const g = (id, s2) => agents.gate(by(id), s2);
      assert(/not looked/.test(g('reviewer', st([]))) && /not verified|have not verified/.test(g('engineer', st(['read_file', 'edit_file']))) && g('engineer', st(['read_file', 'edit_file', 'bash'])) === '' && g('engineer', st(['read_file'])) === '' && g('engineer', st(['read_file', 'edit_file'], '', ['read_file'])) === '', 'real agents: engineer must run something after its last edit (unless it has no shell)');
      assert(/rank findings/.test(g('reviewer', st(['read_file'], 'looks ok'))) && g('reviewer', st(['read_file'], 'High: a.js:12 — bug')) === '' && g('reviewer', st(['read_file'], 'No issues found.')) === '', 'real agents: reviewer must rank findings with path:line or say none');
      assert(/numbered list/.test(g('planner', st(['read_file'], 'just do it'))) && g('planner', st(['read_file'], '1. a\n2. b\n3. c\nRisks: x')) === '', 'real agents: planner must produce a numbered plan with risks');
      assert(/cited no URLs/.test(g('researcher', st(['web_fetch'], 'It is so'))) && /Unverified/.test(g('researcher', st(['web_fetch'], 'See https://x.dev'))) && g('researcher', st(['web_fetch'], 'See https://x.dev\nUnverified: nothing')) === '', 'real agents: researcher must cite sources and list what is unverified');
      assert(/Re-read/.test(g('writer', st(['write_file'], 'done'))) && g('writer', st(['write_file', 'read_file'], 'done')) === '', 'real agents: writer re-reads what it wrote');
      const s3 = st([], 'x'); s3.followUp = true; assert(g('reviewer', s3) === '', 'real agents: report-format gates do not apply to a follow-up message');
      const s4 = st(['read_file'], 'nope'); assert(g('reviewer', s4) && g('reviewer', s4) && g('reviewer', s4) === '', 'real agents: an agent is sent back at most twice, then allowed to finish');

      // end to end: a delegated engineer that edits and tries to stop is sent back to verify, then reports
      fs.writeFileSync(path.join(wa, 'e.txt'), 'old');
      let sawNudge = false, engTools = [], engSteps = 0;
      c = store.newConversation({ mode: 'code', cwd: wa, permissionMode: 'bypassPermissions' });
      script = [
        toolTurn('delegate_agent', { agent: 'engineer', task: 'change e.txt' }),
        (b) => { engTools = toolsOf(b); engSteps++; return toolTurn('read_file', { path: 'e.txt' }); },
        () => toolTurn('edit_file', { path: 'e.txt', old_string: 'old', new_string: 'new' }),
        () => textTurn('Done, changed e.txt.'),
        (b) => { sawNudge = /have not verified/.test(JSON.stringify(b.messages.at(-1))); return toolTurn('bash', { command: 'cat e.txt' }); },
        () => textTurn('Changed e.txt; verified with cat: new.'),
        (b) => textTurn('parent: ' + b.messages.at(-1).content[0].content)];
      await agent.send(c.id, 'go', () => {}); c = store.getConversation(c.id);
      assert(sawNudge && engTools.includes('bash') && /verified with cat/.test(resultsOf(c).at(-1)) && fs.readFileSync(path.join(wa, 'e.txt'), 'utf8') === 'new', 'real agents: an engineer that stops after an edit is sent back to verify, then its report comes back');
    }
    assert(agent.__test.clampMode('bypassPermissions', 'default') === 'default' && agent.__test.clampMode('plan', 'bypassPermissions') === 'plan' && agent.__test.clampMode('', 'acceptEdits') === 'acceptEdits', 'agents: an agent\'s mode can only restrict, never widen, the conversation\'s mode');

    // settings: capAgents off removes the tools and the roster; unknown agent names are rejected with the list
    store.saveSettings({ capAgents: false }); let offSys = '', offTools = [];
    c = store.newConversation({ mode: 'code', cwd: wa, permissionMode: 'default' }); script = [(b) => { offSys = b.system.map((x) => x.text).join('\n'); offTools = toolsOf(b); return textTurn('ok'); }];
    await agent.send(c.id, 'hi', () => {}); assert(!offTools.includes('delegate_agent') && !offTools.includes('message_agent') && !/delegate_agent/.test(offSys), 'agents: Settings → Agents off removes both tools and the agent list');
    store.saveSettings({ capAgents: true }); let onSys = '';
    c = store.newConversation({ mode: 'code', cwd: wa, permissionMode: 'default' }); script = [(b) => { onSys = b.system.map((x) => x.text).join('\n'); return toolTurn('delegate_agent', { agent: 'nobody', task: 't' }); }, textTurn('ok')];
    await agent.send(c.id, 'hi', () => {}); c = store.getConversation(c.id);
    assert(/- reviewer \(Reviewer\):/.test(onSys) && /^ERROR: Unknown agent "nobody"\. Available: .*engineer/.test(resultsOf(c).at(-1)), 'agents: the system prompt lists the agents; an unknown one is rejected with the available ids');
  }
  store.saveSettings({ autoOpenFiles: false });
  // plugins
  const pl = tmp(); fs.mkdirSync(path.join(pl, '.claude-plugin')); fs.mkdirSync(path.join(pl, 'skills/hello'), { recursive: true }); fs.mkdirSync(path.join(pl, 'commands'));
  fs.writeFileSync(path.join(pl, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'Test Plug', version: '1.2.0', description: 'demo' }));
  fs.writeFileSync(path.join(pl, 'skills/hello/SKILL.md'), '---\nname: hello\ndescription: says hello\n---\nSay hello.');
  fs.writeFileSync(path.join(pl, '.mcp.json'), JSON.stringify({ mcpServers: { srv: stdioDef } }));
  fs.writeFileSync(path.join(pl, 'commands/greet.md'), '---\ndescription: Greet someone\n---\nGreet $ARGUMENTS warmly.');
  const pi = plugins.inspect(pl);
  assert(pi.ok && pi.name === 'test-plug' && pi.skills.join() === 'hello' && pi.servers[0].name === 'test-plug-srv' && pi.commands[0] === '/test-plug:greet' && plugins.list().length === 0 && !skills.list().some((x) => x.id.startsWith('test-plug')), 'plugins: inspect describes the bundle without installing');
  const pr2 = await plugins.install(pl);
  assert(pr2.ok && skills.list().some((x) => x.id === 'test-plug-hello') && mcp.list().find((x) => x.name === 'test-plug-srv')?.status === 'running' && plugins.commands()[0].name === '/test-plug:greet' && /Greet/.test(plugins.commands()[0].prompt), 'plugins: install adds skill, running connector and slash command');
  assert((await plugins.remove('test-plug')).length === 0 && !skills.list().some((x) => x.id.startsWith('test-plug')) && !mcp.list().some((x) => x.name === 'test-plug-srv') && plugins.commands().length === 0, 'plugins: remove cleans up skills, connectors and commands');
  assert(plugins.inspect(tmp()).error, 'plugins: an empty folder is rejected');
  // plugin zip with path traversal is refused
  const evil = path.join(tmp(), 'evil.plugin'); const evd = tmp(); fs.mkdirSync(path.join(evd, 'a')); fs.writeFileSync(path.join(evd, 'a/x'), '1'); fs.writeFileSync(path.join(evd, 'z'), 'x');
  execSync(`cd "${evd}/a" && zip -q "${evil}" ../z`, { stdio: 'ignore' });
  assert(plugins.inspect(evil).error, 'plugins: archives with ".." paths are refused');
  // extensions
  const ecat = await extensions.catalog(); assert(ecat.length >= 6 && ecat.every((x) => x.id && x.name && typeof x.available === 'boolean') && ecat.find((x) => x.id === 'filesystem').params[0].type === 'folder', 'extensions: catalog lists presets with availability and parameters');
  assert((await extensions.install('filesystem', {})).error.includes('required') && (await extensions.install('nope')).error, 'extensions: missing parameter / unknown id rejected');
  const bd = tmp(); fs.writeFileSync(path.join(bd, 'server.js'), fs.readFileSync(mock, 'utf8'));
  fs.writeFileSync(path.join(bd, 'manifest.json'), JSON.stringify({ manifest_version: '0.2', name: 'Mock Ext', version: '0.1.0', description: 'mock', server: { type: 'node', entry_point: 'server.js', mcp_config: { command: process.execPath, args: ['${__dirname}/server.js'], env: { ELECTRON_RUN_AS_NODE: '1' } } } }));
  const bundle = path.join(tmp(), 'mock.mcpb'); execSync(`cd "${bd}" && zip -q "${bundle}" manifest.json server.js`);
  const bi = extensions.inspectBundle(bundle); assert(bi.ok && bi.name === 'mock-ext' && /server\.js/.test(bi.run), 'extensions: .mcpb inspected before install');
  const bres = await extensions.installBundle(bundle); assert(bres.ok && bres.server.status === 'running' && bres.server.tools[0].name === 'ping', 'extensions: .mcpb installs and its server starts');
  fs.writeFileSync(path.join(bd, 'manifest.json'), JSON.stringify({ name: 'cfg', server: { type: 'node', entry_point: 'server.js', mcp_config: { command: 'node', args: ['${__dirname}/server.js', '${user_config.key}'] } }, user_config: { key: { required: true } } }));
  const bundle2 = path.join(tmp(), 'cfg.mcpb'); execSync(`cd "${bd}" && zip -q "${bundle2}" manifest.json server.js`);
  assert(/needs configuration/.test(extensions.inspectBundle(bundle2).error), 'extensions: bundles needing user configuration are declined clearly');
  await extensions.uninstall('mock-ext');
  // privacy & data
  store.saveSettings({ apiKey: 'sk-ant-secretsecretsecret', keys: { openrouter: 'sk-or-v1-secretsecret123' } });
  const exp = JSON.stringify(dataops.exportAll());
  assert(exp.includes('"conversations"') && exp.includes('Sam likes tea') && !exp.includes('secretsecret') && !exp.includes('"apiKey"'), 'privacy: export contains data but never API keys');
  const oldC = store.newConversation({ mode: 'chat' }); const cp = path.join(store.root(), 'conversations', oldC.id + '.json'); fs.writeFileSync(cp, JSON.stringify({ ...oldC, updatedAt: Date.now() - 100 * 86400000 }));
  const pinC = store.newConversation({ mode: 'chat' }); fs.writeFileSync(path.join(store.root(), 'conversations', pinC.id + '.json'), JSON.stringify({ ...pinC, pinned: true, updatedAt: Date.now() - 100 * 86400000 }));
  assert(dataops.purgeOld(0) === 0 && dataops.purgeOld(90) >= 1 && !fs.existsSync(cp) && fs.existsSync(path.join(store.root(), 'conversations', pinC.id + '.json')), 'privacy: retention purges old conversations, keeps pinned and recent ones');
  const dg = dataops.diagnostics(app); logger.append('main.log', 'ERROR key sk-ant-abcdefghijklmnop leaked'); const dg2 = JSON.stringify(dataops.diagnostics(app));
  assert(dg.app.version && !JSON.stringify(dg).includes('secretsecret') && dg2.includes('sk-ant-…') && !dg2.includes('abcdefghijklmnop'), 'developer: diagnostics report omits keys and scrubs logs');
  memory.add('temp'); assert(dataops.deleteData('memory').ok && memory.list().length === 0, 'privacy: delete memory');
  const nBefore = store.listConversations(true).length; assert(dataops.deleteData('conversations').conversations === nBefore && store.listConversations(true).length === 0 && store.getUsage().requests === 0, 'privacy: delete conversations clears chats and usage');
  store.saveSettings({ apiKey: '', keys: { openrouter: '' }, defaultDesignSystem: '' });

  // key ↔ endpoint consistency (a key from one provider must never be sent to another)
  const { safeStorage } = require('electron');
  const rawSettings = (o) => fs.writeFileSync(path.join(store.root(), 'settings.json'), JSON.stringify(o));
  rawSettings({ provider: 'anthropic', baseUrl: '', apiKeyEnc: safeStorage.encryptString('sk-or-v1-legacykey12345').toString('base64'), model: 'anthropic/claude-sonnet-5.5:batch', models: ['anthropic/claude-sonnet-5.5:batch', 'anthropic/claude-sonnet-5.5'], account: { method: 'openrouter-key', at: 1 } });
  assert(store.getSettings().providerKeys.anthropic === false, 'consistency: an OpenRouter key is never reported as an Anthropic key');
  assert(store.heal() === true, 'consistency: startup repair detects the legacy mismatched settings');
  let hs = store.getSettings({ reveal: true });
  assert(hs.provider === 'openai' && hs.baseUrl === 'https://openrouter.ai/api/v1' && hs.apiKey === 'sk-or-v1-legacykey12345' && hs.model === 'anthropic/claude-sonnet-5.5' && hs.providerKeys.openrouter && !hs.providerKeys.anthropic, 'consistency: repair points the endpoint at the key’s provider and drops the :batch suffix');
  assert(store.heal() === false, 'consistency: repair is idempotent');
  store.saveSettings({ provider: 'anthropic', baseUrl: '' });
  hs = store.getSettings({ reveal: true });
  assert(!hs.hasKey && hs.keys.openrouter === 'sk-or-v1-legacykey12345' && !hs.keys.anthropic, 'consistency: switching the endpoint away stashes the key under its own provider and clears the default key');
  store.saveSettings({ apiKey: 'sk-or-v1-pastedkey98765' });
  hs = store.getSettings({ reveal: true }); assert(hs.provider === 'openai' && /openrouter\.ai/.test(hs.baseUrl) && hs.apiKey === 'sk-or-v1-pastedkey98765', 'consistency: pasting an OpenRouter key switches the default endpoint to OpenRouter');
  store.saveSettings({ provider: 'anthropic', baseUrl: 'https://proxy.example.com', apiKey: 'sk-ant-proxykey1234567890' });
  hs = store.getSettings({ reveal: true }); assert(hs.provider === 'anthropic' && hs.baseUrl === 'https://proxy.example.com' && hs.apiKey.startsWith('sk-ant-'), 'consistency: an Anthropic key on a custom proxy is left alone');
  let guard = ''; try { models.route({ model: 'x', provider: 'anthropic', baseUrl: '', keys: { anthropic: 'sk-or-v1-wrongprovider1234' } }, 'anthropic:claude-sonnet-5-5'); } catch (e) { guard = e.message; }
  assert(/actually an OpenRouter key/.test(guard), 'consistency: routing refuses to send an OpenRouter key to Anthropic');
  const s401 = http.createServer((req, res) => { req.resume(); res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'); }); await new Promise((r2) => s401.listen(0, r2));
  let e401 = ''; try { await llm.stream({ provider: 'anthropic', baseUrl: `http://127.0.0.1:${s401.address().port}`, apiKey: 'sk-ant-bad', model: 'm', maxTokens: 5 }, { system: 's', messages: [{ role: 'user', content: 'x' }], tools: [] }, () => {}); } catch (e) { e401 = e.message; } s401.close();
  assert(/API 401/.test(e401) && /rejected the API key/.test(e401) && /Settings → Account/.test(e401), 'errors: a 401 explains the key was rejected and where to fix it');
  store.saveSettings({ apiKey: '', keys: { openrouter: '', anthropic: '' }, provider: 'anthropic', baseUrl: '' });

  // ===== providers: registry, toggles, custom providers, per-provider URLs / keys / model lists =====
  store.saveSettings({ provider: 'anthropic', baseUrl: '', apiKey: '', model: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5'], keys: { anthropic: '', openrouter: '' }, providerCfg: { overrides: {}, custom: [] } });
  const plist = providers.list();
  assert(plist.length === 10 && plist.filter((x) => x.builtin).length === 10 && plist.find((x) => x.id === 'anthropic').enabled && plist.find((x) => x.id === 'openrouter').enabled && !plist.find((x) => x.id === 'openai').enabled && !plist.find((x) => x.id === 'ollama').needsKey, 'providers: built-ins listed (Anthropic and OpenRouter on, others off, local ones need no key)');
  assert(providers.save({ name: '', baseUrl: 'https://x.example/v1' }).error && providers.save({ name: 'Acme' }).error && providers.save({ name: 'Acme', baseUrl: 'ftp://x' }).error && providers.save({ name: 'anthropic', baseUrl: 'https://x.example' }).error, 'providers: custom provider validation (name, URL scheme, duplicate name)');
  // fake OpenAI-compatible server: /models list, chat stream; records the Authorization header
  let lastAuth = 'unset'; let modelsStatus = 200;
  const pSrv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
      lastAuth = req.headers.authorization || '(none)';
      if (req.url === '/v1/models') { res.statusCode = modelsStatus; res.setHeader('content-type', 'application/json'); return res.end(modelsStatus === 200 ? JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2', context_length: 32000, pricing: { prompt: '0.000001', completion: '0.000002' } }] }) : '{}'); }
      if (req.url === '/v1/chat/completions') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi from ' + JSON.parse(b).model } }] }) + '\n\n'); res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } }) + '\n\n'); return res.end('data: [DONE]\n\n'); }
      res.statusCode = 404; res.end();
    });
  });
  await new Promise((r2) => pSrv.listen(0, r2));
  const pUrl = `http://127.0.0.1:${pSrv.address().port}/v1`;
  const added = providers.save({ name: 'My Local AI', type: 'openai', baseUrl: pUrl + '/', apiKey: 'sk-test-12345', models: ['own-model'] });
  assert(added.ok && /^my-local-ai-[0-9a-f]{4}$/.test(added.id) && added.providers.find((x) => x.id === added.id).baseUrl === pUrl && store.getSettings().providerKeys[added.id], 'providers: add a custom provider with URL and key (URL normalised, key stored encrypted)');
  assert(providers.save({ name: 'my local ai', baseUrl: pUrl }).error, 'providers: names are unique case-insensitively');
  const cid = added.id; const mfetch = await providers.fetchModels(providers.get(cid), 'sk-test-12345', { force: true });
  assert(mfetch.models.map((m) => m.id).join() === 'm1,m2,own-model' && !mfetch.error, 'providers: model list comes from the provider, plus your own entries');
  assert(models.contextWindow(store.getSettings({ reveal: true }), `${cid}:m2`) === 32000 && models.priceOf(store.getSettings({ reveal: true }), `${cid}:m2`).out === 2e-6, 'providers: context window and prices learned from the provider’s list');
  const rr = models.route(store.getSettings({ reveal: true }), `${cid}:m1:latest`);
  assert(rr.provider === 'openai' && rr.baseUrl === pUrl && rr.apiKey === 'sk-test-12345' && rr.model === 'm1:latest', 'providers: routing sends the request to that provider’s URL and key (model ids with ":" kept)');
  const streamed = await llm.stream({ ...store.getSettings({ reveal: true }), ...rr, model: 'm1' }, { system: 's', messages: [{ role: 'user', content: 'x' }], tools: [] }, () => {});
  assert(streamed.content[0].text === 'hi from m1' && lastAuth === 'Bearer sk-test-12345', 'providers: a request really goes to the custom provider with its key');
  const tOk = await providers.test(cid); assert(tOk.ok && tOk.count === 3, 'providers: test connection lists models');
  modelsStatus = 500; const tBad = await providers.test(cid); assert(!tBad.ok && /HTTP 500/.test(tBad.error), 'providers: failed test explains the HTTP error'); modelsStatus = 200;
  assert(providers.test('anthropic').then ? (await providers.test('anthropic')).error.includes('API key') : false, 'providers: test without a required key says so');
  providers.save({ id: cid, enabled: false });
  let off = ''; try { models.route(store.getSettings({ reveal: true }), `${cid}:m1`); } catch (e) { off = e.message; }
  assert(/turned off/.test(off) && !(await models.catalog({ force: true })).groups.some((g) => g.id === cid), 'providers: turning one off blocks routing and removes it from the picker');
  providers.save({ id: cid, enabled: true }); const g2 = (await models.catalog({ force: true })).groups.find((g) => g.id === cid);
  assert(g2 && g2.label === 'My Local AI' && g2.models.length === 3 && g2.models[0].value === `${cid}:m1` && g2.hasKey, 'providers: a provider that is on appears in the picker with its models');
  providers.save({ id: cid, baseUrl: pUrl + '2', name: 'Renamed', type: 'anthropic', defaultModel: 'm2' });
  const ed = providers.get(cid); assert(ed.baseUrl === pUrl + '2' && ed.name === 'Renamed' && ed.type === 'anthropic' && ed.defaultModel === 'm2', 'providers: base URL, name, type and default model are editable');
  assert(providers.save({ id: cid, baseUrl: '' }).error, 'providers: a custom provider can’t lose its URL');
  providers.save({ id: cid, baseUrl: pUrl });
  // built-in overrides
  providers.save({ id: 'openai', enabled: true, baseUrl: 'https://proxy.example.com/v1', apiKey: 'sk-openai-test-1234' });
  const oaProv = providers.get('openai'); assert(oaProv.enabled && oaProv.baseUrl === 'https://proxy.example.com/v1' && oaProv.hasKey && oaProv.defaultBaseUrl === 'https://api.openai.com/v1', 'providers: a built-in can be turned on, pointed at another URL and given a key');
  assert(models.route(store.getSettings({ reveal: true }), 'openai:gpt-test').baseUrl === 'https://proxy.example.com/v1', 'providers: routing uses the overridden URL');
  providers.save({ id: 'openai', baseUrl: 'https://api.openai.com/v1' }); assert(providers.get('openai').baseUrl === 'https://api.openai.com/v1' && !store.getSettings().providerCfg.overrides.openai.baseUrl, 'providers: setting the default URL again clears the override');
  // keyless local provider
  providers.save({ id: 'ollama', enabled: true, baseUrl: pUrl });
  const kr = models.route(store.getSettings({ reveal: true }), 'ollama:llama3:8b');
  assert(kr.apiKey === '' && kr.keyless && kr.model === 'llama3:8b', 'providers: a local provider needs no key');
  await llm.stream({ ...store.getSettings({ reveal: true }), ...kr, model: 'llama3' }, { system: 's', messages: [{ role: 'user', content: 'x' }], tools: [] }, () => {});
  assert(lastAuth === '(none)', 'providers: keyless requests send no Authorization header');
  // removal
  assert(providers.remove('anthropic').error && providers.remove(cid).ok && !providers.get(cid) && !store.getSettings().providerKeys[cid], 'providers: built-ins can’t be deleted; custom ones are removed with their key');
  const ng = await models.catalog({ force: true }); assert(!ng.groups.some((g) => g.id === cid), 'providers: a deleted provider leaves the picker');
  pSrv.close(); store.saveSettings({ providerCfg: { overrides: {}, custom: [] }, keys: { openai: '' } });

  // ===== token savers: tool router, output compression, compaction with pinned facts, stats =====
  {
    store.saveSettings({ provider: 'anthropic', baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: 'k', model: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5'], keys: { anthropic: '', openrouter: '' }, capShell: true, capEdit: true, maxSteps: 40 });
    const S = store.getSettings({ reveal: true });
    // output compression (unit)
    const big = Array.from({ length: 4000 }, (_, i) => 'line ' + i).join('\n') + '\nERROR: boom\nlast line';
    const cz = savings.compressOutput(null, 'bash', big, S); const id = (cz.match(/out_[0-9a-f]{8}/) || [])[0];
    assert(cz.length < big.length / 2 && id && cz.includes('last line') && /Output compressed/.test(cz), 'savings: a huge command output is cut to head and tail with a note and an id');
    assert(savings.compressOutput(null, 'bash', 'short', S) === 'short' && savings.compressOutput(null, 'read_file', big, S) === big, 'savings: short outputs and file reads pass through unchanged');
    assert(savings.retrieve({ id, pattern: 'boom' }).includes('ERROR: boom') && savings.retrieve({ id, offset: 100, limit: 2 }).includes('line 99') && savings.retrieve({ id: '../x' }).startsWith('ERROR'), 'savings: retrieve_output reads back by pattern or line range and rejects bad ids');
    const js = JSON.stringify({ items: Array.from({ length: 3000 }, (_, i) => ({ id: i, name: 'n' + i })) });
    const jz = savings.compressOutput(null, 'mcp__x__y', js, S); assert(jz.includes('more items') && jz.length < js.length / 5, 'savings: big JSON keeps its shape with the first items and a count');
    assert(savings.compressOutput(null, 'bash', big, { ...S, saveOutputs: false }) === big, 'savings: output compression can be turned off');
    // router + output compression + retrieve through the real agent loop
    const fakeDefs = Array.from({ length: 8 }, (_, i) => ({ name: 'mcp__fake__t' + (i + 1), description: '[fake] tool number ' + (i + 1) + ' does something useful with a long description that costs tokens', input_schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'string', description: 'a long parameter description '.repeat(5) } } } }));
    const realTD = mcp.toolDefs, realCT = mcp.callTool, called = []; mcp.toolDefs = () => fakeDefs; mcp.callTool = async (n, a) => { called.push([n, a]); return 'mcp-result'; };
    try {
      const before = savings.totals(); let seenResult = '', retrieved = '';
      let c2 = store.newConversation({ mode: 'code', cwd: w, permissionMode: 'bypassPermissions' }); seenTools = [];
      script = [toolTurn('mcp_tools', { server: 'fake', tools: ['t3'] }), toolTurn('mcp_invoke', { tool: 'fake__t3', input: { x: 1 } }), toolTurn('bash', { command: "seq 1 4000; echo 'ERROR: boom'" }),
        (body) => { seenResult = JSON.stringify(body.messages.at(-1).content); const m = seenResult.match(/out_[0-9a-f]{8}/); return toolTurn('retrieve_output', { id: m && m[0], pattern: 'boom' }); },
        (body) => { retrieved = JSON.stringify(body.messages.at(-1).content); return textTurn('all done'); }];
      await agent.send(c2.id, 'go', () => {}); c2 = store.getConversation(c2.id);
      assert(seenTools[0].includes('mcp_tools') && seenTools[0].includes('mcp_invoke') && !seenTools[0].includes('mcp__fake__t1'), 'router: with many connector tools the model sees two router tools, not every schema');
      assert(called.length === 1 && called[0][0] === 'mcp__fake__t3' && called[0][1].x === 1, 'router: mcp_invoke runs the real connector tool with its input');
      assert(seenResult.includes('Output compressed') && retrieved.includes('ERROR: boom'), 'savings: a compressed result carries a note and retrieve_output returns the hidden part');
      const after = savings.totals(); assert(after.router > before.router && after.outputs > before.outputs && c2.savings.router > 0 && c2.savings.outputs > 0, 'savings: the tallies grow, globally and per conversation | ' + JSON.stringify(c2.savings));
      assert(savings.describeTools(fakeDefs, { server: 'nope' }).startsWith('ERROR') && savings.describeTools(fakeDefs, {}).split('\n').length === 8, 'router: mcp_tools lists tools and names unknown servers');
      // permissions apply to the real tool: default mode asks about the connector call, not about "mcp_invoke"
      let asked = null; let c3 = store.newConversation({ mode: 'code', cwd: w, permissionMode: 'default' });
      script = [toolTurn('mcp_invoke', { tool: 'fake__t2', input: {} }), textTurn('x')]; await agent.send(c3.id, 'go', (e) => { if (e.type === 'approval') { asked = e.name; agent.answer(e.approvalId, 'deny'); } });
      assert(asked === 'mcp__fake__t2', 'router: approval cards name the real connector tool | ' + asked);
    } finally { mcp.toolDefs = realTD; mcp.callTool = realCT; }
    // with few tools nothing is routed
    const few = savings.routeMcp([{ name: 'mcp__a__b', description: 'x', input_schema: {} }], S, null); assert(!few.active && few.defs.length === 1, 'router: a handful of tools is left alone');
    // compaction + pins
    const longMsgs = []; for (let i = 0; i < 14; i++) longMsgs.push({ role: i % 2 ? 'assistant' : 'user', content: `message ${i} ` + 'filler text '.repeat(120) });
    let c4 = store.newConversation({ mode: 'chat' }); c4.messages = longMsgs.map((m) => ({ ...m })); store.saveConversation(c4);
    assert(savings.pin(c4.id, 'Budget is five dollars').ok && savings.pin(c4.id, 'budget is five dollars').duplicate && savings.pins(c4.id).length === 1, 'pins: a fact is pinned once');
    script = [textTurn('The user is planning a trip. Decisions: ' + 'x'.repeat(80))];
    const cr = await agent.compactNow(c4.id); c4 = store.getConversation(c4.id);
    assert(cr.ok && savings.isSummary(c4.messages[0]) && c4.messages[1].role === 'assistant' && c4.messages[2].role === 'user' && typeof c4.messages[2].content === 'string' && c4.messages.at(-1).content === longMsgs.at(-1).content && c4.messages.length < longMsgs.length, 'compaction: older turns become a summary, the latest turns are kept intact and start on a user message');
    assert(c4.pinned.length === 1 && c4.savings.compact > 0, 'compaction: pinned facts survive and the saving is counted');
    let sys4 = ''; router = (b) => { sys4 = b.system.map((x) => x.text).join('\n'); return textTurn('fine'); }; await agent.send(c4.id, 'continue', () => {}); router = null;
    assert(sys4.includes('Pinned facts') && sys4.includes('Budget is five dollars'), 'pins: pinned facts are always in the system prompt');
    assert(savings.unpin(c4.id, 0).ok && savings.pins(c4.id).length === 0, 'pins: unpin removes a fact');
    // automatic compaction when the context is nearly full
    store.saveSettings({ saveCompact: true, compactKeep: 4 });
    let c5 = store.newConversation({ mode: 'chat' }); c5.messages = longMsgs.map((m) => ({ ...m })); c5.ctx = { used: 170000, max: 200000 }; store.saveConversation(c5);
    let calls5 = 0; router = (b) => { calls5++; return calls5 === 1 ? textTurn('Summary of everything so far: ' + 'y'.repeat(80)) : textTurn('answer'); }; await agent.send(c5.id, 'next question', () => {}); router = null;
    c5 = store.getConversation(c5.id); assert(calls5 === 2 && savings.isSummary(c5.messages[0]), 'compaction: runs by itself when the context passes the limit, before the reply');
    store.saveSettings({ saveCompact: false, compactKeep: 8 });
    const small = store.newConversation({ mode: 'chat' }); small.messages = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]; store.saveConversation(small);
    assert((await agent.compactNow(small.id)).error, 'compaction: a short conversation is not compacted');
    assert(cleanSettings({ saveOutputChars: 5, compactAtPct: 500 }).out.saveOutputChars === 2000 && cleanSettings({ compactAtPct: 500 }).out.compactAtPct === 95, 'settings: saver limits are clamped');
  }

  // ===== mods: worker host, hook chains, `$` services, atoms, tools, commands, UI trees =====
  const modEnvSettings = { modsEnabled: {}, model: 'claude-sonnet-5-5' }; const modToasts = [];
  modHost.init({
    getSettings: () => modEnvSettings, saveSettings: (p) => Object.assign(modEnvSettings, p), getConversation: () => ({ createdAt: Date.now(), messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', id: 't1', name: 'read_file', input: { path: '/x' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'data' }] }] }),
    root: () => store.root(), version: () => '9.9.9', fullPath: () => process.env.PATH, log: () => {}, push: (ch, p2) => { if (ch === 'mods:toast') modToasts.push(p2.text); },
    ask: async (q) => (q.options && q.options[1]) || 'free', notify: async () => ({ isSent: true }), builtinToolNames: () => ['bash'], builtinCommands: () => [], mcpCall: async () => 'mcp-ok',
    sessionUsage: () => ({ startedAt: 1, context: { tokens: 10, window: 100, percent: 10 }, rateLimits: [] }), modelComplete: async (r) => ({ isAnswered: true, text: 'completed:' + r.prompt, usage: {} }), modelFork: async (cid, r) => ({ isAnswered: true, text: 'forked:' + r.prompt, usage: {} }), modelClassify: async (t, labels) => labels[0],
  });
  const mkMod = (name, files) => { const root = path.join(tmp(), '.claude', 'x', name); fs.mkdirSync(path.join(root, 'hooks'), { recursive: true }); fs.mkdirSync(path.join(root, '.claude-plugin')); fs.writeFileSync(path.join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name, version: '1.0.0', description: name })); fs.writeFileSync(path.join(root, 'hooks/hooks.json'), JSON.stringify({ modules: ['./register.tsx'] })); for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(root, 'hooks', f), c); return modHost.inspectRoot(root, 'test'); };
  const modA = mkMod('mod-a', {
    'helper.ts': "export const tag = (s: string): string => s + ' [A]'\nexport type Unused = { a: number }",
    'register.tsx': `import type { Register } from 'claude-code'
import { atom, read, update } from 'claude-code'
import { tag } from './helper'
const count = atom({ plugin: 'mod-a', key: 'count' } as const, 0)
export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'hi', description: 'says hi' })
    await $.tool.register({ name: 'echo', description: 'echoes', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } })
    return next(e)
  })
  on('prompt.submit', async ($, e, next) => next({ ...e, text: tag(e.text) }))
  on('command.run', { command: 'hi' }, async ($, e) => ({ text: 'hello ' + e.args + ' ' + (await $.session.id()) }))
  on('command.run', { command: /^stat/ }, async ($, e) => { await update($, count, n => n + 5); const [files, usage, msgs] = [await $.fs.list(await $.session.cwd()), await $.session.usage(), await $.session.messages()]; return { text: 'count=' + (await read($, count)) + ' msgs=' + msgs.length + ' tool=' + msgs[1].toolUses[0].tool + ' ctx=' + usage.context.tokens } })
  on('command.run', { command: 'ask' }, async ($) => ({ text: 'answer=' + (await $.ui.ask('Which?', ['One', 'Two'])) }))
  on('command.run', { command: 'proc' }, async ($, e) => { const r = await $.process.run(['sh', '-c', 'cat; echo err >&2'], { stdin: 'piped' }); return { text: r.stdout + '|' + r.stderr.trim() + '|' + r.exitCode } })
  on('command.run', { command: 'model' }, async ($) => ({ text: ((await $.model.complete({ model: 'x', prompt: 'p' })) as any).text + ' ' + ((await $.model.fork({ prompt: 'q' })) as any).text + ' ' + (await $.model.classify('t', ['a', 'b'])) }))
  on('command.run', { command: 'store' }, async ($) => { await $.store.set('k', { n: 1 }); return { text: JSON.stringify(await $.store.get('k')) + JSON.stringify(await $.store.keys()) } })
  on('command.run', { command: 'sandbox' }, async () => { const out: string[] = []; try { out.push(typeof (globalThis as any).process, typeof (globalThis as any).require); } catch {} try { out.push(String(new Function('return 1')())) } catch (err) { out.push('nofunc') } return { text: out.join(',') } })
  on('command.run', { command: 'clock' }, async ($) => { let n = 0; const t = $.clock.every(30, () => { n++ }); await $.clock.sleep(150); t.cancel(); const at = n; await $.clock.sleep(100); return { text: 'ticks=' + (at >= 2 ? 'ok' : at) + ' stopped=' + (n === at) } })
  on('tool.call', { tool: 'mcp__mod-a__echo' }, async ($, e) => ({ result: 'echo:' + (e as any).text }))
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const n = await read($, count)
    return <Box flexDirection="column" key="a"><Text bold color="green">count {n}</Text><Button key="inc" label="More" onPress={() => update($, count, v => v + 1)} /></Box>
  })
  on('ui.press', { plugin: 'mod-a', element: /^inc$/ }, async ($, e, next) => { $.ui.toast('pressed ' + e.element); return next(e) })
}
` });
  const modB = mkMod('mod-0', {
    'register.tsx': `export const register = (on) => {
  on('prompt.submit', async ($, e, next) => { const r = await next({ ...e, text: e.text + ' [B]' }); return r })
  on('prompt.submit', async ($, e, next) => { throw new Error('boom') }).catch(($, e, next) => next(e))
  on('turn.step', async function* ($, e, next) { const r = yield* next(e); return { ...r, usage: { ...r.usage, output_tokens: (r.usage?.output_tokens || 0) + 1 } } })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => { const inner = await next(e); const { Box, Text } = $.ui.resolve(e); return h(Box, { key: 'b' }, h(Text, {}, 'B sees: ' + (inner.type === 'engine' ? 'engine' : inner.type)), inner) })
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => next({ ...e, props: { ...e.props, text: e.props.text.replace(/secret/g, '▒▒▒') } }))
  on('command.run', { command: 'hang' }, async () => { for (;;) {} })
}
` });
  const modC = mkMod('mod-bad', { 'register.tsx': "export const register = () => { throw new Error('cannot start') }\n" });
  const modD = mkMod('mod-pkg', { 'register.tsx': "import x from 'left-pad'\nexport const register = () => { x() }\n" });
  const ra = await modHost.start(modA), rb = await modHost.start(modB), rc = await modHost.start(modC), rd = await modHost.start(modD);
  assert(ra.status === 'running' && rb.status === 'running' && ra.hooks.length >= 9, 'mods: a TypeScript/TSX mod with relative imports and atoms loads in its own worker');
  assert(rc.status === 'failed' && /cannot start/.test(rc.error) && rd.status === 'failed' && /Imports of packages/.test(rd.error), 'mods: a mod that throws or imports a package fails cleanly without affecting others | ' + rc.status + ':' + String(rc.error).slice(0, 80) + ' | ' + rd.status + ':' + String(rd.error).slice(0, 120));
  modHost.setSession({ convId: 'conv1', cwd: process.env.HOME }); await new Promise((r2) => setTimeout(r2, 500));
  assert(modHost.info().commands.some((c) => c.name === 'hi' && c.plugin === 'mod-a') && modHost.toolDefs().some((t) => t.name === 'mcp__mod-a__echo') && modHost.isModTool('mcp__mod-a__echo'), 'mods: $.command.register and $.tool.register reach the host (tools are named mcp__<mod>__<tool>)');
  const ps = await modHost.promptSubmit('hello');
  assert(ps.text === 'hello [B] [A]' || ps.text === 'hello [A] [B]', 'mods: prompt.submit chains through both mods; the failing hook with .catch is skipped (' + ps.text + ')');
  assert((await modHost.commandRun('mod-a', 'hi', 'there')).text === 'hello there conv1', 'mods: command.run reaches the mod’s hook with args, and $.session.id() is the current chat');
  assert((await modHost.commandRun('mod-a', 'nothing', '')).text.includes('No mod handled'), 'mods: an unhandled command gets a clear default answer');
  const statusRes = (await modHost.commandRun('mod-a', 'status', '')).text;
  assert(statusRes === 'count=5 msgs=3 tool=Read ctx=10', 'mods: atoms (read/update) persist in $.state; $.session.messages maps GrizzyCode tools to Claude names | got ' + statusRes);
  assert((await modHost.commandRun('mod-a', 'ask', '')).text === 'answer=Two', 'mods: $.ui.ask round-trips through the app');
  assert((await modHost.commandRun('mod-a', 'proc', '')).text === 'piped|err|0', 'mods: $.process.run feeds stdin and returns stdout, stderr and the exit code');
  assert((await modHost.commandRun('mod-a', 'model', '')).text === 'completed:p forked:q a', 'mods: $.model.complete / fork / classify reach the app’s model');
  const stRes = (await modHost.commandRun('mod-a', 'store', '')).text; assert(stRes === '{"n":1}["k"]', 'mods: $.store persists per mod | got ' + stRes);
  const sb = (await modHost.commandRun('mod-a', 'sandbox', '')).text; assert(sb.includes('undefined,undefined') && sb.includes('nofunc'), 'mods: the mod sandbox has no Node (process, require) and no eval/new Function: ' + sb);
  assert((await modHost.commandRun('mod-a', 'clock', '')).text === 'ticks=ok stopped=true', 'mods: $.clock.every / sleep work and timers cancel');
  const tr = await modHost.callModTool('mcp__mod-a__echo', { text: 'yo' }, 'tu9'); assert(tr === 'echo:yo', 'mods: a mod-registered tool runs through the mod’s tool.call hook');
  let seen = null; const wrapped = await modHost.toolCall('read_file', { path: '/a' }, 'tu1', async () => 'file text'); assert(wrapped === 'file text', 'mods: built-in tools still run when mods observe tool.call');
  const tree = await modHost.render('AbovePrompt', 'band', { hasSurvey: false, bodyColumns: 80 });
  assert(tree.type === 'Box' && JSON.stringify(tree).includes('B sees: Box') && JSON.stringify(tree).includes('"count "') && /"press":\{"plugin":"mod-a","handle":\d+\}/.test(JSON.stringify(tree)), 'mods: ui.render hooks chain into one JSON tree; Buttons carry press handles; `await next(e)` gives the inner mod’s tree | ' + JSON.stringify(tree).slice(0, 400));
  const btn = (function find(n) { if (!n || typeof n !== 'object') return null; if (n.type === 'Button') return n; for (const k of n.children || []) { const r2 = find(k); if (r2) return r2; } return null; })(tree);
  const pr = await modHost.press({ plugin: 'mod-a', handle: btn.press.handle, element: 'inc', component: 'AbovePrompt', requestId: 'band' });
  assert(!pr.error && modToasts.includes('pressed inc'), 'mods: a button press runs the ui.press hook chain, then the element’s onPress');
  const flat = (n) => (typeof n === 'string' ? n : Array.isArray(n.children) ? n.children.map(flat).join('') : ''); const tree2 = await modHost.render('AbovePrompt', 'band', {}); assert(flat(tree2).includes('count 6'), 'mods: state written by a press redraws the readers | got ' + flat(tree2).slice(0, 80) + ' | press result ' + JSON.stringify(pr));
  const msg = await modHost.render('AssistantMessage', 'm', { text: 'a secret here' }); assert(msg.type === 'engine' && msg.props.text === 'a ▒▒▒ here', 'mods: ui.render can rewrite a message’s props while the engine still draws it');
  const step = await modHost.turnStep({ turnId: 't', index: 0, model: 'm', messageCount: 1 }, async () => ({ input_tokens: 5, output_tokens: 7 }));
  assert(step.usage.output_tokens === 8, 'mods: a streaming (async generator) turn.step hook wraps the model request and rewrites its result');
  const t0 = Date.now(); const hung = await modHost.raise('command.run', { command: 'hang', args: '' }, async () => ({ text: 'fallthrough' }), { timeoutMs: 1200 });
  assert(hung.text === 'fallthrough' && Date.now() - t0 < 6000, 'mods: a mod stuck in an infinite loop times out and is skipped; the app stays responsive');
  await modHost.stop('mod-0'); assert(modHost.mods.get('mod-0') === undefined && (await modHost.promptSubmit('x')).text === 'x [A]', 'mods: stopping a mod drops its hooks at once');
  const failedOnes = [...modHost.mods.values()].filter((m) => m.status === 'failed').length; assert(failedOnes === 2, 'mods: failed mods are listed with their error | ' + [...modHost.mods.values()].map((m) => m.name + ':' + m.status).join(','));
  assert(modHost.run && (await modHost.run(['sh', '-c', 'sleep 5'], { timeoutMs: 300 })).exitCode === 124, 'mods: process.run enforces its timeout');
  // ----- authoring: create, install, export, publish, remove -----
  {
    const author = require('../src/main/mods/author');
    const nd = tmp(); const mk = tmp(); // fake native mods dir + a fake marketplace
    const c1 = author.create({ name: 'my-mod', description: 'Does a thing' }, { taken: ['mod-a'], dir: nd });
    assert(c1.ok && c1.root === path.join(nd, 'my-mod') && ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.tsx'].every((f) => fs.existsSync(path.join(c1.root, f))), 'mod authoring: a new mod is scaffolded in GrizzyCode’s own mods folder');
    assert(author.create({ name: 'mod-a' }, { taken: ['mod-a'], dir: nd }).error && author.create({ name: 'my-mod' }, { dir: nd }).error && author.create({ name: '../x' }, { dir: nd }).error && author.create({ name: 'Bad Name' }, { dir: nd }).error && author.create({ name: '..' }, { dir: nd }).error, 'mod authoring: a name that is taken, a duplicate folder, or not plain is refused');
    const sc = modHost.inspectRoot(c1.root, 'GrizzyCode'); const rs = await modHost.start(sc);
    assert(sc && sc.name === 'my-mod' && rs.status === 'running', 'mod authoring: the scaffold loads and runs as written | ' + rs.status + ' ' + rs.error);
    modHost.setSession({ convId: 'conv1', cwd: process.env.HOME }); await new Promise((r2) => setTimeout(r2, 400));
    assert(modHost.info().commands.some((c) => c.name === 'my-mod') && (await modHost.commandRun('my-mod', 'my-mod', 'hey')).text.includes('You typed: hey'), 'mod authoring: the scaffold’s slash command is listed and answers');
    // two modules in hooks.json both load
    const two = mkMod('mod-two', { 'register.tsx': '', 'a.ts': "export const register = (on) => { on('command.run', { command: 'ta' }, async () => ({ text: 'A' })) }", 'b.ts': "export const register = (on) => { on('command.run', { command: 'tb' }, async () => ({ text: 'B' })) }" });
    fs.writeFileSync(path.join(two.root, 'hooks/hooks.json'), JSON.stringify({ modules: ['./a.ts', './b.ts'] })); const two2 = modHost.inspectRoot(two.root, 'test'); await modHost.start(two2);
    assert((await modHost.commandRun('mod-two', 'ta', '')).text === 'A' && (await modHost.commandRun('mod-two', 'tb', '')).text === 'B', 'mods: every module listed in hooks.json is loaded');
    // install from folder: copies into the mods folder, replaces on reinstall, never wipes anything else
    const ins = author.install(modA.root, (r) => modHost.inspectRoot(r, 'GrizzyCode'), { dir: nd });
    assert(ins.ok && !ins.replaced && fs.existsSync(path.join(nd, 'mod-a', 'hooks/register.tsx')) && author.install(modA.root, (r) => modHost.inspectRoot(r, 'GrizzyCode'), { dir: nd }).replaced, 'mod install: copies into the mods folder and a reinstall replaces it');
    assert(author.install(path.join(nd, 'mod-a'), (r) => modHost.inspectRoot(r, 'GrizzyCode'), { dir: nd }).unchanged && fs.existsSync(path.join(nd, 'mod-a', 'hooks/register.tsx')), 'mod install: picking the installed folder itself does not delete it');
    const evil = mkMod('evil', { 'register.tsx': '' }); fs.writeFileSync(path.join(evil.root, '.claude-plugin/plugin.json'), JSON.stringify({ name: '..', version: '1' }));
    fs.writeFileSync(path.join(nd, 'keep.txt'), 'x'); const ev = author.install(evil.root, (r) => modHost.inspectRoot(r, 'GrizzyCode'), { dir: nd });
    assert(ev.error && fs.existsSync(path.join(nd, 'keep.txt')) && fs.existsSync(path.join(nd, 'my-mod')), 'mod install: a manifest name like “..” is refused and nothing is deleted');
    // export, then install the zip elsewhere
    const zf = path.join(tmp(), 'my-mod.zip'); const ex = author.exportZip(sc, zf);
    const nd2 = tmp(); const zi = author.install(zf, (r) => modHost.inspectRoot(r, 'GrizzyCode'), { dir: nd2 });
    assert(ex.ok && zi.ok && zi.name === 'my-mod' && fs.existsSync(path.join(nd2, 'my-mod', 'hooks/register.tsx')), 'mod export: the .zip installs back as the same mod');
    // publish to a marketplace: new, then existing
    fs.mkdirSync(path.join(mk, 'plugins'), { recursive: true }); fs.mkdirSync(path.join(mk, '.claude-plugin'));
    fs.writeFileSync(path.join(mk, '.claude-plugin/marketplace.json'), JSON.stringify({ name: 'team', plugins: [{ name: 'old', source: './plugins/old', description: 'o', version: '1' }] }));
    const pb = author.publish(sc, mk); const mj = JSON.parse(fs.readFileSync(path.join(mk, '.claude-plugin/marketplace.json'), 'utf8'));
    assert(pb.ok && !pb.replaced && mj.plugins.some((p) => p.name === 'old') && mj.plugins.some((p) => p.name === 'my-mod' && p.source === './plugins/my-mod') && pb.install[1] === '/plugin install my-mod@team' && fs.existsSync(path.join(mk, 'plugins/my-mod/hooks/register.tsx')), 'mod publish: adds to the chosen marketplace and keeps its other entries');
    const pb2 = author.publish(sc, mk); assert(pb2.ok && pb2.replaced && JSON.parse(fs.readFileSync(path.join(mk, '.claude-plugin/marketplace.json'), 'utf8')).plugins.filter((p) => p.name === 'my-mod').length === 1, 'mod publish: publishing again replaces the entry instead of duplicating it');
    const fresh = tmp(); const pb3 = author.publish(sc, fresh); assert(pb3.ok && pb3.created && JSON.parse(fs.readFileSync(path.join(fresh, '.claude-plugin/marketplace.json'), 'utf8')).plugins[0].name === 'my-mod', 'mod publish: an empty folder becomes a new marketplace');
    fs.writeFileSync(path.join(mk, '.claude-plugin/marketplace.json'), '{oops'); assert(author.publish(sc, mk).error && fs.readFileSync(path.join(mk, '.claude-plugin/marketplace.json'), 'utf8') === '{oops', 'mod publish: a broken marketplace.json is left untouched');
    // nothing the above did touched the other mods' folders; remove only works for the mods folder
    assert(author.removeNative(modA, { dir: nd }).error && !fs.existsSync(path.join(nd, 'nope')) && fs.existsSync(modA.root), 'mod remove: a mod outside GrizzyCode’s folder is not deleted');
    await modHost.stop('my-mod', true); assert(author.removeNative(sc, { dir: nd }).ok && !fs.existsSync(c1.root), 'mod remove: a GrizzyCode mod is deleted');
    await modHost.stop('mod-two', true);
    // a GrizzyCode mod sees itself at ~/.claude/mods/<folder> (so shared switches/lists work) and the paths map back
    const ccm = path.join(os.homedir(), '.claude', 'mods'); const realNF = modHost.nativeFolders; modHost.nativeFolders = () => ['zz-fake'];
    try {
      assert(modHost.pluginRoot({ source: 'GrizzyCode', root: '/x/.GrizzyCode/mods/zz-fake' }) === path.join(ccm, 'zz-fake') && modHost.pluginRoot({ source: 'Claude Code', root: '/c/p' }) === '/c/p', 'mods: only GrizzyCode mods get the ~/.claude/mods view of their root');
      assert(modHost.mapPath(path.join(ccm, 'zz-fake', 'hooks', 'a.ts')) === path.join(modHost.constructor === Object ? '' : require('../src/main/mods/author').NATIVE_DIR, 'zz-fake', 'hooks', 'a.ts') && modHost.mapPath('/etc/hosts') === '/etc/hosts', 'mods: the shared view maps to the real folder; other paths are untouched');
      assert(modHost.mapPath(path.join(ccm, 'switches.json')) === path.join(require('../src/main/mods/author').NATIVE_DIR, 'switches.json') && modHost.mapPath(path.join(ccm, '.open-x-1')) === path.join(require('../src/main/mods/author').NATIVE_DIR, '.open-x-1'), 'mods: switches.json and open requests live in ~/.GrizzyCode/mods, not Claude Code’s folder');
      assert(modHost.listDir(ccm).some((e) => e.name === 'zz-fake' && e.kind === 'dir'), 'mods: ~/.claude/mods lists GrizzyCode mods so the /mods pane finds them');
    } finally { modHost.nativeFolders = realNF; }
  }
  await modHost.stopAll();
  mcp.stopAll(); srv.close();
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED'); app.exit(failed ? 1 : 0);
}));
