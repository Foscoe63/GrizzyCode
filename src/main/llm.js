// Streaming adapters. Internal message format = Anthropic content blocks:
//  {role, content: string | [{type:'text'|'tool_use'|'tool_result', ...}]}
async function* sse(res) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (data && data !== '[DONE]') { try { yield JSON.parse(data); } catch {} }
    }
  }
}

async function failIfBad(res) {
  if (res.ok) return;
  let t = ''; try { t = await res.text(); } catch {}
  const hint = res.status === 401 || res.status === 403 ? ' — the provider rejected the API key. Check the key under Settings → Account (a key from a different provider will always fail).' : '';
  throw new Error(`API ${res.status}: ${t.slice(0, 500)}${hint}`);
}

// Prompt caching: mark the system prompt and the newest message as cache breakpoints (never mutates stored messages).
function withCache(system, messages) {
  const out = messages.slice();
  const i = out.length - 1;
  if (i >= 0) {
    const m = out[i];
    const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content.map((b) => ({ ...b }));
    const last = content[content.length - 1];
    if (last && last.type !== 'thinking' && last.type !== 'redacted_thinking') last.cache_control = { type: 'ephemeral' };
    out[i] = { ...m, content };
  }
  return { system: system ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : null, messages: out };
}

async function streamAnthropic(s, { system, messages, tools }, onText, signal) {
  const base = (s.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
  const c = withCache(system, messages);
  const body = { model: s.model, max_tokens: s.maxTokens, ...(c.system ? { system: c.system } : {}), messages: c.messages, stream: true };
  if (tools?.length) body.tools = tools;
  const res = await fetch(base + '/v1/messages', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-api-key': s.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  await failIfBad(res);
  const blocks = []; let stop = null; const usage = { in: 0, out: 0, cr: 0, cw: 0 };
  for await (const ev of sse(res)) {
    if (ev.type === 'message_start') { const u = ev.message?.usage || {}; usage.in = u.input_tokens || 0; usage.cr = u.cache_read_input_tokens || 0; usage.cw = u.cache_creation_input_tokens || 0; }
    else if (ev.type === 'content_block_start') {
      const b = ev.content_block;
      blocks[ev.index] = b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: {}, _json: '' } : { type: 'text', text: '' };
    } else if (ev.type === 'content_block_delta') {
      const b = blocks[ev.index];
      if (ev.delta.type === 'text_delta') { b.text += ev.delta.text; onText(ev.delta.text); }
      else if (ev.delta.type === 'input_json_delta') b._json += ev.delta.partial_json;
    } else if (ev.type === 'message_delta') { stop = ev.delta.stop_reason; usage.out = ev.usage?.output_tokens ?? usage.out; }
    else if (ev.type === 'error') throw new Error(ev.error?.message || 'stream error');
  }
  const content = blocks.filter(Boolean).map((b) => {
    if (b.type === 'tool_use') { try { b.input = b._json ? JSON.parse(b._json) : {}; } catch { b.input = {}; } delete b._json; }
    return b;
  }).filter((b) => b.type !== 'text' || b.text);
  return { content, stop, usage };
}

function toOpenAI(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const calls = m.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } }));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const b of m.content) {
        if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: String(b.content) });
      }
      const parts = m.content.filter((b) => b.type === 'text' || b.type === 'image').map((b) => b.type === 'text'
        ? { type: 'text', text: b.text }
        : { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
      if (parts.length) out.push({ role: 'user', content: parts });
    }
  }
  return out;
}

async function streamOpenAI(s, { system, messages, tools }, onText, signal) {
  const base = (s.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const body = { model: s.model, messages: toOpenAI(system, messages), stream: true, stream_options: { include_usage: true }, max_tokens: s.maxTokens };
  if (tools?.length) body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  const res = await fetch(base + '/chat/completions', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', ...(s.apiKey ? { authorization: 'Bearer ' + s.apiKey } : {}) },
    body: JSON.stringify(body),
  });
  await failIfBad(res);
  let text = ''; const calls = []; let finish = null; const usage = { in: 0, out: 0, cr: 0, cw: 0 };
  for await (const ev of sse(res)) {
    if (ev.usage) {
      const d = ev.usage.prompt_tokens_details || {};
      usage.cr = d.cached_tokens || 0; usage.cw = d.cache_write_tokens || 0;
      usage.in = Math.max(0, (ev.usage.prompt_tokens || 0) - usage.cr - usage.cw); usage.out = ev.usage.completion_tokens || 0;
    }
    const ch = ev.choices?.[0]; if (!ch) continue;
    if (ch.delta?.content) { text += ch.delta.content; onText(ch.delta.content); }
    for (const tc of ch.delta?.tool_calls || []) {
      const c = (calls[tc.index] ||= { id: '', name: '', args: '' });
      if (tc.id) c.id = tc.id;
      if (tc.function?.name) c.name += tc.function.name;
      if (tc.function?.arguments) c.args += tc.function.arguments;
    }
    if (ch.finish_reason) finish = ch.finish_reason;
  }
  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const c of calls.filter(Boolean)) { let input = {}; try { input = JSON.parse(c.args || '{}'); } catch {} content.push({ type: 'tool_use', id: c.id, name: c.name, input }); }
  return { content, stop: calls.length ? 'tool_use' : finish, usage };
}

function stream(settings, req, onText, signal) {
  if (!settings.apiKey && !settings.keyless) throw new Error('No API key set. Open Settings → Providers and add one.');
  return (settings.provider === 'openai' ? streamOpenAI : streamAnthropic)(settings, req, onText, signal);
}

module.exports = { stream, toOpenAI, withCache };
