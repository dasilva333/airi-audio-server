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
  else if (num >= 8.6) cachedArchSuffix = 'sm86';
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
      // Prefer an SDK co-located with the project to keep the OS drive clean,
      // e.g. <parent-of-workspace>\VulkanSDK\<version>.
      path.resolve(projectRoot(), '..', 'VulkanSDK'),
      path.resolve(projectRoot(), 'VulkanSDK')
    ];
    if (process.env['ProgramFiles']) roots.push(path.join(process.env['ProgramFiles'], 'VulkanSDK'));
    if (process.env['ProgramFiles(x86)']) roots.push(path.join(process.env['ProgramFiles(x86)'], 'VulkanSDK'));

    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      try {
        const versions = fs.readdirSync(root)
          .filter(v => /^\d/.test(v))
          .sort((a, b) => parseFloat(b) - parseFloat(a));
        versions.forEach(v => candidates.push(path.join(root, v)));
      } catch (e) { /* ignore unreadable roots */ }
    }
  }

  for (const c of candidates) {
    if (!c || !fs.existsSync(c)) continue;
    // Windows SDKs use Bin/, the Linux SDK uses bin/.
    if (fs.existsSync(path.join(c, 'Bin')) || fs.existsSync(path.join(c, 'bin'))) return c;
  }
  return candidates.find(c => c && fs.existsSync(c)) || null;
}

function hasGlslc(config = {}) {
  const sdk = getVulkanSdkPath(config);
  if (sdk) {
    for (const sub of ['Bin', 'bin']) {
      if (fs.existsSync(path.join(sdk, sub, 'glslc.exe')) || fs.existsSync(path.join(sdk, sub, 'glslc'))) return true;
    }
  }
  try {
    execSync('glslc --version', { stdio: ['ignore', 'ignore', 'ignore'], timeout: 4000 });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Resolve the effective inference backend.
 *
 * Priority: AIRI_GPU_BACKEND env > config.gpu.backend > auto.
 * "auto" selects CUDA when a real NVIDIA GPU is present, otherwise Vulkan when a
 * Vulkan-capable adapter exists. It never silently degrades to CPU.
 */
function resolveBackend(config = {}) {
  const envBackend = (process.env.AIRI_GPU_BACKEND || '').trim().toLowerCase();
  const cfgBackend = (config.gpu && config.gpu.backend ? String(config.gpu.backend) : '').trim().toLowerCase();
  const requested = envBackend || cfgBackend || 'auto';
  const source = envBackend ? 'env AIRI_GPU_BACKEND' : (cfgBackend ? 'config.gpu.backend' : 'default');

  let device = 0;
  const envDevice = process.env.AIRI_GPU_DEVICE;
  if (envDevice !== undefined && envDevice !== '' && !isNaN(parseInt(envDevice, 10))) {
    device = parseInt(envDevice, 10);
  } else if (config.gpu && config.gpu.device !== undefined && !isNaN(parseInt(config.gpu.device, 10))) {
    device = parseInt(config.gpu.device, 10);
  }

  let backend = null;
  let reason = '';

  if (requested === 'auto') {
    if (hasNvidiaGpu()) {
      backend = 'cuda';
      reason = `auto: NVIDIA GPU detected (compute_cap ${getGpuComputeCap()})`;
    } else {
      const vk = detectVulkanCapableGpu();
      if (vk.length > 0) {
        backend = 'vulkan';
        reason = `auto: no NVIDIA GPU; Vulkan-capable adapter detected (${vk[0]})`;
      } else {
        reason = 'auto: no NVIDIA GPU and no Vulkan-capable adapter detected';
      }
    }
  } else if (VALID_BACKENDS.includes(requested)) {
    backend = requested;
    reason = `explicit (${source})`;
  } else {
    reason = `unsupported backend '${requested}' (${source})`;
  }

  return { backend, device, requested, source, reason, devices: getVideoControllers() };
}

/**
 * Like resolveBackend, but throws a clear, actionable error when no backend can
 * be determined. Callers rely on this so the process never falls back to CPU by
 * accident.
 */
function requireBackend(config = {}) {
  const info = resolveBackend(config);
  if (!info.backend) {
    throw new Error(
      `[GPU] Could not determine an inference backend. ${info.reason}. ` +
      `Set "gpu": { "backend": "cuda" | "vulkan" | "cpu" } in config.json, ` +
      `or export AIRI_GPU_BACKEND.`
    );
  }
  return info;
}

/**
 * Discover CUDA toolkit runtime directories (unchanged algorithm, moved here so
 * every module shares one implementation).
 */
function getCudaPaths(customCudaPath = null) {
  const detectedPaths = new Set();
  const baseCandidates = [];

  if (customCudaPath) {
    if (Array.isArray(customCudaPath)) {
      customCudaPath.forEach(p => baseCandidates.push(resolveFromRoot(p)));
    } else {
      baseCandidates.push(resolveFromRoot(customCudaPath));
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
    } catch (e) { /* ignore unreadable toolkit dir */ }
  }

  if (process.platform !== 'win32') {
    ['/usr/local/cuda', '/usr/local/cuda-13', '/usr/local/cuda-12', '/usr/local/cuda-11', '/opt/cuda']
      .forEach(p => { if (fs.existsSync(p)) baseCandidates.push(p); });
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
      if (fs.existsSync(candidate)) detectedPaths.add(candidate);
    });

    if (fs.existsSync(base)) detectedPaths.add(base);
  });

  return Array.from(detectedPaths);
}

