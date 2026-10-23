// Token savers, built in: (1) an MCP tool router that sends a short catalog instead of every tool schema,
// (2) compression of oversized tool output (the original is kept locally and the model can fetch it back),
// (3) compaction of old conversation turns into a summary, with pinned facts that always survive,
// and the running tally of what each one saved. Token figures are estimates (about 4 characters per token).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const tok = (x) => Math.ceil((typeof x === 'string' ? x : JSON.stringify(x ?? '')).length / 4);
const on = (s, k, d) => (s[k] === undefined ? d : !!s[k]);
const num = (s, k, d, lo, hi) => { const v = Number(s[k]); return Number.isFinite(v) && v > 0 ? Math.max(lo, Math.min(hi, v)) : d; };

// ---------- stats ----------
const statsFile = () => path.join(store.root(), 'savings.json');
const EMPTY = () => ({ router: 0, outputs: 0, compact: 0, routerRequests: 0, outputsCompressed: 0, compactions: 0, since: Date.now() });
function totals() { try { return { ...EMPTY(), ...JSON.parse(fs.readFileSync(statsFile(), 'utf8')) }; } catch { return EMPTY(); } }
function resetStats() { fs.mkdirSync(store.root(), { recursive: true }); fs.writeFileSync(statsFile(), JSON.stringify(EMPTY())); return totals(); }
// conv.savings is the per-conversation tally; `conv` is the object the caller later saves.
function record(conv, kind, tokens, countKey) {
  if (!(tokens > 0)) return;
  const t = totals(); t[kind] += tokens; if (countKey) t[countKey] += 1;
  try { fs.mkdirSync(store.root(), { recursive: true }); fs.writeFileSync(statsFile(), JSON.stringify(t)); } catch {}
  if (conv) { const c = (conv.savings ||= { router: 0, outputs: 0, compact: 0 }); c[kind] = (c[kind] || 0) + tokens; }
}
const stats = (conv) => ({ total: totals(), conversation: conv?.savings || { router: 0, outputs: 0, compact: 0 } });

// ---------- 1. MCP tool router ----------
const ROUTER_MIN_TOOLS = 6; // below this the catalog saves nothing worth the extra hop
const routerDefs = [
  { name: 'mcp_tools', description: 'Look up connector (MCP) tools. With no arguments lists every connector and its tools. With "server" lists that server\'s tools; add "tools" (names) to get their full parameter schemas. Call this before mcp_invoke when you do not know a tool\'s parameters.',
    input_schema: { type: 'object', properties: { server: { type: 'string' }, tools: { type: 'array', items: { type: 'string' } } } } },
  { name: 'mcp_invoke', description: 'Call a connector tool by its name from the catalog (for example "github__list_issues" or "mcp__github__list_issues") with its input object.',
    input_schema: { type: 'object', properties: { tool: { type: 'string' }, input: { type: 'object' } }, required: ['tool'] } },
];
const split = (full) => { const [, server, ...rest] = String(full).split('__'); return { server, tool: rest.join('__') }; };
function catalog(mcpDefs) {
  const by = new Map();
  for (const d of mcpDefs) { const { server, tool } = split(d.name); (by.get(server) || by.set(server, []).get(server)).push([tool, String(d.description || '').replace(/^\[[^\]]*\]\s*/, '').replace(/\s+/g, ' ').slice(0, 70)]); }
  return '\n\nConnector (MCP) tools are not listed individually to save context. Use mcp_tools to see parameter schemas and mcp_invoke to call one. Catalog:\n' +
    [...by].map(([srv, ts]) => `- ${srv}: ${ts.map(([n, d]) => (d ? `${n} (${d})` : n)).join('; ')}`).join('\n');
}
// -> { defs: tool definitions to send, exec: the full list used to validate a call, system: text to add, active }
function routeMcp(mcpDefs, s, conv) {
  if (!on(s, 'saveRouter', true) || mcpDefs.length < ROUTER_MIN_TOOLS) return { defs: mcpDefs, extra: [], system: '', active: false };
  const system = catalog(mcpDefs);
  const saved = tok(mcpDefs) - tok(routerDefs) - tok(system);
  if (saved <= 0) return { defs: mcpDefs, extra: [], system: '', active: false };
  record(conv, 'router', saved, 'routerRequests');
  return { defs: routerDefs, extra: [], system, active: true };
}
// What mcp_tools returns.
function describeTools(mcpDefs, input = {}) {
  const server = String(input.server || '').trim(), want = Array.isArray(input.tools) ? input.tools.map(String) : [];
  const rows = mcpDefs.map((d) => ({ ...split(d.name), d })).filter((r) => !server || r.server === server);
  if (server && !rows.length) return `ERROR: no connector named "${server}". Connectors: ${[...new Set(mcpDefs.map((d) => split(d.name).server))].join(', ')}`;
  if (!want.length) return rows.map((r) => `${r.server}__${r.tool}: ${String(r.d.description || '').replace(/^\[[^\]]*\]\s*/, '').slice(0, 200)}`).join('\n') || 'No connector tools are available.';
  const pick = rows.filter((r) => want.some((w) => w === r.tool || w === `${r.server}__${r.tool}` || w === r.d.name));
  if (!pick.length) return `ERROR: none of those tools exist${server ? ` on ${server}` : ''}. Call mcp_tools without "tools" to list them.`;
  return pick.map((r) => JSON.stringify({ tool: r.d.name, description: r.d.description, input_schema: r.d.input_schema }, null, 1)).join('\n\n');
}
// mcp_invoke -> the call it stands for (so permissions, approval cards and mods see the real tool). Returns null if it is not a router call.
function unwrapInvoke(call, mcpDefs) {
  if (call.name !== 'mcp_invoke') return null;
  const t = String(call.input?.tool || '').trim();
  const real = mcpDefs.find((d) => d.name === t || d.name === `mcp__${t}` || d.name.replace(/^mcp__/, '') === t);
  if (!real) throw new Error(`Unknown connector tool "${t}". Call mcp_tools to list the tools.`);
  return { ...call, name: real.name, input: call.input?.input && typeof call.input.input === 'object' ? call.input.input : {} };
}

