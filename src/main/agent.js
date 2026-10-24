// Conversation turn runner: streams the model, applies the permission mode, executes tools, loops.
const store = require('./store');
const llm = require('./llm');
const tools = require('./tools');
const mcp = require('./mcp');
const skills = require('./skills');
const models = require('./models');
const memory = require('./memory');
const designsystems = require('./designsystems');
const access = require('./access');
const agents = require('./agents');
const mods = require('./mods/host');
const acp = require('./acp');
const savings = require('./savings');
const { randomUUID } = require('crypto');

const active = new Map();      // convId -> AbortController
const approvals = new Map();   // approvalId -> resolve(decision)

function buildSystem(s, conv) {
  let sys = s.systemPrompt;
  if (conv.mode === 'code') {
    sys += `\n\nYou are operating as a coding agent. Working directory: ${conv.cwd}${conv.ssh ? ` on remote host ${conv.ssh.host} (all file and shell tools run there over SSH)` : ''}. Use the tools to inspect and modify files and run commands. Prefer small, verified steps.`;
    if (conv.permissionMode === 'plan') sys += '\n\nPLAN MODE is active: you may only read and search. Investigate, then call exit_plan_mode with a concrete plan. Do not attempt to change anything.';
  }
  if (s.displayName?.trim()) sys += `\n\nThe user's name is ${s.displayName.trim()}.`;
  if (s.preferences?.trim()) sys += `\n\nThe user's personal preferences (follow them unless the task says otherwise):\n${s.preferences.trim().slice(0, 2000)}`;
  sys += memory.promptBlock(s) + designsystems.promptBlock(s) + agents.promptBlock(conv.agentId);
  const pr = store.getProject(conv.projectId);
  if (pr && pr.instructions.trim()) sys += `\n\nProject "${pr.name}" — follow these project instructions:\n${pr.instructions}`;
  const sk = s.capSkills === false ? [] : skills.list();
  if (sk.length) sys += '\n\nInstalled skills (call use_skill with the id to load full instructions when relevant):\n' + sk.map((k) => `- ${k.id}: ${k.description}`).join('\n');
  return sys + savings.pinBlock(conv.pinned);
}
const title = (text) => text.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New conversation';

// -> 'allow' | 'ask' | 'deny'
function decide(conv, name, settings = {}) {
  const kind = tools.kindOf(name);
  if (kind === 'read') return 'allow';
  let mode = conv.permissionMode;
  if (mode === 'bypassPermissions' && settings.allowBypass === false) mode = 'acceptEdits'; // disabled in Settings → Claude Code
  if (mode === 'bypassPermissions') return 'allow';
  if (mode === 'plan') return 'deny';
  if ((conv.allow || []).includes(name)) return 'allow';
  if (mode === 'acceptEdits' && kind === 'edit') return 'allow';
  return 'ask';
}

// Summaries for conversation compaction go to the conversation's own model unless Settings names a cheaper one.
function summarizer(s, model, convId, mode, signal) {
  const m = (s.compactModel && String(s.compactModel).trim()) || model;
  return async (prompt) => {
    const res = await llm.stream({ ...s, ...models.route(s, m), maxTokens: 2500 }, { system: 'You write faithful, compact summaries of conversations.', messages: [{ role: 'user', content: prompt }], tools: [] }, () => {}, signal);
    store.addUsage(res.usage, { model: models.canon(s, m), mode, conv: convId, price: models.priceOf(s, m) });
    return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  };
}
// /compact: summarize the older turns now, whatever the threshold.
async function compactNow(convId) {
  if (isRunning(convId)) return { error: 'Wait for the current reply to finish, then try again.' };
  const s = store.getSettings({ reveal: true }); const conv = store.getConversation(convId);
  const model = conv.model || agents.get(conv.agentId)?.model || s.model;
  const r = await savings.compact(conv, s, summarizer(s, model, convId, conv.mode, AbortSignal.timeout(180000)), { force: true });
  if (r.compacted) store.saveConversation(conv);
  return r.compacted ? { ok: true, ...r } : { error: `Nothing to compact: ${r.skipped}.` };
}

