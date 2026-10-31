const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  resolveEngineBinary,
  getCudaPaths,
  getBackendRuntimePaths,
  resolveBackend,
  isCudaMissingExitCode
} = require('./gpu');

function resolvePath(relativePath) {
  if (!relativePath) return '';
  if (path.isAbsolute(relativePath)) return relativePath;
  return path.resolve(__dirname, '..', relativePath);
}

/**
 * Determine the backend for a one-shot CLI ASR run.
 *
 * ASR follows the app-wide GPU backend unless asr.backend is set to something
 * other than "auto", in which case that explicit value wins.
 */
function resolveAsrBackend(asrConfig, appConfig) {
  const raw = asrConfig && asrConfig.backend ? String(asrConfig.backend).trim().toLowerCase() : '';
  const info = resolveBackend(appConfig || {});
  if (!raw || raw === 'auto') {
    return { backend: info.backend || 'cpu', device: info.device };
  }
  return { backend: raw, device: info.device };
}

/**
 * Transcribe an audio file with the local audio.cpp ASR engine.
 *
 * Uses the Citrinet ASR model via `audiocpp_cli --task asr`. Returns the
 * transcribed text directly, or an empty string if transcription fails. Returns
 * empty string on any failure: a wrong transcript degrades zero-shot cloning
 * more than a missing one, so callers decide what to fall back to.
 */
async function transcribeAudio(audioPath, asrConfig, appConfig = {}) {
  const { normalizeAudioToWav } = require('./ffmpeg');
  const cfg = asrConfig || {};

  const { backend, device } = resolveAsrBackend(cfg, appConfig);
  const cliExe = resolveEngineBinary('audiocpp_cli', cfg.cli_exe, backend, appConfig);

  // Auto-migrate legacy parakeet_tdt or default to native citrinet_asr
  let family = cfg.family || 'citrinet_asr';
  let modelRel = cfg.model_path || 'models/asr-citrinet-512-en.gguf';

  if (family === 'parakeet_tdt' || modelRel.includes('parakeet')) {
    console.warn(`[ASR Warning] Parakeet ASR is deprecated and incompatible with audio.cpp runtime.`);
    console.warn(`[ASR Warning] Automatically routing to Citrinet ASR model.`);
    family = 'citrinet_asr';
    modelRel = 'models/asr-citrinet-512-en.gguf';
  }

  const modelPath = resolvePath(modelRel);
  const timeoutMs = cfg.timeout_ms || 120000;

  const resolvedAudio = path.resolve(audioPath);

  if (!cliExe || !fs.existsSync(cliExe)) {
    console.warn(`[ASR] audiocpp_cli not found for backend '${backend}'. Skipping transcription.`);
    return '';
  }
  if (!modelPath || !fs.existsSync(modelPath)) {
    console.warn(`[ASR] ASR model not found at '${modelPath}'. Skipping transcription.`);
    return '';
  }

  // Pre-normalize audio to 16kHz mono WAV (audio.cpp citrinet requirement)
  let inputForCli = resolvedAudio;
  let tempConvertedPath = null;
  try {
    tempConvertedPath = path.join(os.tmpdir(), `airi-asr-norm-${process.pid}-${Date.now()}.wav`);
    await normalizeAudioToWav(resolvedAudio, tempConvertedPath, 16000);
    inputForCli = tempConvertedPath;
  } catch (e) {
    // If ffmpeg normalization fails, fallback to passing raw file
    inputForCli = resolvedAudio;
  }

  return new Promise((resolve) => {
    const outFile = path.join(os.tmpdir(), `airi-asr-${process.pid}-${Date.now()}.txt`);
    console.log(`[ASR] Transcribing ${path.basename(resolvedAudio)} via ${family} (backend: ${backend})...`);

    const binDir = path.dirname(cliExe);
    // Merge the ASR-level cuda_path (if any) into the app config for runtime path discovery.
    const runtimeConfig = { ...appConfig, cuda_path: cfg.cuda_path || appConfig.cuda_path };
    const runtimePaths = getBackendRuntimePaths(runtimeConfig, backend);
    const envPath = [binDir, ...runtimePaths, process.env.PATH].filter(Boolean).join(path.delimiter);

    const proc = spawn(cliExe, [
      '--task', 'asr',
      '--family', family,
      '--model', modelPath,
      '--backend', backend,
      '--device', String(device),
      '--audio', inputForCli,
      '--text-out', outFile,
    ], {
      env: {
        ...process.env,
        PATH: envPath
      }
    });

    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        try { proc.kill(); } catch (e) {}
        console.warn(`[ASR] Transcription timed out after ${timeoutMs / 1000}s`);
        finish('');
      }
    }, timeoutMs);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    function finish(result) {
      clearTimeout(timer);
      try {
        if (tempConvertedPath && fs.existsSync(tempConvertedPath)) {
          fs.unlinkSync(tempConvertedPath);
        }
      } catch (e) {}
      try {
        if (fs.existsSync(outFile)) {
          fs.unlinkSync(outFile);
        }
      } catch (e) {}
      resolve(result);
    }

    proc.on('close', (code) => {
      if (code !== 0) {
        if (backend === 'cuda' && isCudaMissingExitCode(code)) {
          console.error(`\n[ASR Error] audiocpp_cli failed to start: NVIDIA CUDA runtime libraries (cublas64_13.dll) not found.\nPlease install NVIDIA CUDA Toolkit: https://developer.nvidia.com/cuda-downloads\n`);
        } else {
          const detail = (stderr.trim() || stdout.trim()).split('\n').slice(-5).join('\n');
          console.error(`[ASR Error] audiocpp_cli exited with code ${code}.\n${detail}`);
        }
        return finish('');
      }

      try {
        if (fs.existsSync(outFile)) {
          const transcript = fs.readFileSync(outFile, 'utf8').trim();
          console.log(`[ASR Success] Transcript: "${transcript}"`);
          return finish(transcript);
        }
      } catch (readErr) {
        console.warn(`[ASR] Failed reading transcript output: ${readErr.message}`);
      }

      finish('');
    });

    proc.on('error', (err) => {
      console.error(`[ASR Error] Failed to launch audiocpp_cli: ${err.message}`);
      finish('');
    });
  });
}

module.exports = {
  transcribeAudio,
  resolveAsrBackend,
  // Re-exported from the shared GPU module for backward compatibility.
  getCudaPaths
};
