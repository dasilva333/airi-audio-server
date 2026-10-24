const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

let cachedComputeCap = undefined;
let cachedArchSuffix = undefined;

function getGpuComputeCap() {
  if (cachedComputeCap !== undefined) return cachedComputeCap;

  try {
    const out = execSync('nvidia-smi --query-gpu=compute_cap --format=csv,noheader,nounits', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000
    });
    const firstLine = out.trim().split(/\r?\n/)[0].trim();
    cachedComputeCap = firstLine || null;
  } catch (e) {
    cachedComputeCap = null;
  }
  return cachedComputeCap;
}

function getGpuArchSuffix() {
  if (cachedArchSuffix !== undefined) return cachedArchSuffix;

  const cap = getGpuComputeCap();
  if (!cap) {
    cachedArchSuffix = null;
    return null;
  }

  const num = parseFloat(cap);
  if (isNaN(num)) {
    cachedArchSuffix = null;
    return null;
  }

  if (num >= 12.0) cachedArchSuffix = 'sm120';
  else if (num >= 8.9) cachedArchSuffix = 'sm89';
  else if (num >= 8.0) cachedArchSuffix = 'sm86';
  else if (num >= 7.5) cachedArchSuffix = 'sm75';
  else cachedArchSuffix = null;

  return cachedArchSuffix;
}

function resolveEngineBinary(binaryName, preferredPath = null) {
  const binDir = path.resolve(__dirname, '../bin/windows-cuda');
  const cap = getGpuComputeCap();
  const archSuffix = getGpuArchSuffix();

  if (preferredPath) {
    const resolvedPreferred = path.isAbsolute(preferredPath)
      ? preferredPath
      : path.resolve(__dirname, '..', preferredPath);
    if (fs.existsSync(resolvedPreferred) && !preferredPath.includes('build/windows-cuda-release')) {
      return resolvedPreferred;
    }
  }

  if (archSuffix) {
    const archBinary = path.join(binDir, `${binaryName}_${archSuffix}.exe`);
    if (fs.existsSync(archBinary)) {
      console.log(`[GPU] Detected compute capability ${cap} -> using native architecture binary: ${path.basename(archBinary)}`);
      return archBinary;
    }
  }

  if (preferredPath) {
    const resolvedPreferred = path.isAbsolute(preferredPath)
      ? preferredPath
      : path.resolve(__dirname, '..', preferredPath);
    if (fs.existsSync(resolvedPreferred)) {
      return resolvedPreferred;
    }
  }

  const genericBinary = path.join(binDir, `${binaryName}.exe`);
  if (fs.existsSync(genericBinary)) {
    console.log(`[GPU] Using bundled default binary: ${path.basename(genericBinary)}`);
    return genericBinary;
  }

  const defaultBuildPath = path.resolve(__dirname, `../../audio.cpp/build/windows-cuda-release/bin/${binaryName}.exe`);
  if (fs.existsSync(defaultBuildPath)) {
    return defaultBuildPath;
  }

  return null;
}

