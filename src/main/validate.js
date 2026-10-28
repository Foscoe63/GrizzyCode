// Validation for settings patches coming from the renderer; invalid values are dropped and reported.
const fs = require('fs');
const path = require('path');

// Switches must be real booleans: a stray string like "false" would otherwise read as on and quietly turn a safety setting (shell, web, bypass) on.
const BOOL = new Set(['runInTray', 'sidebarHidden', 'notifications', 'notifySound', 'capArtifacts', 'capShell', 'capEdit', 'capWeb', 'capSkills', 'capAgents', 'memoryEnabled', 'memoryAuto', 'allowBypass', 'autoOpenFiles', 'launchAtLogin', 'keepAwake', 'keepAwakeBattery', 'hardwareAccel', 'devMode', 'dockBounce', 'promptSuggestions', 'autoResume', 'checkUpdates', 'saveRouter', 'saveOutputs', 'saveCompact']);
const themes = require('./themes');
const ROLES = ['', 'software', 'design', 'research', 'writing', 'data', 'product', 'education', 'student', 'other'];
const ENUM = { theme: ['system', 'light', 'dark'], permissionMode: ['default', 'acceptEdits', 'plan', 'bypassPermissions'], provider: ['anthropic', 'openai'] };
function cleanSettings(p) {
  const out = {}, bad = [];
  const num = (k, lo, hi) => { const n = Math.round(Number(p[k])); if (Number.isFinite(n)) out[k] = Math.max(lo, Math.min(hi, n)); else bad.push(k); };
  for (const [k, v] of Object.entries(p)) {
    if (BOOL.has(k)) { if (typeof v === 'boolean') out[k] = v; else bad.push(k); }
    else if (ENUM[k]) { if (ENUM[k].includes(v)) out[k] = v; else bad.push(k); }
    else if (k === 'quickShortcut') { if (typeof v === 'string' && v.trim() && v.length <= 60) out[k] = v.trim(); else bad.push(k); }
    else if (k === 'maxSteps') num(k, 1, 200); else if (k === 'termFontSize') num(k, 9, 24);
    else if (k === 'retentionDays') { const n = Number(v); if ([0, 7, 30, 90, 180, 365].includes(n)) out[k] = n; else bad.push(k); }
    else if (k === 'branchPrefix') { if (typeof v === 'string' && /^[A-Za-z0-9._\/-]{0,30}$/.test(v) && !v.includes('..') && !v.startsWith('/') && !v.startsWith('-')) out[k] = v && !/[\/-]$/.test(v) ? v + '/' : v; else bad.push(k); }
    else if (k === 'worktreeDir') { if (v === '' || (typeof v === 'string' && path.isAbsolute(v) && fs.existsSync(v) && fs.statSync(v).isDirectory())) out[k] = v; else bad.push(k); }
    else if (k === 'shellPath') { try { if (v === '') out[k] = v; else { fs.accessSync(v, fs.constants.X_OK); if (fs.statSync(v).isDirectory()) throw new Error('dir'); out[k] = v; } } catch { bad.push(k); } }
    else if (k === 'saveOutputChars') num(k, 2000, 200000); else if (k === 'compactAtPct') num(k, 20, 95); else if (k === 'compactKeep') num(k, 2, 40);
    else if (k === 'compactModel') out[k] = String(v).trim().slice(0, 120);
    else if (k === 'notifyApproval' || k === 'notifyDone') { if (['banner', 'badge', 'off'].includes(v)) out[k] = v; else bad.push(k); }
    else if (k === 'sandboxShell') { if (['off', 'files', 'strict'].includes(v)) out[k] = v; else bad.push(k); }
    else if (k === 'archiveDays') num(k, 0, 3650); else if (k === 'worktreeReapHours') num(k, 0, 8760);
    else if (k === 'outputStyle') { if (['default', 'concise', 'explanatory', 'learning', 'custom'].includes(v)) out[k] = v; else bad.push(k); }
    else if (k === 'customStyle') out[k] = String(v).slice(0, 4000); else if (k === 'fastModel') out[k] = String(v).trim().slice(0, 120);
    else if (k === 'newTaskPrompt') out[k] = String(v).slice(0, 2000);
    else if (k === 'font') { if (['default', 'sans', 'serif', 'mono'].includes(v)) out[k] = v; else bad.push(k); }
    else if (k === 'colorTheme') { if (themes.isTheme(v)) out[k] = v; else bad.push(k); }
    else if (k === 'accent') { if (themes.isAccent(v)) out[k] = String(v).toLowerCase(); else bad.push(k); }
    else if (k === 'textSize') { if (['small', 'default', 'large', 'xlarge'].includes(v)) out[k] = v; else bad.push(k); }
    else if (k === 'profileName') out[k] = String(v).trim().slice(0, 80);
    else if (k === 'profileEmail') { const e = String(v).trim(); if (e === '' || (e.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) out[k] = e; else bad.push(k); }
    else if (k === 'profileRole') { if (ROLES.includes(v)) out[k] = v; else bad.push(k); }
    else if (k === 'displayName') out[k] = String(v).slice(0, 60); else if (k === 'preferences') out[k] = String(v).slice(0, 2000);
    else out[k] = v;
  }
  return { out, bad };
}
module.exports = { cleanSettings };