// One tool call under the permission rules: check, ask the user when needed, run. `who` names a delegated agent in approval cards.
// `lists` are the access limits that apply (the conversation's agent; a delegated agent adds its own on top).
async function execTool(conv, convId, c, toolDefs, s, emit, signal, who = '', lists = [agents.accessOf(agents.get(conv.agentId))]) {
  // Token-saver tools: answered here, no permission needed (they only read GrizzyCode's own saved data).
  if (c.name === 'retrieve_output') return savings.retrieve(c.input);
  if (c.name === 'mcp_tools') return savings.describeTools(access.keep(lists, mcp.toolDefs()), c.input);
  if (c.name === 'pin_fact') { const r = savings.pin(convId, c.input?.fact); return r.error ? 'ERROR: ' + r.error : (conv.pinned = r.pinned, 'Pinned. It will be kept through any compaction of this conversation.'); }
  const real = savings.unwrapInvoke(c, mcp.toolDefs()); if (real) c = real; // mcp_invoke runs (and is approved as) the real connector tool
  const blocked = access.check(lists, c.name, c.input, conv.cwd); if (blocked) throw new Error(blocked);
  const verdict = mods.isModTool(c.name) ? 'allow' : decide(conv, c.name, s);
  if (verdict === 'deny') throw new Error('Plan mode is active: this tool is not available.' + (who ? '' : ' Call exit_plan_mode when your plan is ready.'));
  if (!toolDefs.some((t) => t.name === c.name) && c.name !== 'exit_plan_mode') throw new Error(`The tool ${c.name} is not enabled. It can be turned on in Settings → Capabilities.`);
  if (verdict === 'ask') {
    const d = await ask(emit, convId, c, who ? { agent: who } : {});
    if (d === 'session') { const l = store.getConversation(convId); l.allow = [...new Set([...(l.allow || []), c.name])]; store.saveConversation(l); conv.allow = l.allow; }
    else if (d !== 'once') throw new Error('User denied this tool call.');
  }
  const out = mods.isModTool(c.name) ? await mods.callModTool(c.name, c.input, c.id) : await mods.toolCall(c.name, c.input, c.id, () => (c.name.startsWith('mcp__') ? mcp.callTool(c.name, c.input) : tools.run(c.name, c.input, conv.cwd, signal, conv.ssh)));
  if (s.autoOpenFiles && !conv.ssh && (c.name === 'write_file' || c.name === 'edit_file') && !/^ERROR/.test(String(out))) { try { require('electron').shell.openPath(require('path').resolve(conv.cwd || '.', c.input.path)); } catch {} }
  return out;
}

// ---- Agents: delegate_agent starts another agent on a task; message_agent talks to one that already exists ----
// Each delegated agent is its own message history with its own persona, tools and model. It is registered under the
// conversation it belongs to, so any agent in that conversation (the main one or a sibling) can message it by id.
const registries = new Map();   // convId -> Map(agentId -> { id, def, name, messages, running, depth })
// Saved in the conversation file (conv.agents) so a delegated agent can still be messaged after a restart. The persona is looked up
// again by id, so edits to an agent apply to it; the saved copy is only used if that agent has since been deleted.
function registry(convId) {
  if (!registries.has(convId)) {
    const m = new Map(); let saved = [];
    try { saved = store.getConversation(convId).agents || []; } catch {}
    for (const a of saved) m.set(a.id, { id: a.id, def: agents.get(a.agentId) || a.def, name: a.name, messages: a.messages, running: false, depth: a.depth });
    registries.set(convId, m);
  }
  return registries.get(convId);
}
function persistAgents(root, convId) {
  const list = [...registry(convId).values()].map((x) => ({ id: x.id, agentId: x.def.id, def: x.def, name: x.name, messages: x.messages, depth: x.depth }));
  root.agents = list;                                  // the running turn saves its own copy of the conversation too
  try { const l = store.getConversation(convId); l.agents = list; store.saveConversation(l); } catch {}
}
const MAX_AGENTS = 24, SUB_STEPS = 25, MODE_RANK = { plan: 0, default: 1, acceptEdits: 2, bypassPermissions: 3 };
// A delegated agent never has more freedom than the conversation it works for.
const clampMode = (want, parent) => (want && (MODE_RANK[want] ?? 1) < (MODE_RANK[parent] ?? 1) ? want : parent);
const findAgent = (ref) => { const r = String(ref || 'general').trim().toLowerCase(); const all = agents.list().filter((a) => a.enabled); return all.find((a) => a.id.toLowerCase() === r) || all.find((a) => a.name.toLowerCase() === r); };