function getCudaPaths(customCudaPath = null) {
  const detectedPaths = new Set();
  const baseCandidates = [];

  if (customCudaPath) {
    if (Array.isArray(customCudaPath)) {
      customCudaPath.forEach(p => {
        const resolved = path.isAbsolute(p) ? p : path.resolve(__dirname, '..', p);
        baseCandidates.push(resolved);
      });
    } else {
      const resolved = path.isAbsolute(customCudaPath) ? customCudaPath : path.resolve(__dirname, '..', customCudaPath);
      baseCandidates.push(resolved);
    }
  }
  if (process.env.CUDA_PATH) baseCandidates.push(process.env.CUDA_PATH);
  if (process.env.CUDA_HOME) baseCandidates.push(process.env.CUDA_HOME);

  // Capture all versioned CUDA_PATH environment variables (e.g. CUDA_PATH_V13_1, CUDA_PATH_V12_6)
  Object.keys(process.env)
    .filter(k => k.startsWith('CUDA_PATH_V'))
    .sort((a, b) => b.localeCompare(a))
    .forEach(k => baseCandidates.push(process.env[k]));

  // Auto-detect all installed CUDA versions from standard Windows toolkit directory
  const standardToolkitDir = 'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA';
  if (fs.existsSync(standardToolkitDir)) {
    try {
      const versions = fs.readdirSync(standardToolkitDir).filter(v => v.startsWith('v'));
      versions.sort((a, b) => {
        const numA = parseFloat(a.replace(/^v/, '')) || 0;
        const numB = parseFloat(b.replace(/^v/, '')) || 0;
        return numB - numA;
      });
      versions.forEach(v => baseCandidates.push(path.join(standardToolkitDir, v)));
    } catch (e) {}
  }

  // Standard Linux / WSL paths
  if (process.platform !== 'win32') {
    ['/usr/local/cuda', '/usr/local/cuda-13', '/usr/local/cuda-12', '/usr/local/cuda-11', '/opt/cuda'].forEach(p => {
      if (fs.existsSync(p)) baseCandidates.push(p);
    });
  }

  const subdirs = [
    path.join('bin', 'x64'),
    'bin',
    path.join('nvvm', 'bin', 'x64'),
    'libnvvp'
  ];

  baseCandidates.forEach(base => {
    if (!base) return;
    let root = base;
    const lower = base.toLowerCase();
    if (lower.endsWith(path.join('bin', 'x64').toLowerCase()) || lower.endsWith('/bin/x64') || lower.endsWith('\\bin\\x64')) {
      root = path.dirname(path.dirname(base));
    } else if (lower.endsWith(path.sep + 'bin') || lower.endsWith('/bin') || lower.endsWith('\\bin')) {
      root = path.dirname(base);
    }

    subdirs.forEach(sub => {
      const candidate = path.join(root, sub);
      if (fs.existsSync(candidate)) {
        detectedPaths.add(candidate);
      }
    });

    if (fs.existsSync(base)) {
      detectedPaths.add(base);
    }
  });

  return Array.from(detectedPaths);
}

function isCudaMissingExitCode(code) {
  return code === 3221225781 || code === -1073741515 || code === 0xc0000135;
}

function formatCudaMissingBanner(gpuCap = null) {
  const capMsg = gpuCap ? ` (Compute Capability ${gpuCap})` : '';
  return [
    '========================================================================',
    `[!] NVIDIA CUDA RUNTIME NOT FOUND${capMsg} (Windows Error 0xC0000135)`,
    '========================================================================',
    'The GPU engine (audiocpp_server) failed to start because the required',
    'NVIDIA CUDA runtime library (cublas64_13.dll) was not found on your system.',
    '',
    'Why this happens:',
    '  Standard NVIDIA GeForce graphics drivers only install display support and',
    '  do NOT include the CUDA development libraries (cuBLAS) required by AI models.',
    '',
    'HOW TO FIX (takes ~2 minutes):',
    '  1. Download and install NVIDIA CUDA Toolkit 13.1 (or 13.x):',
    '     -> https://developer.nvidia.com/cuda-downloads',
    '',
    '  2. If CUDA is already installed in a custom directory (e.g. D:\\CUDA), set:',
    '     - The CUDA_PATH Windows environment variable, or',
    '     - "cuda_path": "D:\\\\Path\\\\To\\\\CUDA\\\\v13.1\\\\bin\\\\x64" in config.json',
    '',
    '  3. Ensure Microsoft Visual C++ 2015-2022 x64 Redistributable is installed:',
    '     -> https://aka.ms/vs/17/release/vc_redist.x64.exe',
    '',
    'Once installed, restart the server and it will launch smoothly!',
    '========================================================================'
  ].join('\n');
}

function testCudaRuntime(binaryPath, customCudaPath = null) {
  if (process.platform !== 'win32' || !binaryPath || !fs.existsSync(binaryPath)) {
    return { ok: true, code: 0, missingCuda: false };
  }

  const { spawnSync } = require('child_process');
  const binDir = path.dirname(binaryPath);
  const cudaPaths = getCudaPaths(customCudaPath);
  const envPath = [binDir, ...cudaPaths, process.env.PATH].filter(Boolean).join(path.delimiter);

  try {
    const res = spawnSync(binaryPath, ['--version'], {
      env: { ...process.env, PATH: envPath },
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const code = res.status;
    const missingCuda = isCudaMissingExitCode(code);
    return {
      ok: code === 0,
      code,
      missingCuda
    };
  } catch (err) {
    return {
      ok: false,
      code: -1,
      missingCuda: false,
      error: err.message
    };
  }
}

module.exports = {
  getGpuComputeCap,
  getGpuArchSuffix,
  resolveEngineBinary,
  getCudaPaths,
  isCudaMissingExitCode,
  formatCudaMissingBanner,
  testCudaRuntime
};
