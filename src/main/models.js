// Model catalog and routing across providers.
// A model string is bare (the default endpoint from Settings) or "<providerId>:<model>", which routes that request to that
// provider with its own base URL and key. Provider ids are the built-ins (anthropic, openrouter, openai, …) or custom ones.
const store = require('./store');
const providers = require('./providers');
const acp = require('./acp');

// Context window for a model: from the provider's own list when known, else a conservative guess for Claude ids.
const guessCtx = (id) => (/claude/i.test(id) ? 200000 : 0);

function split(s, m) { // -> { id, model } when m is "<known provider>:<model>", else null
  const i = String(m || '').indexOf(':'); if (i < 1) return null;
  const id = m.slice(0, i); return providers.get(id, s) ? { id, model: m.slice(i + 1) } : null;
}
// Bare ids that belong to a known default provider become explicit so the same model never appears twice.
function canon(s, m) {
  if (!m) return m;
  if (split(s, m)) return m;
  const d = store.defaultProviderId(s);
  return d === 'custom' ? m : `${d}:${m}`;
}

// -> fields to merge over the settings object for llm.stream. `s` must be the revealed settings.
function route(s, m) {
  const c = canon(s, m || s.model);
  const sp = split(s, c);
  if (!sp) return { model: c };
  const p = providers.get(sp.id, s);
  if (!p.enabled) throw new Error(`${p.name} is turned off. Turn it on in Settings → Providers to use ${sp.model}.`);
  const key = s.keys?.[sp.id] || '';
  if (p.needsKey && !key) throw new Error(`No ${p.name} key saved. Add one in Settings → Providers to use ${sp.model}.`);
  const kk = store.keyKind(key);
  if (sp.id === 'anthropic' && kk === 'openrouter') throw new Error('The saved Anthropic key is actually an OpenRouter key. Pick an OpenRouter model, or add an Anthropic key in Settings → Providers.');
  if (sp.id === 'openrouter' && kk === 'anthropic') throw new Error('The saved OpenRouter key is actually an Anthropic key. Add an OpenRouter key in Settings → Providers.');
  return { provider: p.type, baseUrl: p.baseUrl, apiKey: key, keyless: !key, model: sp.model };
}

// Groups for the model picker: every provider that is turned on. Providers still missing a key are listed with a note.
async function catalog({ force = false } = {}) {
  const s = store.getSettings({ reveal: true });
  const groups = [];
  const d = store.defaultProviderId(s);
  for (const p of providers.list(s)) {
    if (!p.enabled) continue;
    const key = s.keys?.[p.id] || '';
    const r = await providers.fetchModels(p, key, { force });
    const missingKey = p.needsKey && !key;
    // when this provider is the default endpoint, keep the user's own picker list first
    const own = d === p.id ? (s.models || []) : [];
    const known = new Map(r.models.map((m) => [m.id, m]));
    const ids = [...new Set([...own, ...r.models.map((m) => m.id)])];
    groups.push({
      id: p.id, label: p.name, hasKey: !!key, needsKey: p.needsKey, note: missingKey ? 'Add an API key in Settings → Providers to use these models.' : undefined,
      error: missingKey ? undefined : r.error,
      models: ids.map((id) => { const m = known.get(id); return { value: `${p.id}:${id}`, id, name: m?.name || id, ctx: m?.ctx || providers.infoOf(`${p.id}:${id}`)?.ctx || guessCtx(id) }; }),
    });
  }
  if (d === 'custom') {
    const ids = [...new Set([s.model, ...(s.models || [])].filter(Boolean))];
    groups.push({ id: 'custom', label: 'Custom endpoint', hasKey: !!s.apiKey, models: ids.map((id) => ({ value: id, id, name: id })) });
  }
  const grizzy = acp.catalogGroup();
  // Grizzy runs Claude models, so offer the same list as Anthropic (live when a key is saved) after its own default.
  const anth = groups.find((g) => g.id === 'anthropic');
  if (anth?.models.length) grizzy.models = [grizzy.models[0], ...anth.models.map((m) => ({ ...m, value: acp.PREFIX + m.id, name: `${acp.NAME} · ${m.name}` }))];
  groups.unshift(grizzy);
  return { groups, current: canon(s, s.model) };
}

function contextWindow(s, m) { const c = canon(s, m || s.model); return providers.infoOf(c)?.ctx || guessCtx(c.replace(/^[a-z0-9-]+:/, '')) || 0; }
// Provider-reported price per token for this model (OpenRouter and similar), or null.
function priceOf(s, m) { const p = providers.infoOf(canon(s, m || s.model))?.price; return p && (p.in || p.out) ? p : null; }

module.exports = { canon, route, catalog, contextWindow, priceOf };
