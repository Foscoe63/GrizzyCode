// MLX model discovery and scanning
// Scans common locations for MLX models (Hugging Face cache, LM Studio, custom folders)
const fs = require('fs');
const path = require('path');
const os = require('os');

// Scan roots for MLX models
function getDefaultScanRoots() {
  const home = os.homedir();
  return [
    {
      path: path.join(home, 'Library', 'Application Support', 'GrizzyCode', 'MLXModels'),
      source: 'Downloaded in GrizzyCode',
      layout: 'nested'
    },
    {
      path: path.join(home, 'Library', 'Application Support', 'GrizzyBot', 'MLXModels'),
      source: 'Downloaded in GrizzyBot',
      layout: 'nested'
    },
    {
      path: path.join(home, '.cache', 'huggingface', 'hub'),
      source: 'Hugging Face cache',
      layout: 'huggingFaceCache'
    },
    {
      path: path.join(home, '.lmstudio', 'models'),
      source: 'LM Studio',
      layout: 'nested'
    },
    {
      path: path.join(home, '.cache', 'lm-studio', 'models'),
      source: 'LM Studio',
      layout: 'nested'
    }
  ];
}

// Check if a directory is a valid MLX model bundle
function isValidMLXBundle(dirPath) {
  try {
    // Must have config.json
    const configPath = path.join(dirPath, 'config.json');
    if (!fs.existsSync(configPath)) return false;
    
    // Must have tokenizer files
    const tokenizerFiles = ['tokenizer.json', 'tokenizer.model', 'spiece.model', 'tokenizer_config.json'];
    const hasTokenizer = tokenizerFiles.some(f => fs.existsSync(path.join(dirPath, f)));
    if (!hasTokenizer) return false;
    
    // Must have at least one .safetensors file
    const files = fs.readdirSync(dirPath);
    const hasSafetensors = files.some(f => f.endsWith('.safetensors'));
    if (!hasSafetensors) return false;
    
    return true;
  } catch {
    return false;
  }
}

// Get model info from config.json
function getModelInfo(dirPath) {
  try {
    const configPath = path.join(dirPath, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    
    return {
      modelType: config.model_type || null,
      quantizationBits: config.quantization_config?.bits || null,
      maxPositionEmbeddings: config.max_position_embeddings || null
    };
  } catch {
    return {};
  }
}

// Calculate directory size
function getDirectorySize(dirPath) {
  try {
    let total = 0n;
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stat = fs.statSync(filePath);
      if (stat.isFile()) {
        total += BigInt(stat.size);
      }
    }
    return Number(total);
  } catch {
    return 0;
  }
}

// Format bytes to human readable
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// True when the first .safetensors file declares format "mlx" (or the folder name says mlx).
function looksMLX(dirPath) {
  try {
    if (/mlx/i.test(dirPath)) return true;
    const f = fs.readdirSync(dirPath).find((x) => x.endsWith('.safetensors'));
    if (!f) return false;
    const fd = fs.openSync(path.join(dirPath, f), 'r');
    try {
      const len = Buffer.alloc(8); fs.readSync(fd, len, 0, 8, 0);
      const n = Number(len.readBigUInt64LE(0)); if (!n || n > 64 << 20) return false;
      const buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, 8);
      return JSON.parse(buf.toString('utf8')).__metadata__?.format === 'mlx';
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

const MAX_DEPTH = 4;
// Scan a root recursively: any folder that is a valid MLX bundle is a model; Hugging Face cache
// folders (models--org--name/snapshots/<rev>) are resolved to their newest snapshot.
function scanRoot(root) {
  const models = [], skipped = [];
  if (!fs.existsSync(root.path)) return { models, skipped };
  const add = (dir, id) => {
    const info = getModelInfo(dir), size = getDirectorySize(dir);
    models.push({ id, name: id, path: dir, source: root.source, sizeBytes: size, modelType: info.modelType, quantizationBits: info.quantizationBits, summary: getSummary(info, size, root.source) });
  };
  const walk = (dir, depth) => {
    let items; try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (isValidMLXBundle(dir)) {
      if (looksMLX(dir)) {
        const hf = dir.match(/models--[^/]+--([^/]+)\/snapshots\//);
        add(dir, hf ? hf[1] : path.basename(dir));
      } else skipped.push({ path: dir, reason: 'not_mlx', detail: 'Has weights but they are not in MLX format' });
      return;
    }
    if (depth >= MAX_DEPTH) return;
    for (const it of items) {
      if (it.name.startsWith('.') || it.name === 'blobs' || it.name === 'refs') continue;
      const p = path.join(dir, it.name);
      let isDir = it.isDirectory(); if (!isDir && it.isSymbolicLink()) { try { isDir = fs.statSync(p).isDirectory(); } catch {} }
      if (isDir) walk(p, depth + 1);
    }
  };
  walk(root.path, 0);
  // keep one entry per id (newest HF snapshot wins by path order is fine)
  const seen = new Set();
  return { models: models.filter((m) => !seen.has(m.id) && seen.add(m.id)), skipped };
}

// Generate human-readable summary
function getSummary(modelInfo, size, source) {
  const parts = [];
  
  if (modelInfo.quantizationBits) {
    parts.push(`${modelInfo.quantizationBits}-bit`);
  }
  
  if (size > 0) {
    parts.push(formatBytes(size));
  }
  
  if (modelInfo.modelType) {
    parts.push(modelInfo.modelType);
  }
  
  parts.push(source);
  
  return parts.join(' · ');
}

// Main scan function
function scan(customFolders = []) {
  const roots = [...getDefaultScanRoots()];
  
  // Add custom folders
  for (const folder of customFolders) {
    if (folder && fs.existsSync(folder)) {
      roots.push({
        path: folder,
        source: 'Custom model folder',
        layout: 'nested'
      });
    }
  }
  
  const allModels = [];
  const allSkipped = [];
  const scannedRoots = [];
  
  for (const root of roots) {
    const result = scanRoot(root);
    allModels.push(...result.models);
    allSkipped.push(...result.skipped);
    scannedRoots.push(root.path);
  }
  
  { const seen = new Set(); for (let i = allModels.length - 1; i >= 0; i--) { /* keep first */ } const keep = allModels.filter((m) => !seen.has(m.id) && seen.add(m.id)); allModels.length = 0; allModels.push(...keep); }
  // Sort models by ID
  allModels.sort((a, b) => a.id.localeCompare(b.id));
  
  return {
    models: allModels,
    skipped: allSkipped,
    rootsScanned: scannedRoots
  };
}

// Resolve a model ID to a path
function resolveModelPath(modelId, customFolders = []) {
  if (!modelId) return null;
  
  // If it's an absolute path, check if it's valid
  if (modelId.startsWith('/') || modelId.startsWith('~')) {
    const resolvedPath = modelId.startsWith('~') 
      ? path.join(os.homedir(), modelId.slice(2))
      : modelId;
    
    if (isValidMLXBundle(resolvedPath)) {
      return resolvedPath;
    }
    return null;
  }
  
  // Otherwise scan and find by ID
  const report = scan(customFolders);
  const match = report.models.find(m => m.id.toLowerCase() === modelId.toLowerCase());
  return match ? match.path : null;
}

module.exports = {
  getDefaultScanRoots,
  isValidMLXBundle,
  getModelInfo,
  getDirectorySize,
  formatBytes,
  scanRoot,
  getSummary,
  scan,
  resolveModelPath
};