// ---------- 2. Output compression ----------
const outDir = () => path.join(store.root(), 'outputs');
const retrieveDef = { name: 'retrieve_output', description: 'Read back a tool output that was compressed to save context. Give the id from the note; optionally "pattern" (regex, returns matching lines with context), or "offset"/"limit" (1-based line range).',
  input_schema: { type: 'object', properties: { id: { type: 'string' }, pattern: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, required: ['id'] } };
const EXEMPT = new Set(['read_file', 'retrieve_output', 'mcp_tools', 'delegate_agent', 'message_agent', 'exit_plan_mode', 'use_skill', 'pin_fact', 'save_memory', 'write_file', 'edit_file']);
const SIGNAL = /\b(error|errors|fail|failed|failure|fatal|exception|panic|traceback|warn|warning|denied|refused|timeout|timed out|cannot|undefined|not found)\b/i;

function dedupeLines(lines) {
  const out = []; let prev = null, n = 0;
  const flush = () => { if (prev !== null) out.push(n > 1 ? `${prev}  [×${n}]` : prev); };
  for (const l of lines) { if (l === prev) n++; else { flush(); prev = l; n = 1; } }
  flush(); return out;
}
function crushJson(v, depth = 0) {
  if (Array.isArray(v)) { const keep = v.slice(0, 5).map((x) => crushJson(x, depth + 1)); return v.length > 5 ? [...keep, `… ${v.length - 5} more items`] : keep; }
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = depth > 6 ? '…' : crushJson(x, depth + 1); return o; }
  if (typeof v === 'string' && v.length > 300) return v.slice(0, 280) + `…[+${v.length - 280} chars]`;
  return v;
}
function crushText(text, target) {
  let lines = dedupeLines(text.split('\n').map((l) => (l.length > 400 ? l.slice(0, 380) + `…[+${l.length - 380} chars]` : l)));
  let joined = lines.join('\n'); if (joined.length <= target) return joined;
  const headN = Math.max(10, Math.floor(target / 160)), tailN = Math.max(10, Math.floor(target / 240));
  const head = lines.slice(0, headN), tail = lines.slice(-tailN), mid = lines.slice(headN, Math.max(headN, lines.length - tailN));
  let budget = Math.floor(target * 0.35); const sig = [];
  for (const l of mid) { if (SIGNAL.test(l) && budget > 0) { sig.push(l); budget -= l.length + 1; } }
  const skipped = mid.length - sig.length;
  return [...head, `… [${skipped} lines omitted${sig.length ? '; lines that look like errors or warnings kept below' : ''}] …`, ...sig, ...(sig.length ? ['… [end of kept lines] …'] : []), ...tail].join('\n');
}
function keep(id, text) {
  fs.mkdirSync(outDir(), { recursive: true }); fs.writeFileSync(path.join(outDir(), id + '.txt'), text);
  try { // keep the newest 300 and nothing older than 14 days
    const files = fs.readdirSync(outDir()).filter((f) => f.endsWith('.txt')).map((f) => ({ f, t: fs.statSync(path.join(outDir(), f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const x of files.slice(300)) fs.rmSync(path.join(outDir(), x.f), { force: true });
    for (const x of files) if (Date.now() - x.t > 14 * 86400000) fs.rmSync(path.join(outDir(), x.f), { force: true });
  } catch {}
}
// Returns the text the model should see. Short outputs, errors and exempt tools pass through unchanged.
function compressOutput(conv, name, out, s) {
  const text = String(out ?? '');
  const limit = num(s, 'saveOutputChars', 12000, 2000, 200000);
  if (!on(s, 'saveOutputs', true) || EXEMPT.has(name) || text.length <= limit) return text;
  const target = Math.min(5000, Math.floor(limit / 2));
  let body = null;
  const t = text.trim();
  if (/^[[{]/.test(t)) { try { body = JSON.stringify(crushJson(JSON.parse(t)), null, 1); if (body.length > target * 1.5) body = null; } catch { body = null; } }
  if (body === null) body = crushText(text, target);
  const id = 'out_' + crypto.randomBytes(4).toString('hex');
  const note = `\n\n[Output compressed: ${text.length.toLocaleString('en-US')} → ${body.length.toLocaleString('en-US')} characters to save context. Full text saved as ${id}; call retrieve_output with id "${id}" (optionally "pattern", or "offset" and "limit" lines) to read more.]`;
  if (body.length + note.length >= text.length) return text;
  try { keep(id, text); } catch { return text; } // never hide output we could not save
  record(conv, 'outputs', tok(text) - tok(body + note), 'outputsCompressed');
  return body + note;
}
function retrieve(input = {}) {
  const id = String(input.id || '').trim();
  if (!/^out_[0-9a-f]{8}$/.test(id)) return 'ERROR: that is not a saved output id.';
  let text; try { text = fs.readFileSync(path.join(outDir(), id + '.txt'), 'utf8'); } catch { return 'ERROR: that output is no longer available (saved outputs are kept for up to 14 days).'; }
  const lines = text.split('\n');
  if (input.pattern) {
    let re; try { re = new RegExp(String(input.pattern), 'i'); } catch { return 'ERROR: the pattern is not a valid regular expression.'; }
    const hits = []; lines.forEach((l, i) => { if (re.test(l)) hits.push(i); });
    if (!hits.length) return `No lines match /${input.pattern}/ (${lines.length} lines in total).`;
    const shown = new Set(); for (const i of hits.slice(0, 60)) for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) shown.add(j);
    let o = '', last = -2; for (const j of [...shown].sort((a, b) => a - b)) { if (j !== last + 1) o += '--\n'; o += `${j + 1}: ${lines[j]}\n`; last = j; }
    return `${hits.length} matching line(s)${hits.length > 60 ? ' (first 60 shown)' : ''}:\n${o}`.slice(0, 30000);
  }
  const off = Math.max(1, Number(input.offset) || 1), lim = Math.max(1, Math.min(2000, Number(input.limit) || 300));
  const part = lines.slice(off - 1, off - 1 + lim).join('\n');
  return `${part.length > 30000 ? part.slice(0, 30000) + '\n…[truncated]' : part}\n\n[lines ${off}–${Math.min(lines.length, off + lim - 1)} of ${lines.length}]`;
}

// ---------- 3. Pinned facts and history compaction ----------
const pinDef = { name: 'pin_fact', description: 'Pin one short fact that must survive conversation compaction (a decision, a constraint, an id, a path, a user preference for this task). Use sparingly.',
  input_schema: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] } };
const MAX_PINS = 40;
function pins(convId) { try { return store.getConversation(convId).pinned || []; } catch { return []; } }
function pin(convId, fact) {
  fact = String(fact || '').replace(/\s+/g, ' ').trim().slice(0, 400); if (!fact) return { error: 'Nothing to pin.' };
  const c = store.getConversation(convId); const l = c.pinned || [];
  if (l.some((x) => x.toLowerCase() === fact.toLowerCase())) return { ok: true, pinned: l, duplicate: true };
  if (l.length >= MAX_PINS) return { error: `You can pin up to ${MAX_PINS} facts. Unpin one first.` };
  c.pinned = [...l, fact]; store.saveConversation(c); return { ok: true, pinned: c.pinned };
}
function unpin(convId, index) { const c = store.getConversation(convId); const l = [...(c.pinned || [])]; if (!(index >= 0 && index < l.length)) return { error: 'No such pinned fact.' }; l.splice(index, 1); c.pinned = l; store.saveConversation(c); return { ok: true, pinned: l }; }
const pinBlock = (list) => (list && list.length ? '\n\nPinned facts (always true for this conversation; never contradict or drop them):\n' + list.map((f) => `- ${f}`).join('\n') : '');

const SUMMARY_TAG = '[Summary of the earlier conversation';
const isSummary = (m) => m && m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(SUMMARY_TAG);
const hasToolResult = (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result');
const msgTokens = (msgs) => tok(msgs.map((m) => (typeof m.content === 'string' ? m.content : m.content.map((b) => (b.type === 'image' ? '[image]' : b))))); // images are not counted as text
function transcript(msgs) {
  const lines = [];
  for (const m of msgs) {
    const who = m.role === 'user' ? 'User' : 'Assistant';
    if (typeof m.content === 'string') { lines.push(`${who}: ${m.content.slice(0, 6000)}`); continue; }
    for (const b of m.content) {
      if (b.type === 'text') lines.push(`${who}: ${b.text.slice(0, 6000)}`);
      else if (b.type === 'tool_use') lines.push(`[tool ${b.name} ${JSON.stringify(b.input).slice(0, 400)}]`);
      else if (b.type === 'tool_result') lines.push(`[result ${String(b.content).slice(0, 500)}]`);
      else if (b.type === 'image') lines.push('[image]');
    }
  }
  const t = lines.join('\n\n'); return t.length > 240000 ? '…\n' + t.slice(-240000) : t;
}
// Index of the first message to keep: at least `keepRecent` from the end, starting at a user message that is not a tool result.
function cutPoint(msgs, keepRecent) {
  for (let i = Math.max(1, msgs.length - keepRecent); i < msgs.length; i++) if (msgs[i].role === 'user' && !hasToolResult(msgs[i]) && !isSummary(msgs[i])) return i;
  return -1;
}
// summarize(prompt) -> text. Mutates conv.messages. Returns { compacted, before, after, tokensSaved } or { skipped: reason }.
async function compact(conv, s, summarize, { force = false, usedRatio = 0 } = {}) {
  const keepRecent = num(s, 'compactKeep', 8, 2, 40);
  if (!force && (!on(s, 'saveCompact', false) || usedRatio < num(s, 'compactAtPct', 60, 20, 95) / 100)) return { skipped: 'below threshold' };
  const msgs = conv.messages; const cut = cutPoint(msgs, keepRecent);
  if (cut < 3) return { skipped: 'not enough earlier conversation' };
  const older = msgs.slice(0, cut), tail = msgs.slice(cut);
  const before = msgTokens(older);
  if (before < 1500 && !force) return { skipped: 'earlier conversation is already small' };
  const prior = isSummary(older[0]) ? older[0].content : '';
  const prompt = `You are compacting a long conversation so it can continue with less context. Write a dense summary of the EARLIER part below that lets the assistant carry on without rereading it.\n\nKeep: the user's goals and constraints, decisions made and why, current state of the work, files/paths/commands/ids that matter, errors hit and how they were resolved, open questions and the next step. Drop: pleasantries, dead ends that did not matter, raw tool output.\n${(conv.pinned || []).length ? `\nThese facts are pinned and are added separately; do not repeat them:\n${conv.pinned.map((f) => `- ${f}`).join('\n')}\n` : ''}${prior ? `\nPrevious summary to fold in:\n${prior}\n` : ''}\n<earlier_conversation>\n${transcript(prior ? older.slice(1) : older)}\n</earlier_conversation>\n\nReply with the summary only, as plain text or short bullet lists, under 700 words.`;
  let text = ''; try { text = String(await summarize(prompt) || '').trim(); } catch (e) { return { skipped: 'summary failed: ' + e.message }; }
  if (text.length < 40) return { skipped: 'the summary came back empty' };
  try { fs.mkdirSync(outDir(), { recursive: true }); fs.writeFileSync(path.join(outDir(), `compact-${conv.id}-${Date.now()}.json`), JSON.stringify(older)); } catch {}
  conv.messages = [{ role: 'user', content: `${SUMMARY_TAG}, written by GrizzyCode to save context. Treat it as what happened so far.]\n\n${text}` }, { role: 'assistant', content: 'Understood. I have the summary of the earlier conversation and will continue from it.' }, ...tail];
  const after = msgTokens(conv.messages.slice(0, 2)); const saved = before - after;
  record(conv, 'compact', saved, 'compactions');
  return { compacted: older.length, before, after, tokensSaved: saved };
}

// Tools offered to the model: reading back compressed output (only when compression is on) and pinning facts.
const defs = (s) => [...(on(s, 'saveOutputs', true) ? [retrieveDef] : []), pinDef];
module.exports = { tok, record, stats, totals, resetStats, routeMcp, describeTools, unwrapInvoke, routerDefs, compressOutput, retrieve, retrieveDef, pinDef, pin, unpin, pins, pinBlock, compact, isSummary, cutPoint, defs, ROUTER_MIN_TOOLS };
