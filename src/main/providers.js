// Provider registry: built-in providers (with user overrides) plus custom ones. Keys live in the encrypted key store
// under the provider id; everything else is plain settings (settings.providerCfg).
const crypto = require('crypto');
const store = require('./store');
const { BUILTINS } = require('./providerdefs');

const ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
const TTL = 10 * 60 * 1000;
const cache = new Map();
const info = new Map(); // "<id>:<model>" -> { ctx, price }

const cfg = () => { const c = store.getSettings().providerCfg || {}; return { overrides: c.overrides || {}, custom: Array.isArray(c.custom) ? c.custom : [] }; };
const writeCfg = (c) => store.saveSettings({ providerCfg: c });
const cleanUrl = (u) => String(u || '').trim().replace(/\/+$/, '');
const modelList = (m) => [...new Set((Array.isArray(m) ? m : []).map((x) => String(x).trim()).filter(Boolean))].slice(0, 500);

// Merged view, built-ins first. `hasKey` reflects the key store (including a legacy default key).
function list(settings = store.getSettings()) {
  const c = { overrides: settings.providerCfg?.overrides || {}, custom: settings.providerCfg?.custom || [] };
  const has = settings.providerKeys || {};
  const merged = BUILTINS.map((b) => {
    const o = c.overrides[b.id] || {};
    return { id: b.id, builtin: true, name: o.name || b.name, type: b.type, baseUrl: o.baseUrl !== undefined ? o.baseUrl : b.baseUrl, defaultBaseUrl: b.baseUrl, needsKey: b.needsKey, enabled: o.enabled !== undefined ? !!o.enabled : b.enabled, keyUrl: b.keyUrl, defaultModel: o.defaultModel || '', models: modelList(o.models), hasKey: !!has[b.id] };
  });
  for (const p of c.custom) merged.push({ id: p.id, builtin: false, name: p.name, type: p.type === 'anthropic' ? 'anthropic' : 'openai', baseUrl: p.baseUrl || '', defaultBaseUrl: '', needsKey: p.needsKey !== false, enabled: p.enabled !== false, keyUrl: '', defaultModel: p.defaultModel || '', models: modelList(p.models), hasKey: !!has[p.id] });
  return merged;
}
const get = (id, settings) => list(settings).find((p) => p.id === id) || null;

// Create or update. `p.id` absent → new custom provider. Key handling: p.apiKey (string) saves, p.apiKey === '' removes, undefined keeps.
function save(p) {
  const c = cfg(); const name = String(p.name || '').trim().slice(0, 40);
  const url = cleanUrl(p.baseUrl);
  if (url) { try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) throw new Error(); } catch { return { error: 'The base URL must start with http:// or https://.' }; } }
  let id = p.id;
  const builtin = BUILTINS.find((b) => b.id === id);
  if (builtin) {
    const o = { ...(c.overrides[id] || {}) };
    if (p.enabled !== undefined) o.enabled = !!p.enabled;
    if (p.baseUrl !== undefined) { if (url === cleanUrl(builtin.baseUrl)) delete o.baseUrl; else o.baseUrl = url; }
    if (p.defaultModel !== undefined) o.defaultModel = String(p.defaultModel).trim().slice(0, 200);
    if (p.models !== undefined) o.models = modelList(p.models);
    c.overrides[id] = o;
  } else {
    const type = p.type === 'anthropic' ? 'anthropic' : 'openai';
    if (id) {
      const rec = c.custom.find((x) => x.id === id); if (!rec) return { error: 'Provider not found.' };
      if (p.name !== undefined) { if (!name) return { error: 'Give the provider a name.' }; rec.name = name; }
      if (p.baseUrl !== undefined) { if (!url) return { error: 'A custom provider needs a base URL.' }; rec.baseUrl = url; }
      if (p.type !== undefined) rec.type = type; if (p.enabled !== undefined) rec.enabled = !!p.enabled;
      if (p.defaultModel !== undefined) rec.defaultModel = String(p.defaultModel).trim().slice(0, 200);
      if (p.models !== undefined) rec.models = modelList(p.models); if (p.needsKey !== undefined) rec.needsKey = !!p.needsKey;
    } else {
      if (!name) return { error: 'Give the provider a name.' };
      if (!url) return { error: 'Enter the provider’s base URL.' };
      if (list().some((x) => x.name.toLowerCase() === name.toLowerCase())) return { error: `A provider named “${name}” already exists.` };
      let slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'provider';
      if (!/^[a-z]/.test(slug)) slug = 'p-' + slug;
      id = `${slug}-${crypto.randomBytes(2).toString('hex')}`;
      c.custom.push({ id, name, type, baseUrl: url, enabled: p.enabled !== false, needsKey: p.needsKey !== false, defaultModel: String(p.defaultModel || '').trim(), models: modelList(p.models) });
    }
  }
  const patch = { providerCfg: c };
  if (typeof p.apiKey === 'string') patch.keys = { [id]: p.apiKey.trim() };
  store.saveSettings(patch); cache.delete(id);
  return { ok: true, id, providers: list() };
}
function remove(id) {
  if (BUILTINS.some((b) => b.id === id)) return { error: 'Built-in providers can’t be removed. Turn them off instead.' };
  const c = cfg(); c.custom = c.custom.filter((x) => x.id !== id);
  const cur = store.getSettings(); const patch = { providerCfg: c, keys: { [id]: '' } };
  if (String(cur.model).startsWith(id + ':')) patch.model = 'claude-sonnet-5-5';
  store.saveSettings(patch); cache.delete(id); return { ok: true, providers: list() };
}

