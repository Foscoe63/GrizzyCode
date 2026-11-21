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
    const tokenizerFiles = ['tokenizer.json', 'tokenizer.model', 'spiece.model'];
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

// Scan a single root directory
function scanRoot(root) {
  const models = [];
  const skipped = [];
  
  if (!fs.existsSync(root.path)) return { models, skipped };
  
  try {
    const items = fs.readdirSync(root.path);
    
    for (const item of items) {
      const itemPath = path.join(root.path, item);
      const stat = fs.statSync(itemPath);
      
      if (!stat.isDirectory()) continue;
      
      // Check if this is a valid model bundle
      if (isValidMLXBundle(itemPath)) {
        const modelInfo = getModelInfo(itemPath);
        const size = getDirectorySize(itemPath);
        
        models.push({
          id: item, // Use folder name as ID
          name: item,
          path: itemPath,
          source: root.source,
          sizeBytes: size,
          modelType: modelInfo.modelType,
          quantizationBits: modelInfo.quantizationBits,
          summary: getSummary(modelInfo, size, root.source)
        });
      } else {
        // Check if it's a candidate (has some model-like files)
        const files = fs.readdirSync(itemPath);
        const hasConfig = files.some(f => f === 'config.json');
        const hasSafetensors = files.some(f => f.endsWith('.safetensors'));
        const hasTokenizer = files.some(f => ['tokenizer.json', 'tokenizer.model', 'spiece.model'].includes(f));
        
        if (hasConfig || hasSafetensors || hasTokenizer) {
          skipped.push({
            path: itemPath,
            reason: 'invalid_bundle',
            detail: 'Missing required files for MLX model'
          });
        }
      }
    }
  } catch (err) {
    console.error(`Error scanning ${root.path}:`, err.message);
  }
  
  return { models, skipped };
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
