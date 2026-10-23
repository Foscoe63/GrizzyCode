// Design systems: named sets of guidelines and tokens the model follows when building UI.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const file = () => path.join(store.root(), 'design-systems.json');
function list() { try { const l = JSON.parse(fs.readFileSync(file(), 'utf8')); return Array.isArray(l) ? l : []; } catch { return []; } }
const write = (l) => { fs.mkdirSync(store.root(), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(l, null, 2)); return l; };
const HEX = /^#[0-9a-f]{3,8}$/i;

// tokens: { colors: {name: '#hex'}, fonts: {display, body, mono}, radius, spacing } — all optional
function clean(t) {
  const out = {};
  if (t?.colors && typeof t.colors === 'object') out.colors = Object.fromEntries(Object.entries(t.colors).filter(([k, v]) => /^[\w-]{1,32}$/.test(k) && HEX.test(String(v))).slice(0, 40));
  if (t?.fonts && typeof t.fonts === 'object') out.fonts = Object.fromEntries(Object.entries(t.fonts).filter(([k, v]) => /^[\w-]{1,20}$/.test(k) && typeof v === 'string' && v.length < 120));
  for (const k of ['radius', 'spacing']) if (typeof t?.[k] === 'string' && t[k].length < 60) out[k] = t[k];
  return out;
}
function save(p) {
  const name = String(p.name || '').trim().slice(0, 60); if (!name) return { error: 'Give the design system a name.' };
  const l = list(); const rec = { id: p.id || crypto.randomUUID(), name, guidelines: String(p.guidelines || '').slice(0, 12000), tokens: clean(p.tokens), updatedAt: Date.now() };
  const i = l.findIndex((x) => x.id === rec.id); if (i >= 0) l[i] = rec; else l.push(rec);
  write(l); return { ok: true, system: rec, systems: l };
}
function remove(id) {
  const l = write(list().filter((x) => x.id !== id));
  if (store.getSettings().defaultDesignSystem === id) store.saveSettings({ defaultDesignSystem: '' });
  return l;
}
// Accepts markdown/plain text (guidelines) or JSON { name, guidelines, tokens }.
function parseImport(text, fallbackName) {
  try { const j = JSON.parse(text); if (j && typeof j === 'object') return { name: j.name || fallbackName, guidelines: j.guidelines || '', tokens: j.tokens || (j.colors ? { colors: j.colors, fonts: j.fonts } : {}) }; } catch {}
  return { name: fallbackName, guidelines: text, tokens: {} };
}
function promptBlock(settings) {
  const ds = list().find((x) => x.id === settings.defaultDesignSystem); if (!ds) return '';
  const t = ds.tokens || {}; const lines = [];
  if (t.colors) lines.push('Colors: ' + Object.entries(t.colors).map(([k, v]) => `${k} ${v}`).join(', '));
  if (t.fonts) lines.push('Fonts: ' + Object.entries(t.fonts).map(([k, v]) => `${k}: ${v}`).join('; '));
  if (t.radius) lines.push('Corner radius: ' + t.radius); if (t.spacing) lines.push('Spacing scale: ' + t.spacing);
  return `\n\nWhen you design or build user interfaces, follow the design system “${ds.name}”.\n${lines.join('\n')}${ds.guidelines ? '\n' + ds.guidelines : ''}`;
}
module.exports = { list, save, remove, parseImport, promptBlock, clean };
