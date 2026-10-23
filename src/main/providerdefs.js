// Built-in providers. Anything else is a custom provider the user adds (type "openai" = any OpenAI-compatible endpoint).
const OR_BASE = 'https://openrouter.ai/api/v1';
const BUILTINS = [
  { id: 'anthropic', name: 'Anthropic', type: 'anthropic', baseUrl: '', needsKey: true, enabled: true, keyUrl: 'https://console.anthropic.com/settings/keys', fallback: ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] },
  { id: 'openrouter', name: 'OpenRouter', type: 'openai', baseUrl: OR_BASE, needsKey: true, enabled: true, keyUrl: 'https://openrouter.ai/keys', fallback: [] },
  { id: 'openai', name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', needsKey: true, enabled: false, keyUrl: 'https://platform.openai.com/api-keys', fallback: [] },
  { id: 'google', name: 'Google Gemini', type: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', needsKey: true, enabled: false, keyUrl: 'https://aistudio.google.com/apikey', fallback: [] },
  { id: 'groq', name: 'Groq', type: 'openai', baseUrl: 'https://api.groq.com/openai/v1', needsKey: true, enabled: false, keyUrl: 'https://console.groq.com/keys', fallback: [] },
  { id: 'mistral', name: 'Mistral', type: 'openai', baseUrl: 'https://api.mistral.ai/v1', needsKey: true, enabled: false, keyUrl: 'https://console.mistral.ai/api-keys', fallback: [] },
  { id: 'xai', name: 'xAI', type: 'openai', baseUrl: 'https://api.x.ai/v1', needsKey: true, enabled: false, keyUrl: 'https://console.x.ai', fallback: [] },
  { id: 'deepseek', name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com/v1', needsKey: true, enabled: false, keyUrl: 'https://platform.deepseek.com/api_keys', fallback: [] },
  { id: 'ollama', name: 'Ollama (local)', type: 'openai', baseUrl: 'http://localhost:11434/v1', needsKey: false, enabled: false, keyUrl: '', fallback: [] },
  { id: 'lmstudio', name: 'LM Studio (local)', type: 'openai', baseUrl: 'http://localhost:1234/v1', needsKey: false, enabled: false, keyUrl: '', fallback: [] },
];
const norm = (u) => String(u || '').trim().replace(/\/+$/, '').toLowerCase();
// Which built-in provider an endpoint URL belongs to (OpenRouter by host, the rest by exact URL), or null.
function idForBase(url) {
  if (/^https?:\/\/([^/]*\.)?openrouter\.ai(\/|$)/i.test(url || '')) return 'openrouter';
  const n = norm(url); if (!n) return null;
  return BUILTINS.find((b) => b.baseUrl && norm(b.baseUrl) === n)?.id || null;
}
module.exports = { BUILTINS, OR_BASE, idForBase, norm };
