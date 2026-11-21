// Built-in Local MLX runtime for GrizzyCode.
// GrizzyCode owns a private Python venv (userData/mlx-runtime) with mlx-lm, created on first use,
// and keeps one persistent `mlx_lm.server` (OpenAI-compatible) running for the selected model.
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

function isAppleSilicon() { return process.arch === 'arm64' && process.platform === 'darwin'; }

function runtimeDir() {
  let base;
  try { base = require('electron').app.getPath('userData'); } catch { base = path.join(os.homedir(), 'Library', 'Application Support', 'GrizzyCode'); }
  return path.join(base, 'mlx-runtime');
}
const venvPython = () => path.join(runtimeDir(), 'venv', 'bin', 'python');

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout || 600000, maxBuffer: 16 << 20, env: { ...process.env, PATH: `${process.env.PATH || ''}:/opt/homebrew/bin:/usr/local/bin:${os.homedir()}/.local/bin` } },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || err?.message || '') }));
  });
}

async function findUv() {
  for (const p of [path.join(os.homedir(), '.local/bin/uv'), '/opt/homebrew/bin/uv', '/usr/local/bin/uv']) if (fs.existsSync(p)) return p;
  const r = await run('/usr/bin/which', ['uv'], { timeout: 5000 });
  return r.ok ? r.out.trim() : null;
}

// A system python >= 3.10 (mlx requires it), used when uv is unavailable.
async function findPython() {
  const cands = [process.env.MLX_PYTHON_PATH, 'python3.13', 'python3.12', 'python3.11', 'python3.10', '/opt/homebrew/bin/python3', 'python3'].filter(Boolean);
  for (const c of cands) {
    const r = await run(c, ['-c', 'import sys;print(sys.version_info>=(3,10))'], { timeout: 8000 });
    if (r.ok && r.out.trim() === 'True') return c;
  }
  return null;
}

async function checkMLXAvailability() {
  if (!isAppleSilicon()) return { available: false, status: 'UNSUPPORTED', message: MLXProvider.unsupportedHardwareMessage };
  if (!fs.existsSync(venvPython())) return { available: false, status: 'MISSING', message: 'Local MLX runtime is not set up yet.' };
  const r = await run(venvPython(), ['-c', 'import mlx_lm;print("OK")'], { timeout: 30000 });
  const ok = r.ok && r.out.trim() === 'OK';
  return { available: ok, status: ok ? 'OK' : 'MISSING', message: ok ? 'mlx-lm is available' : 'mlx-lm is not installed in the GrizzyCode runtime.' };
}