// ---- model lists ----
async function cached(key, force, fn) { const hit = cache.get(key); if (hit && !force && Date.now() - hit.at < TTL) return hit.value; const value = await fn(); cache.set(key, { at: Date.now(), value }); return value; }
const per = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };

// -> { models: [{ id, name, ctx? }], error? } — live from the provider, then the user's own entries, then built-in fallbacks.
async function fetchModels(p, key, { force = false } = {}) {
  const fallback = (BUILTINS.find((b) => b.id === p.id)?.fallback || []).map((id) => ({ id, name: id }));
  const own = p.models.map((id) => ({ id, name: id }));
  const live = await cached(`${p.id}|${p.baseUrl}|${(key || '').slice(-6)}`, force, async () => {
    try {
      let r, list;
      if (p.type === 'anthropic') {
        if (!key) throw new Error('add an API key to load the live list');
        r = await fetch((p.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/models?limit=100', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        list = ((await r.json()).data || []).map((m) => ({ id: m.id, name: m.display_name || m.id, ctx: m.max_input_tokens || 0 }));
      } else {
        const base = p.baseUrl.replace(/\/$/, '');
        r = await fetch(base + '/models', { headers: key ? { authorization: 'Bearer ' + key } : {}, signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        list = (j.data || j.models || []).map((m) => (typeof m === 'string' ? { id: m, name: m } : { id: String(m.id || m.name || ''), name: m.name || m.display_name || m.id, ctx: m.context_length || m.context_window || m.max_input_tokens || 0, price: m.pricing ? { in: per(m.pricing.prompt), out: per(m.pricing.completion), cr: per(m.pricing.input_cache_read), cw: per(m.pricing.input_cache_write) } : undefined })).filter((m) => m.id);
      }
      if (!list.length) throw new Error('the provider returned no models');
      return { models: list };
    } catch (e) { return { models: [], error: `Could not load the model list (${e.message}).` }; }
  });
  const seen = new Set(), out = [];
  for (const m of [...live.models, ...own, ...(live.models.length ? [] : fallback)]) if (!seen.has(m.id)) { seen.add(m.id); out.push(m); }
  for (const m of out) if (m.ctx || m.price) info.set(`${p.id}:${m.id}`, { ctx: m.ctx, price: m.price });
  return { models: out, error: live.error && !own.length && !fallback.length ? live.error : live.error ? live.error + (fallback.length ? ' Showing known models.' : '') : undefined };
}

// Quick connectivity test: list models if possible, else a 1-token request is not attempted (it would cost money).
async function test(id) {
  const settings = store.getSettings({ reveal: true }); const p = get(id, settings); if (!p) return { ok: false, error: 'Provider not found.' };
  const key = settings.keys?.[id] || '';
  if (p.needsKey && !key) return { ok: false, error: 'Add an API key first.' };
  const r = await fetchModels(p, key, { force: true });
  const live = r.models.length && !r.error;
  return live ? { ok: true, count: r.models.length } : { ok: false, error: r.error || 'No models returned.', models: r.models.length };
}
const infoOf = (value) => info.get(value);
module.exports = { list, get, save, remove, fetchModels, test, infoOf, ID_RE };