function roster(s, depth, convId) {
  if (s.capAgents === false) return '';
  const can = depth < tools.MAX_AGENT_DEPTH;
  let t = '\n\nAgents: ' + (can ? 'you can hand self-contained subtasks to specialised agents with delegate_agent. They work independently with their own context and return a report; several delegate_agent calls in one turn run in parallel. Delegate when it helps (wide searches, independent parts, a second opinion or review) and do small things yourself. ' : '');
  t += 'Use message_agent with an agent id to send it a follow-up, or to pass it another agent\'s findings.';
  if (can) t += ' Available agents:\n' + agents.list().filter((a) => a.enabled).map((a) => `- ${a.id}${a.name !== a.id ? ` (${a.name})` : ''}: ${a.description || 'no description'}`).join('\n');
  const alive = [...registry(convId).values()];
  if (alive.length) t += '\n\nAgents already working in this conversation (message them by id):\n' + alive.map((x) => `- ${x.id}: ${x.name}`).join('\n');
  return t;
}

// Always resolves to a string, so a failed or cancelled agent shows up as that call's result instead of an unhandled rejection.
function startAgentCall(root, convId, c, depth, s, emit, signal, toolDefs, caller = 'the main agent') {
  return (async () => {
    if (!toolDefs.some((t) => t.name === c.name)) throw new Error(`The tool ${c.name} is not enabled. It can be turned on in Settings → Capabilities.`);
    const reg = registry(convId);
    let sub;
    if (c.name === 'delegate_agent') {
      const def = findAgent(c.input.agent);
      if (!def) throw new Error(`Unknown agent "${c.input.agent}". Available: ${agents.list().filter((a) => a.enabled).map((a) => a.id).join(', ')}`);
      const task = String(c.input.task || '').trim(); if (!task) throw new Error('delegate_agent needs a task.');
      if (reg.size >= MAX_AGENTS) throw new Error(`Too many agents in this conversation (${MAX_AGENTS}). Reuse one with message_agent.`);
      sub = { id: 'agent_' + randomUUID().slice(0, 6), def, name: def.name, messages: [{ role: 'user', content: task }], running: false, depth: depth + 1 };
      reg.set(sub.id, sub);
    } else {
      sub = reg.get(String(c.input.id || '').trim());
      if (!sub) throw new Error(`No agent with id "${c.input.id}". Existing agents: ${[...reg.values()].map((x) => `${x.id} (${x.name})`).join(', ') || 'none'}`);
      if (sub.running) throw new Error(`${sub.name} (${sub.id}) is busy right now. Try again after it finishes.`);
      const msg = `Message from ${caller}: ${String(c.input.message || '').trim()}`, last = sub.messages.at(-1);
      if (last?.role === 'user') last.content = [...(Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content }]), { type: 'text', text: msg }];
      else sub.messages.push({ role: 'user', content: msg });
    }
    try {
      const text = await runSub(root, convId, sub, c.id, s, emit, signal);
      persistAgents(root, convId);
      return `[${sub.name} · ${sub.id}]\n${text}\n\n(Send a follow-up with message_agent id=${sub.id}.)`;
    } catch (e) { if (signal.aborted) reg.delete(sub.id); persistAgents(root, convId); throw e; } // a half-finished history can't be resumed
  })().catch((e) => 'ERROR: ' + e.message);
}

