// Local memory: short facts the user (or the model, when allowed) saves; injected into the system prompt.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const file = () => path.join(store.root(), 'memory.json');
const MAX = 200, MAX_LEN = 600;
function list() { try { const l = JSON.parse(fs.readFileSync(file(), 'utf8')); return Array.isArray(l) ? l : []; } catch { return []; } }
const write = (l) => { fs.mkdirSync(store.root(), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(l, null, 2)); return l; };

function add(text, source = 'user') {
  text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);
  if (!text) return { error: 'Nothing to remember.' };
  const l = list();
  const dup = l.find((m) => m.text.toLowerCase() === text.toLowerCase());
  if (dup) return { ok: true, memory: dup, duplicate: true };
  const m = { id: crypto.randomUUID(), text, source, createdAt: Date.now() };
  l.push(m); if (l.length > MAX) l.splice(0, l.length - MAX);
  write(l); return { ok: true, memory: m };
}
function update(id, text) {
  text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);
  if (!text) return { error: 'A memory cannot be empty.' };
  const l = list(); const m = l.find((x) => x.id === id); if (!m) return { error: 'Memory not found.' };
  m.text = text; m.updatedAt = Date.now(); write(l); return { ok: true, memory: m };
}
const remove = (id) => write(list().filter((m) => m.id !== id));
const clear = () => write([]);

// Text appended to the system prompt, or '' when memory is off or empty.
function promptBlock(settings) {
  if (!settings.memoryEnabled) return '';
  const l = list().slice(-60); if (!l.length) return '';
  return '\n\nThings you remember about the user (from saved memory; use them when relevant, do not mention them unless it helps):\n' + l.map((m) => `- ${m.text}`).join('\n');
}
module.exports = { list, add, update, remove, clear, promptBlock };
