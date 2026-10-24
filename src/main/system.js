// Small OS-facing helpers behind the notification, dock, memory, event-log and search APIs. Electron objects are passed in, so each one
// can be tested without a window.
const os = require('os');
const logger = require('./logger');

// Memory pressure from free vs total RAM (macOS reports a large "free" figure only when it is truly unused, so this errs on the calm side).
function memoryLevel(free = os.freemem(), total = os.totalmem()) {
  const r = total ? free / total : 1;
  return r < 0.04 ? 'critical' : r < 0.1 ? 'warn' : 'none';
}

// Notifications at a chosen time. `show(title, body, id)` does the displaying; timers are dropped when cancelled or replaced.
function scheduler(show) {
  const timers = new Map();
  return {
    schedule(id, title, body, when) {
      id = String(id || ''); const at = when instanceof Date ? +when : Number(when);
      if (!id || !Number.isFinite(at)) return { ok: false, error: 'Needs an id and a time.' };
      clearTimeout(timers.get(id));
      const t = setTimeout(() => { timers.delete(id); show(String(title || 'GrizzyCode'), String(body || ''), id); }, Math.min(Math.max(0, at - Date.now()), 2 ** 31 - 1));
      t.unref?.(); timers.set(id, t); return { ok: true };
    },
    cancel(id) { const had = timers.has(String(id)); clearTimeout(timers.get(String(id))); timers.delete(String(id)); return had; },
    pending: () => timers.size,
    clear() { for (const t of timers.values()) clearTimeout(t); timers.clear(); },
  };
}

// Messages (not just titles) that contain the query, newest conversations first, optionally within one conversation.
function searchMessages(store, query, convId, limit = 50) {
  const q = String(query || '').trim().toLowerCase(); if (!q) return { results: [] };
  const flat = (m) => (typeof m.content === 'string' ? m.content : (m.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' '));
  const out = [];
  for (const meta of store.listConversations().sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (convId && meta.id !== convId) continue;
    let c; try { c = store.getConversation(meta.id); } catch { continue; }
    for (let i = 0; i < c.messages.length && out.length < limit; i++) {
      const t = flat(c.messages[i]), at = t.toLowerCase().indexOf(q);
      if (at >= 0) out.push({ convId: meta.id, title: meta.title, index: i, role: c.messages[i].role, snippet: t.slice(Math.max(0, at - 40), at + q.length + 80).replace(/\s+/g, ' ') });
    }
    if (out.length >= limit) break;
  }
  return { results: out };
}

// Local-only event log (Settings → Developer → logs). Nothing leaves the machine; values are scrubbed like every other log.
const logEvent = (entry) => { try { logger.append('events.log', logger.scrub(JSON.stringify(entry).slice(0, 2000))); return true; } catch { return false; } };

module.exports = { memoryLevel, scheduler, searchMessages, logEvent };
