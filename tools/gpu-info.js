#!/usr/bin/env node
/**
 * GPU / backend diagnostics for AIRI Audio Server.
 *
 * Prints how the effective inference backend was chosen, where the audio.cpp
 * binaries were resolved from, and — when the server is running — what the
 * engine itself reports via /health. Use it to confirm that TTS really runs on
 * the GPU instead of silently falling back to CPU.
 *
 * Usage: npm run gpu-info
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const gpu = require('../src/gpu');

const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  for (const name of ['config.json', 'config.example.json']) {
    const p = path.join(ROOT, name);
    if (fs.existsSync(p)) {
      try {
        return { config: JSON.parse(fs.readFileSync(p, 'utf8')), source: name };
      } catch (e) {
        return { config: {}, source: `${name} (parse error: ${e.message})` };
      }
    }
  }
  return { config: {}, source: '(none)' };
}

function queryHealth(port, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(`http://${host}:${port}/health`, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
  });
}

function line(label, value) {
  console.log(`  ${String(label).padEnd(20)}: ${value}`);
}

async function main() {
  const { config, source } = loadConfig();
  const info = gpu.describeGpu(config);
  const backend = info.backend;

  console.log('='.repeat(64));
  console.log('  AIRI Audio Server - GPU / Backend Diagnostics');
  console.log('='.repeat(64));
  console.log(`Config source       : ${source}`);
  console.log('');

  console.log('Detected hardware');
  line('Video adapters', info.video_controllers.length ? info.video_controllers.join(' | ') : '(none detected)');
  line('NVIDIA GPU', info.nvidia_gpu ? `yes (compute_cap ${info.nvidia_compute_cap})` : 'no');
  line('Vulkan-capable', info.vulkan_capable_devices.length ? info.vulkan_capable_devices.join(' | ') : '(none)');
  console.log('');

  console.log('Backend selection');
  line('Requested', `${info.requested_backend} (${info.backend_source})`);
  line('Resolved backend', backend || 'UNRESOLVED');
  line('Reason', info.backend_reason);
  line('Device index', String(info.device));
  console.log('');

  const workingDirRel = (config.audio_cpp && config.audio_cpp.working_dir) || '../audio.cpp';
  const preferredServer = config.audio_cpp && config.audio_cpp.server_exe;
  const preferredCli = config.audio_cpp && config.audio_cpp.cli_exe;

  const serverExe = backend ? gpu.resolveEngineBinary('audiocpp_server', preferredServer, backend, config) : null;
  const cliExe = backend ? gpu.resolveEngineBinary('audiocpp_cli', preferredCli, backend, config) : null;

  console.log('audio.cpp binaries');
  line('Working dir', path.resolve(ROOT, workingDirRel));
  line('audiocpp_server', serverExe ? `${serverExe} ${fs.existsSync(serverExe) ? '[OK]' : '[MISSING]'}` : `NOT FOUND for backend '${backend}'`);
  line('audiocpp_cli', cliExe ? `${cliExe} ${fs.existsSync(cliExe) ? '[OK]' : '[MISSING]'}` : `NOT FOUND for backend '${backend}'`);
  console.log('');

  if (backend === 'vulkan') {
    console.log('Vulkan toolchain');
    line('Vulkan SDK', info.vulkan_sdk_path || 'NOT FOUND (install the LunarG Vulkan SDK to build)');
    line('glslc available', info.vulkan_glslc_available ? 'yes' : 'no');
    console.log('');
  }

  if (backend === 'cuda') {
    const cudaPaths = gpu.getCudaPaths(config.cuda_path);
    console.log('CUDA toolkit');
    line('Runtime paths', cudaPaths.length ? cudaPaths.join('; ') : 'NOT FOUND');
    console.log('');
  }

  const port = config.port || 8095;
  const health = await queryHealth(port);
  console.log(`Live server (/health on :${port})`);
  if (!health) {
    console.log('  Server not running (or /health unreachable). Start it with: npm start');
  } else {
    line('engine_ready', String(health.engine_ready));
    line('active_model', String(health.active_model));
    line('backend', String(health.backend));
    line('device', String(health.device));
    line('gpu_device', String(health.gpu_device));
    line('cpu_fallback', String(health.cpu_fallback_detected));
    line('engine_exe', String(health.engine_exe));
  }
  console.log('');

  const problems = [];
  if (!backend) problems.push(info.backend_reason);
  if (backend && !serverExe) problems.push(`audiocpp_server not found for backend '${backend}'`);
  if (backend === 'vulkan' && !info.vulkan_sdk_path) {
    problems.push('Vulkan SDK not found (required to build the Vulkan binary; not needed at runtime)');
  }

  console.log('='.repeat(64));
  if (problems.length === 0) {
    console.log('RESULT: OK - a GPU backend is configured and the engine binary was located.');
  } else {
    console.log('RESULT: ACTION NEEDED');
    problems.forEach(p => console.log(`  - ${p}`));
  }
  console.log('='.repeat(64));
}

main().catch(err => {
  console.error('[gpu-info] Error:', err.message);
  process.exit(1);
});