let installing = null;
// Create the private venv and install mlx-lm. Idempotent; concurrent callers share one run.
function ensureRuntime(onProgress = () => {}) {
  if (installing) return installing;
  installing = (async () => {
    if (!isAppleSilicon()) throw new Error(MLXProvider.unsupportedHardwareMessage);
    if ((await checkMLXAvailability()).available) return { ok: true };
    const dir = runtimeDir(); const venv = path.join(dir, 'venv');
    fs.mkdirSync(dir, { recursive: true });
    const uv = await findUv();
    let r;
    if (uv) {
      onProgress('Creating Local MLX environment…');
      r = await run(uv, ['venv', '--python', '3.12', '--allow-existing', venv]);
      if (!r.ok) throw new Error('Could not create MLX environment: ' + r.err.slice(-400));
      onProgress('Installing mlx-lm (one-time, may take a minute)…');
      r = await run(uv, ['pip', 'install', '--python', venvPython(), '-U', 'mlx-lm']);
    } else {
      const py = await findPython();
      if (!py) throw new Error('Local MLX needs Python 3.10+ or uv. Install uv (brew install uv) and try again.');
      onProgress('Creating Local MLX environment…');
      r = await run(py, ['-m', 'venv', venv]);
      if (!r.ok) throw new Error('Could not create MLX environment: ' + r.err.slice(-400));
      onProgress('Installing mlx-lm (one-time, may take a minute)…');
      r = await run(venvPython(), ['-m', 'pip', 'install', '-U', 'mlx-lm'], { timeout: 900000 });
    }
    if (!r.ok) throw new Error('Installing mlx-lm failed: ' + r.err.slice(-400));
    const c = await checkMLXAvailability();
    if (!c.available) throw new Error(c.message);
    return { ok: true };
  })().finally(() => { installing = null; });
  return installing;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.unref(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// Persistent server for the currently selected model.
const server = { proc: null, port: 0, model: null, starting: null, log: '' };

function stopServer() {
  if (server.proc) { try { server.proc.kill('SIGTERM'); } catch {} }
  Object.assign(server, { proc: null, port: 0, model: null, starting: null });
}

async function waitReady(port, proc, timeoutMs = 300000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (proc.exitCode !== null) throw new Error('MLX server exited: ' + server.log.slice(-400));
    try { const r = await fetch(`http://127.0.0.1:${port}/v1/models`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('MLX server did not start in time.');
}

// Ensure runtime + server for modelPath; returns the OpenAI-compatible base URL.
async function ensureServer(modelPath, onProgress = () => {}) {
  await ensureRuntime(onProgress);
  if (server.proc && server.model === modelPath && server.proc.exitCode === null) {
    if (server.starting) await server.starting;
    return `http://127.0.0.1:${server.port}/v1`;
  }
  stopServer();
  const port = await freePort();
  onProgress('Loading model…');
  const proc = spawn(venvPython(), ['-m', 'mlx_lm.server', '--model', modelPath, '--host', '127.0.0.1', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  server.log = '';
  const keep = (d) => { server.log = (server.log + d).slice(-4000); };
  proc.stdout.on('data', keep); proc.stderr.on('data', keep);
  proc.on('exit', () => { if (server.proc === proc) Object.assign(server, { proc: null, port: 0, model: null, starting: null }); });
  Object.assign(server, { proc, port, model: modelPath });
  server.starting = waitReady(port, proc).finally(() => { if (server.proc === proc) server.starting = null; });
  try { await server.starting; } catch (e) { stopServer(); throw e; }
  return `http://127.0.0.1:${port}/v1`;
}

process.on('exit', () => { if (server.proc) try { server.proc.kill('SIGTERM'); } catch {} });


// ---- Hugging Face Hub: search + download into GrizzyCode's own MLXModels folder ----
async function searchHub(query) {
  const u = new URL('https://huggingface.co/api/models');
  u.searchParams.set('author', 'mlx-community'); u.searchParams.set('sort', 'downloads'); u.searchParams.set('limit', '25');
  if (query) u.searchParams.set('search', query);
  const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Hugging Face returned HTTP ${r.status}`);
  return (await r.json()).map((m) => ({ repo: m.id, downloads: m.downloads || 0 }));
}

const downloading = new Map();
function downloadModel(repo, token) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo))) return Promise.reject(new Error('Use a Hugging Face repo like mlx-community/Qwen2.5-7B-Instruct-4bit.'));
  if (downloading.has(repo)) return downloading.get(repo);
  const p = (async () => {
    await ensureRuntime();
    const dest = path.join(downloadDir(), repo.split('/')[1]);
    fs.mkdirSync(dest, { recursive: true });
    const code = 'import sys\nfrom huggingface_hub import snapshot_download\nsnapshot_download(repo_id=sys.argv[1], local_dir=sys.argv[2], token=(sys.argv[3] or None))';
    const r = await run(venvPython(), ['-c', code, repo, dest, token || ''], { timeout: 4 * 3600 * 1000 });
    if (!r.ok) throw new Error('Download failed: ' + r.err.slice(-300));
    return { ok: true, id: repo.split('/')[1], path: dest };
  })().finally(() => downloading.delete(repo));
  downloading.set(repo, p); return p;
}

// Provider info
const MLXProvider = {
  id: 'localmlx',
  name: 'Local MLX',
  billing: "Runs on this Mac's Apple Silicon GPU inside GrizzyCode. Nothing leaves the machine and there are no model charges.",
  isSupportedHardware: isAppleSilicon(),
  unsupportedHardwareMessage: "Local MLX needs an Apple Silicon Mac. Use Ollama, LM Studio, or a remote provider on this machine."
};

// User-chosen locations (settings.mlxModelsDir = where downloads go, settings.mlxExtraFolders = more folders to scan)
function userCfg() {
  try { const st = require('./store').getSettings(); return { dir: st.mlxModelsDir || '', extra: Array.isArray(st.mlxExtraFolders) ? st.mlxExtraFolders : [] }; } catch { return { dir: '', extra: [] }; }
}
function downloadDir() { return userCfg().dir || require('./mlx-models').getDefaultScanRoots()[0].path; }
function customFolders() { const c = userCfg(); return [...(c.dir ? [c.dir] : []), ...c.extra]; }

function getScanRoots() { return require('./mlx-models').getDefaultScanRoots().map((r) => r.path).concat(customFolders()); }
function scanModels() { return require('./mlx-models').scan(customFolders()); }
function resolveModelPath(modelId) { return require('./mlx-models').resolveModelPath(modelId, customFolders()); }
function setLocations(patch) {
  const store = require('./store'); const out = {};
  if ('dir' in patch) out.mlxModelsDir = patch.dir || '';
  if ('extra' in patch) out.mlxExtraFolders = [...new Set((patch.extra || []).filter(Boolean))];
  store.saveSettings(out); return locations();
}
function locations() { const c = userCfg(); return { downloadDir: downloadDir(), customDir: c.dir, extra: c.extra, roots: getScanRoots() }; }

// Check if provider is MLX
function isMLXProvider(provider) {
  return provider === MLXProvider.id;
}


module.exports = {
  MLXProvider,
  checkMLXAvailability,
  ensureRuntime,
  ensureServer,
  searchHub,
  downloadModel,
  stopServer,
  getScanRoots,
  locations,
  setLocations,
  scanModels,
  resolveModelPath,
  isMLXProvider,
  isAppleSilicon
};
