// Import CLI session transcripts (~/.claude/projects/<project>/<session>.jsonl) as GrizzyCode code sessions.
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');

const KEEP = new Set(['text', 'tool_use', 'tool_result', 'image']);

function textOf(m) { return typeof m.content === 'string' ? m.content : (m.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' '); }

function sanitize(msgs) {
  const merged = [];
  for (const m of msgs) {
    const blocks = (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || []).filter((b) => KEEP.has(b.type));
    if (!blocks.length) continue;
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content.push(...blocks); else merged.push({ role: m.role, content: blocks });
  }
  const uses = new Set(), results = new Set();
  merged.forEach((m) => m.content.forEach((b) => { if (b.type === 'tool_use') uses.add(b.id); if (b.type === 'tool_result') results.add(b.tool_use_id); }));
  const out = [];
  for (const m of merged) {
    const c = m.content.filter((b) => (b.type === 'tool_use' ? results.has(b.id) : b.type === 'tool_result' ? uses.has(b.tool_use_id) : true));
    if (!c.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content.push(...c); else out.push({ role: m.role, content: c });
  }
  // tool_result blocks must lead the user message that follows a tool_use
  for (const m of out) if (m.role === 'user') m.content.sort((a, b) => (b.type === 'tool_result') - (a.type === 'tool_result'));
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

function importAll(configDir = path.join(os.homedir(), '.claude')) {
  const root = path.join(configDir, 'projects');
  let imported = 0, skipped = 0;
  let dirs = []; try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return { imported, skipped, none: true }; }
  const have = new Set(store.listConversations(true).map((c) => c.id));
  for (const d of dirs) {
    for (const f of fs.readdirSync(path.join(root, d.name)).filter((x) => x.endsWith('.jsonl'))) {
      const id = 'cli-' + f.replace(/\.jsonl$/, '');
      if (have.has(id)) { skipped++; continue; }
      try {
        const lines = fs.readFileSync(path.join(root, d.name, f), 'utf8').split('\n').filter(Boolean);
        let cwd = null, mtime = fs.statSync(path.join(root, d.name, f)).mtimeMs; const msgs = [];
        for (const l of lines) {
          let e; try { e = JSON.parse(l); } catch { continue; }
          if (e.cwd && !cwd) cwd = e.cwd;
          if (e.isSidechain || e.isMeta || !e.message || (e.type !== 'user' && e.type !== 'assistant')) continue;
          msgs.push({ role: e.message.role || e.type, content: e.message.content });
        }
        const clean = sanitize(msgs);
        if (!clean.length) continue;
        const first = clean.find((m) => m.role === 'user' && textOf(m).trim());
        const title = (first ? textOf(first) : 'Imported session').replace(/\s+/g, ' ').trim().slice(0, 60);
        const c = { id, title, mode: 'code', cwd, messages: clean, createdAt: mtime, updatedAt: mtime, permissionMode: 'default', model: null, allow: [], usage: { in: 0, out: 0 }, imported: true };
        fs.mkdirSync(path.join(store.root(), 'conversations'), { recursive: true });
        fs.writeFileSync(path.join(store.root(), 'conversations', id + '.json'), JSON.stringify(c));
        imported++;
      } catch { skipped++; }
    }
  }
  return { imported, skipped };
}
module.exports = { importAll, sanitize };
