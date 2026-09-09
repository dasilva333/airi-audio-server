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

module.exports = {
  getGpuComputeCap,
  getGpuArchSuffix,
  resolveEngineBinary
};