async function runSub(root, convId, sub, parentCallId, s, emit, signal) {
  sub.running = true;
  const where = { parentId: parentCallId, agent: sub.name, agentId: sub.id };
  const sc = Object.create(root);               // reads mode/cwd/allow live from the conversation; the agent's own overrides sit on top
  sc.agentId = '';                              // the persona is added from the agent's own definition below
  const model = (sub.def.model && !acp.isGrizzy(sub.def.model) && sub.def.model) || [root.model, s.model].find((m) => m && !acp.isGrizzy(m)) || '';
  let last = '', finished = false, lists = [];
  const gs = agents.gateState([]), limit = Math.min(sub.def.steps || SUB_STEPS, Math.max(1, Number(s.maxSteps) || 40));
  gs.followUp = sub.messages.length > 1;
  try {
    for (let step = 0; step < limit; step++) {
      sc.permissionMode = clampMode(sub.def.permissionMode, store.getConversation(convId).permissionMode);
      lists = [agents.accessOf(agents.get(root.agentId)), agents.accessOf(sub.def)]; // never more than the agent it works for
      const mcpDefs = sc.mode === 'code' ? access.keep(lists, mcp.toolDefs()) : [], route = savings.routeMcp(mcpDefs, s, root);
      const baseDefs = access.keep(lists, [...tools.publicDefs(sc.mode, sc.permissionMode, s, { depth: sub.depth, sub: true }), ...mods.toolDefs(), ...savings.defs(s)]);
      const toolDefs = [...baseDefs, ...mcpDefs, ...savings.routerDefs], sendDefs = [...baseDefs, ...route.defs];
      gs.can = new Set(toolDefs.map((t) => t.name));
      const system = buildSystem(s, sc) + access.promptBlock(lists) + route.system + agents.blockFor(sub.def) + roster(s, sub.depth, convId) + `\n\nYou are a delegated agent (id ${sub.id}), not the main assistant. Do the task you were given with your tools, then finish with a concise final report: what you did or found, with file paths and line numbers where relevant. Your final message is all the delegating agent sees. Other agents may message you; answer briefly.`;
      const res = await llm.stream({ ...s, ...models.route(s, model) }, { system, messages: sub.messages, tools: sendDefs }, () => {}, signal);
      const u = res.usage, cu = root.usage || {};
      root.usage = { in: (cu.in || 0) + u.in, out: (cu.out || 0) + u.out, cr: (cu.cr || 0) + (u.cr || 0), cw: (cu.cw || 0) + (u.cw || 0) };
      store.addUsage(u, { model: models.canon(s, model), mode: root.mode, conv: convId, price: models.priceOf(s, model) });
      emit({ type: 'usage', convId, usage: root.usage, last: u, ctx: root.ctx });
      last = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('') || last;
      sub.messages.push({ role: 'assistant', content: res.content });
      const calls = res.content.filter((b) => b.type === 'tool_use');
      if (!calls.length) {
        gs.text = last;
        const nudge = step + 1 < limit ? agents.gate(sub.def, gs) : ''; // not done yet: send it back to work
        if (nudge) { sub.messages.push({ role: 'user', content: nudge }); continue; }
        finished = true; break;
      }
      const runs = new Map();
      for (const c of calls) {
        emit({ type: 'tool_call', convId, id: c.id, name: c.name, input: c.input, ...where });
        if (tools.AGENT_TOOLS.includes(c.name)) runs.set(c.id, startAgentCall(root, convId, c, sub.depth, s, emit, signal, toolDefs, `${sub.name} (${sub.id})`));
      }
      const results = [];
      for (const c of calls) {
        let out;
        try { if (signal.aborted) throw new Error('Cancelled'); out = runs.has(c.id) ? await runs.get(c.id) : await execTool(sc, convId, c, toolDefs, s, emit, signal, sub.name, lists); }
        catch (e) { out = 'ERROR: ' + e.message; }
        if (!/^ERROR/.test(String(out))) gs.calls.push({ name: c.name, input: c.input });
        out = savings.compressOutput(root, c.name, out, s);
        emit({ type: 'tool_result', convId, id: c.id, output: String(out).slice(0, 4000), ...where });
        results.push({ type: 'tool_result', tool_use_id: c.id, content: String(out) });
      }
      sub.messages.push({ role: 'user', content: results });
      if (signal.aborted) throw new Error('Cancelled');
    }
  } finally { sub.running = false; }
  return (last || '(no report)') + (finished ? '' : '\n\n[stopped at the step limit before finishing]');
}

