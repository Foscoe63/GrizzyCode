// Reads team files written for other tools and turns them into a plain "package": { name, summary, agents[], lead, connectors[], note }.
// Understands OpenMausBot / BotMRR playbooks (botmrr frontmatter: agents, rooms, playbooks) and botteams listings (bot_roster, suggest).
// Pure functions only (no Electron, no disk), so tests can run under plain node. Nothing here connects an account or runs anything.
const MAX_AGENTS = 12, INSTR_MAX = 8000, DOWNLOAD_MAX = 512 * 1024;

// ---------------- a small YAML reader (frontmatter subset) ----------------
// Nested maps, lists, quoted/plain scalars, inline [a, b] lists, and | / > block text. No anchors, tags or multi-document files.
function splitFrontmatter(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  if ((lines[0] || '').trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  return end < 0 ? null : { front: lines.slice(1, end).join('\n'), body: lines.slice(end + 1).join('\n') };
}
function splitKey(t) {
  if (/^["'\[{]/.test(t)) return null;
  for (let i = 0; i < t.length; i++) if (t[i] === ':' && (i === t.length - 1 || t[i + 1] === ' ')) { const k = t.slice(0, i).trim(); return k ? [k, t.slice(i + 1).trim()] : null; }
  return null;
}
function scalar(raw) {
  let s = raw;
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) { const q = s[0]; s = s.slice(1, -1); if (q === '"') s = s.replace(/\\"/g, '"').replace(/\\n/g, '\n'); }
  else { const h = s.indexOf(' #'); if (h >= 0) s = s.slice(0, h).trim(); }
  return s;
}
function parseYAML(text) {
  const lines = []; for (const raw of String(text).split('\n')) { const t = raw.trim(); if (t && !t.startsWith('#')) lines.push({ indent: raw.length - raw.trimStart().length, text: t }); }
  if (!lines.length) return null;
  let pos = 0;
  const isItem = (l) => l.text === '-' || l.text.startsWith('- ');
  const block = (indent) => (isItem(lines[pos]) ? list(indent) : map(indent));
  function list(indent) {
    const out = [];
    while (pos < lines.length && lines[pos].indent === indent && isItem(lines[pos])) {
      const rest = lines[pos].text.slice(1).trim();
      if (!rest) { pos++; if (pos < lines.length && lines[pos].indent > indent) out.push(block(lines[pos].indent)); }
      else if (splitKey(rest)) { const off = lines[pos].text.length - rest.length; lines[pos] = { indent: indent + off, text: rest }; out.push(map(indent + off)); }
      else { out.push(scalar(rest)); pos++; }
    }
    return out;
  }
  function map(indent) {
    const out = {};
    while (pos < lines.length && lines[pos].indent === indent) {
      const kv = splitKey(lines[pos].text); if (!kv) break;
      const [key, value] = kv; pos++;
      if (/^[|>]-?$/.test(value)) { const parts = []; while (pos < lines.length && lines[pos].indent > indent) parts.push(lines[pos++].text); out[key] = parts.join(value[0] === '|' ? '\n' : ' '); }
      else if (!value) {
        if (pos < lines.length && lines[pos].indent > indent) out[key] = block(lines[pos].indent);
        else if (pos < lines.length && lines[pos].indent === indent && isItem(lines[pos])) out[key] = list(indent);
        else out[key] = '';
      } else if (value.startsWith('[') && value.endsWith(']')) out[key] = value.slice(1, -1).split(',').map((x) => scalar(x.trim())).filter(Boolean);
      else out[key] = scalar(value);
    }
    if (pos < lines.length && lines[pos].indent > indent && !Object.keys(out).length) pos++;
    return out;
  }
  return block(lines[0].indent);
}

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === 'string' ? v : '');
const strs = (v) => arr(v).filter((x) => typeof x === 'string');
const clip = (s) => String(s || '').slice(0, INSTR_MAX);
const nm = (v) => str(v).replace(/[@＠\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();

// ---------------- converters ----------------
function fromOpenMaus(root, body) {
  const name = nm(root.name); if (!name) return null;
  const summary = str(root.summary) || str(root.tagline);
  const playbooks = {}; for (const p of arr(root.playbooks)) if (p && p.key) playbooks[p.key] = { name: str(p.name) || p.key, text: str(p.instructions) };
  const rules = {};
  for (const r of arr(root.rooms)) if (r && str(r.bulletin)) for (const m of strs(r.members)) (rules[m] = rules[m] || []).push(`In ${str(r.name) || 'the room'}: ${str(r.bulletin)}`);
  let list = arr(root.agents).filter((a) => a && typeof a === 'object'); const single = !list.length; if (single) list = [root];
  const chiefKey = str(root.chiefOfStaff);
  const agents = list.map((a) => {
    const key = str(a.key) || nm(a.name), description = str(a.description) || summary, parts = [description];
    const pbs = strs(a.playbooks).map((k) => playbooks[k]).filter(Boolean);
    if (pbs.length) parts.push('Playbooks you follow when a request matches:', ...pbs.map((p) => `### ${p.name}\n${p.text}`));
    if (rules[key] && rules[key].length) parts.push('Team rules:\n' + rules[key].map((r) => `- ${r}`).join('\n'));
    if (single && body.trim()) parts.push(body.trim());
    return { name: nm(a.name), title: nm(a.title), description: description.slice(0, 200), instructions: clip(parts.filter(Boolean).join('\n\n')), lead: key === chiefKey };
  }).filter((a) => a.name);
  const connectors = arr(root.requirements && root.requirements.apps).filter((x) => x && x.slug).map((x) => ({ name: str(x.label) || x.slug, why: str(x.reason), required: x.optional !== 'true' }));
  const routines = arr(root.routines).length;
  return { name, summary, agents, connectors, routines };
}
function fromBotteams(root) {
  const name = nm(root.name); if (!name) return null;
  const rules = arr(root.suggest).filter((s) => s && s.on !== 'false' && str(s.text)).map((s) => str(s.text));
  const agents = arr(root.bot_roster).filter((b) => b && nm(b.name)).map((b) => {
    const persona = str(b.persona);
    return { name: nm(b.name), title: nm(root.section), description: persona.slice(0, 200), instructions: clip(rules.length ? `${persona}\n\nRules:\n${rules.map((r) => `- ${r}`).join('\n')}` : persona), lead: false };
  });
  return { name, summary: str(root.tagline), agents, connectors: strs(root.connectors).map((c) => ({ name: c, why: '', required: false })), routines: arr(root.routines).length, section: nm(root.section) };
}

// Returns a package or null when the text is not a recognised foreign team file.
function convert(markdown) {
  const parts = splitFrontmatter(markdown); if (!parts) return null;
  let root; try { root = parseYAML(parts.front); } catch { return null; }
  if (!root || Array.isArray(root)) return null;
  const pkg = root.agents || root.botmrr ? fromOpenMaus(root, parts.body) : root.bot_roster ? fromBotteams(root) : null;
  if (!pkg || !pkg.agents.length) return null;
  pkg.agents = pkg.agents.slice(0, MAX_AGENTS);
  return pkg;
}

// ---------------- GitHub links ----------------
function parseGitHub(u) {
  let url; try { url = new URL(u); } catch { return null; }
  if (url.protocol !== 'https:' || !['github.com', 'www.github.com'].includes(url.hostname.toLowerCase())) return null;
  const p = url.pathname.split('/').filter(Boolean); if (p.length < 2) return null;
  const repo = p[1].replace(/\.git$/, '');
  if (p.length >= 5 && p[2] === 'blob') return { owner: p[0], repo, branch: p[3], path: p.slice(4).join('/'), isFile: true };
  if (p.length >= 4 && p[2] === 'tree') return { owner: p[0], repo, branch: p[3], path: p.slice(4).join('/'), isFile: false };
  return p.length === 2 ? { owner: p[0], repo, branch: '', path: '', isFile: false } : null;
}
// A file page link becomes its raw address; anything else is returned as it was.
function rawUrl(u) { const g = parseGitHub(u); return g && g.isFile ? `https://raw.githubusercontent.com/${g.owner}/${g.repo}/${g.branch}/${g.path}` : u; }
const isRepoLink = (u) => { const g = parseGitHub(u); return !!g && !g.isFile; };

async function download(u, fetchFn = fetch) {
  const url = rawUrl(u); if (!/^https:\/\//i.test(url)) throw new Error('Only https links can be imported.');
  const res = await fetchFn(url, { headers: { accept: 'text/markdown, text/plain, application/json' } });
  if (!res.ok) throw new Error(`The server answered ${res.status}.`);
  const text = await res.text(); if (Buffer.byteLength(text) > DOWNLOAD_MAX) throw new Error('The file is too large.');
  return text;
}
// A repository link lists its team files (the first of packages/, bots/, teams/ that has any).
async function listRepo(u, fetchFn = fetch) {
  const g = parseGitHub(u); if (!g || g.isFile) throw new Error('That is not a GitHub repository link.');
  for (const folder of g.path ? [g.path] : ['packages', 'bots', 'teams']) {
    let items; try { items = JSON.parse(await download(`https://api.github.com/repos/${g.owner}/${g.repo}/contents/${folder}${g.branch ? `?ref=${encodeURIComponent(g.branch)}` : ''}`, fetchFn)); } catch { continue; }
    const out = arr(items).filter((i) => i && i.type === 'file' && /\.md$/i.test(i.name) && !/^(readme|contributing|license)\.md$/i.test(i.name) && /^https:\/\/raw\.githubusercontent\.com\//.test(i.download_url || ''))
      .map((i) => ({ id: `${folder}/${i.name.slice(0, -3)}`, name: i.name.slice(0, -3).replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), url: i.download_url }));
    if (out.length) return out.slice(0, 200);
  }
  throw new Error('No team files were found in that repository.');
}

module.exports = { convert, parseYAML, splitFrontmatter, rawUrl, isRepoLink, download, listRepo, MAX_AGENTS };
