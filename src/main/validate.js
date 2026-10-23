// Validation for settings patches coming from the renderer; invalid values are dropped and reported.
const fs = require('fs');
const path = require('path');

function cleanSettings(p) {
  const out = {}, bad = [];
  const num = (k, lo, hi) => { const n = Math.round(Number(p[k])); if (Number.isFinite(n)) out[k] = Math.max(lo, Math.min(hi, n)); else bad.push(k); };
  for (const [k, v] of Object.entries(p)) {
    if (k === 'maxSteps') num(k, 1, 200); else if (k === 'termFontSize') num(k, 9, 24);
    else if (k === 'retentionDays') { const n = Number(v); if ([0, 7, 30, 90, 180, 365].includes(n)) out[k] = n; else bad.push(k); }
    else if (k === 'branchPrefix') { if (typeof v === 'string' && /^[A-Za-z0-9._\/-]{0,30}$/.test(v) && !v.includes('..') && !v.startsWith('/') && !v.startsWith('-')) out[k] = v && !/[\/-]$/.test(v) ? v + '/' : v; else bad.push(k); }
    else if (k === 'worktreeDir') { if (v === '' || (typeof v === 'string' && path.isAbsolute(v) && fs.existsSync(v) && fs.statSync(v).isDirectory())) out[k] = v; else bad.push(k); }
    else if (k === 'shellPath') { try { if (v === '') out[k] = v; else { fs.accessSync(v, fs.constants.X_OK); if (fs.statSync(v).isDirectory()) throw new Error('dir'); out[k] = v; } } catch { bad.push(k); } }
    else if (k === 'saveOutputChars') num(k, 2000, 200000); else if (k === 'compactAtPct') num(k, 20, 95); else if (k === 'compactKeep') num(k, 2, 40);
    else if (k === 'compactModel') out[k] = String(v).trim().slice(0, 120);
    else if (k === 'font') { if (['default', 'sans', 'serif', 'mono'].includes(v)) out[k] = v; else bad.push(k); }
    else if (k === 'displayName') out[k] = String(v).slice(0, 60); else if (k === 'preferences') out[k] = String(v).slice(0, 2000);
    else out[k] = v;
  }
  return { out, bad };
}
module.exports = { cleanSettings };
