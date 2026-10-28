// Project instructions: GRIZZY.md / AGENTS.md / CLAUDE.md found in the working folder and its parents (up to the repository root)
// are added to the system prompt of code sessions, outermost first. Local sessions only.
const fs = require('fs');
const path = require('path');
const os = require('os');

const NAMES = ['GRIZZY.md', 'AGENTS.md', 'CLAUDE.md', path.join('.claude', 'CLAUDE.md')];
const PER_FILE = 12000, TOTAL = 24000, MAX_UP = 6;

function find(cwd) {
  const found = []; let dir = path.resolve(cwd || '.'); const home = os.homedir();
  for (let i = 0; i < MAX_UP && dir !== home; i++) {
    for (const n of NAMES) { const f = path.join(dir, n); try { if (fs.statSync(f).isFile()) { found.unshift(f); break; } } catch {} }
    if (fs.existsSync(path.join(dir, '.git'))) break;
    const up = path.dirname(dir); if (up === dir) break; dir = up;
  }
  return found;
}

function promptBlock(s, conv) {
  if (conv.mode !== 'code' || conv.ssh || !conv.cwd || s.projectInstructions === false) return '';
  let left = TOTAL, out = '';
  for (const f of find(conv.cwd)) {
    let t; try { t = fs.readFileSync(f, 'utf8').trim(); } catch { continue; }
    if (!t || left <= 0) continue;
    t = t.slice(0, Math.min(PER_FILE, left)); left -= t.length;
    out += `\n\n<project-instructions file="${f}">\n${t}\n</project-instructions>`;
  }
  return out ? '\n\nInstructions from this project\'s own files (follow them unless the user says otherwise):' + out : '';
}

module.exports = { find, promptBlock };
