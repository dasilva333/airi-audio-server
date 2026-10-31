const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

let cachedComputeCap = undefined;
let cachedArchSuffix = undefined;
let cachedVideoControllers = undefined;

const VALID_BACKENDS = ['cuda', 'vulkan', 'cpu', 'metal'];

// Bundled/built directory names per backend, mirroring audio.cpp's own layout.
const BACKEND_DIRS = {
  cuda: { bin: 'windows-cuda', build: 'windows-cuda-release' },
  vulkan: { bin: 'windows-vulkan', build: 'windows-vulkan-release' },
  cpu: { bin: 'windows-cpu', build: 'windows-cpu-release' },
  metal: { bin: 'macos-metal', build: 'macos-metal-release' }
};

function projectRoot() {
  return path.resolve(__dirname, '..');
}

function resolveFromRoot(p) {
  if (!p) return '';
  if (path.isAbsolute(p)) return p;
  return path.resolve(projectRoot(), p);
}

/**
 * Query the NVIDIA compute capability. Returns null when there is no usable
 * NVIDIA GPU: nvidia-smi.exe can exist on disk (it ships in System32) while the
 * command still fails on an AMD-only machine, so we rely on the parsed output
 * rather than on the presence of the executable.
 */
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

function hasNvidiaGpu() {
  const cap = getGpuComputeCap();
  return Boolean(cap) && !isNaN(parseFloat(cap));
}

/**
 * Enumerate the machine's display adapters. Used both for auto-detecting a
 * Vulkan-capable GPU on non-NVIDIA systems and for diagnostics.
 */
function getVideoControllers() {
  if (cachedVideoControllers !== undefined) return cachedVideoControllers;

  const names = [];
  try {
    if (process.platform === 'win32') {
      const out = execSync(
        'powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"',
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }
      );
      out.split(/\r?\n/).map(s => s.trim()).filter(Boolean).forEach(n => names.push(n));
    } else {
      try {
        const out = execSync('lspci', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
        out.split(/\r?\n/).filter(l => /VGA|3D|Display/i.test(l)).forEach(l => names.push(l.trim()));
      } catch (e) { /* lspci may be unavailable */ }
    }
  } catch (e) { /* ignore probing failures */ }

  cachedVideoControllers = names;
  return names;
}

/**
 * Adapters that are not the Microsoft Basic Display fallback are, in practice,
 * Vulkan-capable (AMD/Intel/NVIDIA drivers all ship a Vulkan ICD).
 */
function detectVulkanCapableGpu() {
  return getVideoControllers().filter(n => !/basic display/i.test(n));
}

/**
 * Locate the LunarG Vulkan SDK. Honors config.gpu.vulkan_sdk_path and $VULKAN_SDK,
 * then falls back to the standard Windows install roots.
 */
function getVulkanSdkPath(config = {}) {
  const candidates = [];

  const configured = config.gpu && config.gpu.vulkan_sdk_path;
  if (configured) candidates.push(resolveFromRoot(configured));
  if (config.vulkan_sdk_path) candidates.push(resolveFromRoot(config.vulkan_sdk_path));
  if (process.env.VULKAN_SDK) candidates.push(process.env.VULKAN_SDK);

  if (process.platform === 'win32') {
    const roots = [
      'C:\\VulkanSDK',
      path.resolve(projectRoot(), '..', 'VulkanSDK'),
      path.resolve(projectRoot(), 'VulkanSDK')
    ];
    if (process.env['ProgramFiles']) roots.push(path.join(process.env['ProgramFiles'], 'VulkanSDK'));
    if (process.env['ProgramFiles(x86)']) roots.push(path.join(process.env['ProgramFiles(x86)'], 'VulkanSDK'));

    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      try {
        const versions = fs.readdirSync(root).filter(v => /^\d+\.\d+/.test(v));
        versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        versions.forEach(v => candidates.push(path.join(root, v)));
      } catch (e) { /* unreadable directory */ }
    }
  }

  for (const cand of candidates) {
    if (!cand) continue;
    const binDir = path.join(cand, process.platform === 'win32' ? 'Bin' : 'bin');
    if (fs.existsSync(binDir) || fs.existsSync(cand)) {
      return cand;
    }
  }

  return null;
}

