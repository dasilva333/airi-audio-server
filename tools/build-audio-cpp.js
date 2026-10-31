#!/usr/bin/env node
/**
 * Build the audio.cpp engine for a selected GPU backend.
 *
 *   node tools/build-audio-cpp.js [vulkan|cuda|cpu]
 *
 * Responsibilities:
 *   - Ensure the audio.cpp checkout exists (clone when missing).
 *   - Detect the build toolchain and report *specifically* what is missing
 *     instead of failing deep inside CMake.
 *   - Build the audiocpp_server and audiocpp_cli targets using the upstream
 *     Windows helper script (preferred) or a CMake fallback.
 *
 * Exit code is non-zero when prerequisites are missing or the build fails, so
 * install scripts can react to it.
 */

const { spawnSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const gpu = require('../src/gpu');

const ROOT = path.resolve(__dirname, '..');
const AUDIO_CPP_DIR = path.resolve(ROOT, '..', 'audio.cpp');
const AUDIO_CPP_REPO = 'https://github.com/0xShug0/audio.cpp';

function loadConfig() {
  for (const name of ['config.json', 'config.example.json']) {
    const p = path.join(ROOT, name);
    if (fs.existsSync(p)) {
      try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { /* fall through */ }
    }
  }
  return {};
}

const BACKEND_CONFIG = {
  vulkan: { preset: 'windows-vulkan-release', buildDir: 'windows-vulkan-release', flag: 'ENGINE_ENABLE_VULKAN' },
  cuda: { preset: 'windows-cuda-release', buildDir: 'windows-cuda-release', flag: 'ENGINE_ENABLE_CUDA' },
  cpu: { preset: 'windows-cpu-release', buildDir: 'windows-cpu-release', flag: null }
};

function which(cmd) {
  try {
    const probe = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`;
    const out = execSync(probe, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 5000 });
    const first = out.split(/\r?\n/)[0].trim();
    return first || null;
  } catch (e) {
    return null;
  }
}

function findVswhere() {
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const vswhere = path.join(pf86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  return fs.existsSync(vswhere) ? vswhere : null;
}

function hasMsvc() {
  const vswhere = findVswhere();
  if (!vswhere) return false;
  try {
    const out = execSync(
      `"${vswhere}" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`,
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 8000 }
    );
    return Boolean(out.trim());
  } catch (e) {
    return false;
  }
}

function detectPrereqs(backend, config = {}) {
  const missing = [];
  const hints = [];

  if (!which('git')) {
    missing.push('git (required to clone audio.cpp)');
    hints.push('winget install Git.Git');
  }
  if (!which('cmake')) {
    missing.push('CMake');
    hints.push('winget install Kitware.CMake');
  }
  if (!which('ninja')) {
    missing.push('Ninja');
    hints.push('winget install Ninja-build.Ninja');
  }
  if (!hasMsvc()) {
    missing.push('Visual Studio Build Tools 2022 with the C++ desktop workload (MSVC x64)');
    hints.push('winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"');
  }

  if (backend === 'vulkan') {
    const sdk = gpu.getVulkanSdkPath(config);
    if (!sdk) {
      missing.push('LunarG Vulkan SDK (sets VULKAN_SDK)');
      hints.push('winget install KhronosGroup.VulkanSDK');
    }
    if (!gpu.hasGlslc(config)) {
      missing.push('glslc compiler (part of the LunarG Vulkan SDK)');
    }
  }

  if (backend === 'cuda') {
    const cudaPaths = gpu.getCudaPaths();
    if (cudaPaths.length === 0) {
      missing.push('NVIDIA CUDA Toolkit (CUDA_PATH not set and no toolkit detected)');
      hints.push('https://developer.nvidia.com/cuda-downloads');
    }
  }

  return { missing, hints };
}

function run(cmd, args, opts = {}) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.error) {
    console.error(`[build] Failed to launch '${cmd}': ${res.error.message}`);
    return false;
  }
  return res.status === 0;
}

function ensureAudioCpp() {
  if (fs.existsSync(path.join(AUDIO_CPP_DIR, 'CMakeLists.txt'))) return true;
  console.log(`[build] audio.cpp not found at ${AUDIO_CPP_DIR}. Cloning...`);
  return run('git', ['clone', '--depth', '1', AUDIO_CPP_REPO, AUDIO_CPP_DIR]);
}

function main() {
  const backend = (process.argv[2] || 'vulkan').toLowerCase();
  const cfg = BACKEND_CONFIG[backend];
  if (!cfg) {
    console.error(`Unknown backend '${backend}'. Use one of: ${Object.keys(BACKEND_CONFIG).join(', ')}`);
    process.exit(2);
  }

  console.log('='.repeat(64));
  console.log(`  audio.cpp build - backend: ${backend}`);
  console.log('='.repeat(64));

  const config = loadConfig();
  const { missing, hints } = detectPrereqs(backend, config);
  if (missing.length > 0) {
    console.log('\nMISSING PREREQUISITES:');
    missing.forEach(m => console.log(`  - ${m}`));
    if (hints.length) {
      console.log('\nSuggested install commands:');
      hints.forEach(h => console.log(`  ${h}`));
    }
    console.log('\nInstall the items above and re-run: npm run build:' + backend);
    process.exit(1);
  }

  if (!ensureAudioCpp()) {
    console.error('[build] Could not obtain the audio.cpp source tree.');
    process.exit(1);
  }

  // Expose the detected Vulkan SDK to the build subprocess.
  if (backend === 'vulkan') {
    const sdk = gpu.getVulkanSdkPath(config);
    if (sdk && !process.env.VULKAN_SDK) process.env.VULKAN_SDK = sdk;
  }

  const script = path.join(AUDIO_CPP_DIR, 'scripts', 'build_windows.ps1');
  let ok = true;

  if (process.platform === 'win32' && fs.existsSync(script)) {
    for (const target of ['audiocpp_server', 'audiocpp_cli']) {
      ok = run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Preset', cfg.preset, '-Target', target], { cwd: AUDIO_CPP_DIR }) && ok;
    }
  } else {
    const configureArgs = ['-S', '.', '-B', cfg.buildDir, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release'];
    if (cfg.flag) configureArgs.push(`-D${cfg.flag}=ON`);
    ok = run('cmake', configureArgs, { cwd: AUDIO_CPP_DIR }) && ok;
    for (const target of ['audiocpp_server', 'audiocpp_cli']) {
      ok = run('cmake', ['--build', cfg.buildDir, '--config', 'Release', '--parallel', '--target', target], { cwd: AUDIO_CPP_DIR }) && ok;
    }
  }

  const outDir = path.join(AUDIO_CPP_DIR, 'build', cfg.buildDir, 'bin');
  const serverExe = path.join(outDir, 'audiocpp_server.exe');
  const cliExe = path.join(outDir, 'audiocpp_cli.exe');

  console.log('\n' + '='.repeat(64));
  if (ok && fs.existsSync(serverExe)) {
    console.log('BUILD SUCCEEDED');
    console.log(`  ${serverExe}`);
    if (fs.existsSync(cliExe)) console.log(`  ${cliExe}`);
    console.log('\nThe server auto-discovers this build via build/' + cfg.buildDir + '/bin/.');
  } else {
    console.log('BUILD FAILED');
    console.log('Review the compiler output above. The most common causes are a missing');
    console.log('Vulkan SDK / glslc (Vulkan) or an MSVC environment that CMake cannot locate.');
    process.exit(1);
  }
}

main();