/**
 * Runtime library directories that must be on PATH for the selected backend.
 * CUDA needs its toolkit DLLs; Vulkan's loader normally ships with the driver,
 * but the SDK Bin dir is included when present for safety.
 */
function getBackendRuntimePaths(config = {}, backend = 'cuda') {
  const paths = [];

  if (backend === 'cuda') {
    getCudaPaths(config.cuda_path).forEach(p => paths.push(p));
  } else if (backend === 'vulkan') {
    const sdk = getVulkanSdkPath(config);
    if (sdk) {
      ['Bin', 'bin'].forEach(sub => {
        const dir = path.join(sdk, sub);
        if (fs.existsSync(dir)) paths.push(dir);
      });
    }
  }

  return Array.from(new Set(paths));
}

/**
 * Determine which backend a binary path belongs to, based on its directory.
 * Returns null for custom paths that don't advertise a backend.
 */
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

/**
 * Locate an audio.cpp executable for the selected backend.
 *
 * Resolution order:
 *   1. Explicit preferredPath, when it exists and is not tagged for another backend.
 *   2. Bundled bin/<backend>/ (with an arch-specific smNN variant preferred for CUDA).
 *   3. <working_dir>/build/<backend-build>/bin/ (e.g. ../audio.cpp/build/windows-vulkan-release/bin/).
 *   4. ../audio.cpp/build/<backend-build>/bin/ (legacy default location).
 *
 * Never falls back across backends: a Vulkan request will not silently return a
 * CUDA binary.
 */
function resolveEngineBinary(binaryName, preferredPath = null, backend = null, config = null) {
  const root = projectRoot();
  const cfg = config || {};

  let effectiveBackend = backend;
  if (!effectiveBackend) {
    const info = resolveBackend(cfg);
    effectiveBackend = info.backend;
  }

  // A CUDA or Vulkan build also contains the CPU backend, so a CPU request may
  // legitimately reuse those binaries (documented audio.cpp behaviour).
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

  // 5. Give an explicit preferredPath a final chance even if backend-tagged,
  //    so users pointing at a specific existing binary are never blocked.
  if (preferredPath) {
    const resolvedPreferred = resolveFromRoot(preferredPath);
    if (fs.existsSync(resolvedPreferred)) return resolvedPreferred;
  }

  return null;
}

/**
 * Machine-readable GPU summary for diagnostics and /health.
 */
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
  describeGpu
};