function hasGlslc(config = {}) {
  const sdk = getVulkanSdkPath(config);
  if (sdk) {
    const glslc = path.join(sdk, process.platform === 'win32' ? 'Bin\\glslc.exe' : 'bin/glslc');
    if (fs.existsSync(glslc)) return true;
  }
  try {
    const probe = process.platform === 'win32' ? 'where glslc' : 'which glslc';
    execSync(probe, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Determine the effective backend and target device index.
 *
 * Rules:
 *   1. Environment variable AIRI_GPU_BACKEND takes highest precedence.
 *   2. config.gpu.backend (or legacy config.backend) comes second.
 *   3. If "auto":
 *      - NVIDIA GPU detected via nvidia-smi -> "cuda"
 *      - otherwise non-Basic display controller found (AMD/Intel) -> "vulkan"
 *      - otherwise -> null (fails loudly, no silent CPU fallback)
 *   4. An explicit backend request (cuda/vulkan/cpu) is honored verbatim.
 */
function resolveBackend(config = {}) {
  const envBackend = (process.env.AIRI_GPU_BACKEND || '').trim().toLowerCase();
  const envDevice = (process.env.AIRI_GPU_DEVICE || '').trim();

  const cfgGpu = config.gpu || {};
  const cfgBackend = (cfgGpu.backend || config.backend || '').trim().toLowerCase();
  const cfgDevice = cfgGpu.device !== undefined ? cfgGpu.device : (config.device !== undefined ? config.device : 0);

  const requested = envBackend || cfgBackend || 'auto';
  const device = envDevice ? parseInt(envDevice, 10) : (typeof cfgDevice === 'number' ? cfgDevice : 0);

  if (requested !== 'auto') {
    if (!VALID_BACKENDS.includes(requested)) {
      return {
        backend: null,
        device,
        requested,
        source: envBackend ? 'env:AIRI_GPU_BACKEND' : 'config.gpu.backend',
        reason: `Unsupported backend '${requested}'. Valid backends: ${VALID_BACKENDS.join(', ')}`,
        devices: getVideoControllers()
      };
    }
    return {
      backend: requested,
      device: isNaN(device) ? 0 : device,
      requested,
      source: envBackend ? 'env:AIRI_GPU_BACKEND' : 'config.gpu.backend',
      reason: `Explicitly requested via ${envBackend ? 'AIRI_GPU_BACKEND' : 'config'}`,
      devices: getVideoControllers()
    };
  }

  // --- auto mode ---
  if (hasNvidiaGpu()) {
    return {
      backend: 'cuda',
      device: isNaN(device) ? 0 : device,
      requested: 'auto',
      source: 'auto-detect',
      reason: `NVIDIA GPU detected (compute capability ${getGpuComputeCap()})`,
      devices: getVideoControllers()
    };
  }

  const vulkanAdapters = detectVulkanCapableGpu();
  if (vulkanAdapters.length > 0) {
    return {
      backend: 'vulkan',
      device: isNaN(device) ? 0 : device,
      requested: 'auto',
      source: 'auto-detect',
      reason: `auto: no NVIDIA GPU; Vulkan-capable adapter detected (${vulkanAdapters[0]})`,
      devices: getVideoControllers()
    };
  }

  // No silent CPU fallback: fail so users are told what happened.
  return {
    backend: null,
    device: isNaN(device) ? 0 : device,
    requested: 'auto',
    source: 'auto-detect',
    reason: 'Could not determine an inference backend: no NVIDIA GPU and no Vulkan adapter found. Set gpu.backend in config.json.',
    devices: getVideoControllers()
  };
}

function requireBackend(config = {}) {
  const info = resolveBackend(config);
  if (!info.backend) {
    throw new Error(`[GPU Error] ${info.reason}`);
  }
  return info;
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

  Object.keys(process.env)
    .filter(k => k.startsWith('CUDA_PATH_V'))
    .sort((a, b) => b.localeCompare(a))
    .forEach(k => baseCandidates.push(process.env[k]));

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

function getBackendRuntimePaths(config = {}, backend = null) {
  const be = backend || resolveBackend(config).backend;
  if (be === 'cuda') {
    const custom = (config.gpu && config.gpu.cuda_path) || config.cuda_path;
    return getCudaPaths(custom);
  }
  if (be === 'vulkan') {
    const sdk = getVulkanSdkPath(config);
    if (!sdk) return [];
    const binDir = path.join(sdk, process.platform === 'win32' ? 'Bin' : 'bin');
    return fs.existsSync(binDir) ? [binDir] : [sdk];
  }
  return [];
}

function backendOfPath(p) {
  if (!p) return null;
  const norm = p.replace(/\\/g, '/').toLowerCase();
  let m = norm.match(/build\/windows-([a-z0-9]+)-(?:release|debug)/);
  if (m) return m[1];
  m = norm.match(/bin\/windows-([a-z0-9]+)/);
  if (m) return m[1];
  return null;
}

function isPathForBackend(p, backend) {
  const b = backendOfPath(p);
  return b === null || b === backend;
}

function resolveEngineBinary(binaryName, preferredPath = null, backend = null, config = null) {
  const root = projectRoot();
  const cfg = config || {};

  let effectiveBackend = backend;
  if (!effectiveBackend) {
    const info = resolveBackend(cfg);
    effectiveBackend = info.backend;
  }

  const searchBackends = effectiveBackend
    ? (effectiveBackend === 'cpu' ? ['cpu', 'vulkan', 'cuda'] : [effectiveBackend])
    : ['cuda', 'vulkan', 'cpu', 'metal'];

  const workingDir = cfg.audio_cpp && cfg.audio_cpp.working_dir
    ? resolveFromRoot(cfg.audio_cpp.working_dir)
    : resolveFromRoot('../audio.cpp');

  const tryPath = (p) => (p && fs.existsSync(p) ? p : null);

  // 1. Explicit configured path, if compatible with the requested backend.
  if (preferredPath) {
    const resolvedPreferred = resolveFromRoot(preferredPath);
    if (fs.existsSync(resolvedPreferred) && (isPathForBackend(preferredPath, effectiveBackend) || !effectiveBackend)) {
      return resolvedPreferred;
    }
  }

  const cap = getGpuComputeCap();
  const archSuffix = getGpuArchSuffix();

  for (const be of searchBackends) {
    const dirs = BACKEND_DIRS[be];
    if (!dirs) continue;
    const binDir = path.join(root, 'bin', dirs.bin);

    // 2. Bundled binary (arch-specific variant first for CUDA).
    if (be === 'cuda' && archSuffix) {
      const archBinary = tryPath(path.join(binDir, `${binaryName}_${archSuffix}.exe`));
      if (archBinary) {
        console.log(`[GPU] Detected compute capability ${cap} -> using native architecture binary: ${path.basename(archBinary)}`);
        return archBinary;
      }
    }
    const bundled = tryPath(path.join(binDir, `${binaryName}.exe`));
    if (bundled) {
      console.log(`[GPU] Using bundled ${be} binary: ${path.relative(root, bundled)}`);
      return bundled;
    }

    // 3. Local build inside the configured working_dir.
    const builtInWorkingDir = tryPath(path.join(workingDir, 'build', dirs.build, 'bin', `${binaryName}.exe`));
    if (builtInWorkingDir) return builtInWorkingDir;

    // 4. Legacy sibling default (../audio.cpp).
    const defaultBuildPath = tryPath(path.resolve(root, '..', 'audio.cpp', 'build', dirs.build, 'bin', `${binaryName}.exe`));
    if (defaultBuildPath) return defaultBuildPath;
  }

  // 5. Explicit preferredPath fallback
  if (preferredPath) {
    const resolvedPreferred = resolveFromRoot(preferredPath);
    if (fs.existsSync(resolvedPreferred)) return resolvedPreferred;
  }

  return null;
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
  const currentPath = process.env.PATH || process.env.Path || '';
  const envPath = [binDir, ...cudaPaths, currentPath].filter(Boolean).join(path.delimiter);
  const envOverrides = { ...process.env, PATH: envPath };
  delete envOverrides.Path;

  try {
    const res = spawnSync(binaryPath, ['--version'], {
      env: envOverrides,
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

function describeGpu(config = {}) {
  const info = resolveBackend(config);
  const sdk = getVulkanSdkPath(config);
  return {
    backend: info.backend,
    device: info.device,
    requested_backend: info.requested,
    backend_source: info.source,
    backend_reason: info.reason,
    nvidia_gpu: hasNvidiaGpu(),
    nvidia_compute_cap: getGpuComputeCap() || null,
    compute_arch_suffix: getGpuArchSuffix(),
    vulkan_capable_devices: detectVulkanCapableGpu(),
    video_controllers: info.devices,
    vulkan_sdk_path: sdk,
    vulkan_glslc_available: hasGlslc(config)
  };
}

module.exports = {
  VALID_BACKENDS,
  BACKEND_DIRS,
  getGpuComputeCap,
  getGpuArchSuffix,
  hasNvidiaGpu,
  getVideoControllers,
  detectVulkanCapableGpu,
  getVulkanSdkPath,
  hasGlslc,
  resolveBackend,
  requireBackend,
  getCudaPaths,
  getBackendRuntimePaths,
  resolveEngineBinary,
  isCudaMissingExitCode,
  formatCudaMissingBanner,
  testCudaRuntime,
  describeGpu
};