async function send(convId, userText, emit, images = [], opts = {}) {
  const s = store.getSettings({ reveal: true });
  const conv = store.getConversation(convId);
  if (acp.isGrizzy(conv.model || agents.get(conv.agentId)?.model || s.model)) return acp.send(convId, userText, emit, conv.model || agents.get(conv.agentId)?.model || s.model); // Grizzy = the real Claude Code CLI over ACP
  const content = images.length
    ? [...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } })), { type: 'text', text: userText }]
    : userText;
  conv.messages.push({ role: 'user', content });
  if (conv.messages.length === 1) conv.title = opts.title || title(userText || 'Image');
  store.saveConversation(conv);

  const ac = new AbortController();
  active.set(convId, ac);
  emit({ type: 'start', convId, title: conv.title });
  const turnId = randomUUID(), t0 = Date.now(); let lastText = '', aborted = false;
  const gs = agents.gateState([]);
  mods.setSession({ convId, cwd: conv.cwd || '' });
  await mods.turnStart({ text: userText, turnId });
  try {
    const maxSteps = Math.max(1, Math.min(200, Number(s.maxSteps) || 40));
    for (let turn = 0; turn < maxSteps; turn++) {
      const live = store.getConversation(convId); // pick up mode/allow changes made mid-run
      conv.permissionMode = live.permissionMode; conv.allow = live.allow; conv.model = live.model; conv.agentId = live.agentId;
      conv.pinned = live.pinned;
      const mstr0 = conv.model || agents.get(conv.agentId)?.model || s.model;
      if (s.saveCompact) { // fold old turns into a summary when the context is getting full
        const ratio = conv.ctx?.used ? conv.ctx.used / (conv.ctx.max || 200000) : 0;
        const r = await savings.compact(conv, s, summarizer(s, mstr0, convId, conv.mode, ac.signal), { usedRatio: ratio });
        if (r.compacted) { conv.ctx = null; store.saveConversation(conv); emit({ type: 'info', convId, text: `Compacted ${r.compacted} earlier messages into a summary (about ${r.tokensSaved.toLocaleString('en-US')} tokens saved). Pinned facts were kept.` }); }
      }
      const lists = [agents.accessOf(agents.get(conv.agentId))];
      const mcpDefs = conv.mode === 'code' ? access.keep(lists, mcp.toolDefs()) : [], route = savings.routeMcp(mcpDefs, s, conv);
      const baseDefs = access.keep(lists, [...tools.publicDefs(conv.mode, conv.permissionMode, s), ...mods.toolDefs(), ...savings.defs(s)]);
      const toolDefs = [...baseDefs, ...mcpDefs, ...savings.routerDefs];   // everything a call may name
      const sendDefs = [...baseDefs, ...route.defs];                       // what the model is shown
      const sections = await mods.promptCompose(mstr0);
      const system = buildSystem(s, conv) + access.promptBlock(lists) + route.system + roster(s, 0, convId) + sections.map((x) => '\n\n' + x.text).join('');
      let res, llmErr = null;
      await mods.turnStep({ turnId, index: turn, model: mstr0, messageCount: conv.messages.length }, async () => {
        try { res = await llm.stream({ ...s, ...models.route(s, mstr0) }, { system, messages: conv.messages, tools: sendDefs }, (d) => emit({ type: 'text', convId, delta: d }), ac.signal); return { input_tokens: res.usage.in, output_tokens: res.usage.out, cache_read_input_tokens: res.usage.cr || 0, cache_creation_input_tokens: res.usage.cw || 0 }; }
        catch (e) { llmErr = e; return null; }
      });
      if (llmErr) throw llmErr;
      lastText = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('') || lastText;
      conv.messages.push({ role: 'assistant', content: res.content });
      const mstr = mstr0, u = res.usage, cu = conv.usage || {};
      conv.usage = { in: (cu.in || 0) + u.in, out: (cu.out || 0) + u.out, cr: (cu.cr || 0) + (u.cr || 0), cw: (cu.cw || 0) + (u.cw || 0) };
      conv.ctx = { used: u.in + (u.cr || 0) + (u.cw || 0), max: models.contextWindow(s, mstr) || null, model: mstr, at: Date.now() };
      store.addUsage(u, { model: models.canon(s, mstr), mode: conv.mode, conv: convId, price: models.priceOf(s, mstr) });
      store.saveConversation(conv);
      emit({ type: 'usage', convId, usage: conv.usage, last: u, ctx: conv.ctx });
      const calls = res.content.filter((b) => b.type === 'tool_use');
      if (!calls.length) {
        const adef = agents.get(conv.agentId); gs.text = lastText; gs.can = new Set(toolDefs.map((t) => t.name));
        const nudge = adef && adef.enabled && turn + 1 < maxSteps ? agents.gate(adef, gs) : ''; // the chosen agent's completion gates
        if (nudge) { conv.messages.push({ role: 'user', content: nudge }); store.saveConversation(conv); continue; }
        break;
      }
      const results = [], agentRuns = new Map();
      // Agent calls start together so several delegated agents work in parallel; their reports are collected in call order below.
      for (const c of calls) if (tools.AGENT_TOOLS.includes(c.name)) { emit({ type: 'tool_call', convId, id: c.id, name: c.name, input: c.input }); agentRuns.set(c.id, startAgentCall(conv, convId, c, 0, s, emit, ac.signal, toolDefs)); }
      for (const c of calls) {
        if (!agentRuns.has(c.id)) emit({ type: 'tool_call', convId, id: c.id, name: c.name, input: c.input });
        let out;
        try {
          if (ac.signal.aborted) throw new Error('Cancelled');
          if (c.name === 'exit_plan_mode') {
            const d = await ask(emit, convId, c, { plan: true });
            if (d === 'approve') { conv.permissionMode = 'acceptEdits'; const l = store.getConversation(convId); l.permissionMode = 'acceptEdits'; store.saveConversation(l); emit({ type: 'mode', convId, permissionMode: 'acceptEdits' }); out = 'Plan approved. Permission mode is now Accept edits. Proceed with the implementation.'; }
            else out = 'The user wants to keep planning. Revise the plan based on their feedback.';
          } else if (agentRuns.has(c.id)) out = await agentRuns.get(c.id);
          else out = await execTool(conv, convId, c, toolDefs, s, emit, ac.signal);
        } catch (e) { out = 'ERROR: ' + e.message; }
        agentRuns.delete(c.id);
        if (!/^ERROR/.test(String(out))) gs.calls.push({ name: c.name, input: c.input });
        out = savings.compressOutput(conv, c.name, out, s);
        emit({ type: 'tool_result', convId, id: c.id, output: String(out).slice(0, 4000) });
        results.push({ type: 'tool_result', tool_use_id: c.id, content: String(out) });
      }
      conv.messages.push({ role: 'user', content: results });
      store.saveConversation(conv);
      if (ac.signal.aborted) break;
    }
    emit({ type: 'done', convId });
  } catch (e) {
    aborted = ac.signal.aborted;
    emit({ type: ac.signal.aborted ? 'done' : 'error', convId, message: e.message });
  } finally {
    active.delete(convId);
    mods.turnComplete({ answer: lastText, durationMs: Date.now() - t0, isAborted: aborted || ac.signal.aborted, turnId, reason: aborted || ac.signal.aborted ? 'aborted' : 'answer' }).catch(() => {});
    // re-read so concurrent permission/allow edits are not clobbered
    const l = store.getConversation(convId); l.messages = conv.messages; l.usage = conv.usage; l.ctx = conv.ctx; l.savings = conv.savings; l.title = conv.title; store.saveConversation(l);
  }
}

function ask(emit, convId, call, extra = {}) {
  return new Promise((resolve) => {
    const id = randomUUID();
    approvals.set(id, resolve);
    emit({ type: 'approval', convId, approvalId: id, name: call.name, input: call.input, ...extra });
  });
}
const answer = (id, decision) => { if (acp.answer(id, decision)) return; approvals.get(id)?.(decision); approvals.delete(id); };
const stop = (convId) => { acp.stop(convId); active.get(convId)?.abort(); for (const [id, r] of approvals) { r('deny'); approvals.delete(id); } };
const isRunning = (convId) => active.has(convId) || acp.isRunning(convId);

module.exports = { send, stop, answer, isRunning, decide, compactNow, __test: { clampMode, forgetAgents: () => registries.clear() } };
