const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  resolveEngineBinary,
  getCudaPaths,
  getBackendRuntimePaths,
  resolveBackend
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
 * Runs audiocpp_cli as a one-shot process so GPU memory is released as soon as
 * the transcript is produced, leaving VRAM free for TTS synthesis. Returns an
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
  let modelRel = cfg.model_path || 'models/Citrinet-ASR-GGUF/citrinet-asr-q8_0.gguf';
  if (family === 'parakeet_tdt') {
    const citrinetModel = resolvePath('models/Citrinet-ASR-GGUF/citrinet-asr-q8_0.gguf');
    if (fs.existsSync(citrinetModel)) {
      family = 'citrinet_asr';
      modelRel = 'models/Citrinet-ASR-GGUF/citrinet-asr-q8_0.gguf';
    }
  }

  const modelPath = resolvePath(modelRel);
  const timeoutMs = cfg.timeout_ms || 120000;

  const resolvedAudio = path.resolve(audioPath);

  if (!cliExe || !fs.existsSync(cliExe)) {
    console.warn(`[ASR] audiocpp_cli not found for backend '${backend}'. Skipping transcription.`);
    return '';
  }
  if (!modelPath || !fs.existsSync(modelPath)) {
    console.warn(`[ASR] ASR model weights not found at '${modelPath}'. Skipping transcription.`);
    return '';
  }
  if (!fs.existsSync(resolvedAudio)) {
    console.warn(`[ASR] Audio file not found: ${resolvedAudio}`);
    return '';
  }

  // Ensure audio is in WAV PCM format before feeding to audiocpp_cli
  let inputForCli = resolvedAudio;
  let tempWav = null;
  const ext = path.extname(resolvedAudio).toLowerCase();
  if (ext !== '.wav') {
    tempWav = path.join(os.tmpdir(), `airi-asr-norm-${process.pid}-${Date.now()}.wav`);
    try {
      await normalizeAudioToWav(resolvedAudio, tempWav);
      inputForCli = tempWav;
    } catch (normErr) {
      console.warn(`[ASR Warning] Could not convert ${path.basename(resolvedAudio)} to WAV: ${normErr.message}`);
    }
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
    let settled = false;

    const finish = (text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { fs.unlinkSync(outFile); } catch (e) {}
      if (tempWav) {
        try { fs.unlinkSync(tempWav); } catch (e) {}
      }
      resolve(text);
    };

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (e) {}
      console.error(`[ASR Error] Transcription timed out after ${timeoutMs}ms.`);
      finish('');
    }, timeoutMs);

    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());

    proc.on('error', (err) => {
      console.error(`[ASR Error] Failed to run audiocpp_cli: ${err.message}`);
      finish('');
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        const detail = (stderr.trim() || stdout.trim()).split('\n').slice(-5).join('\n');
        console.error(`[ASR Error] audiocpp_cli exited with code ${code}.\n${detail}`);
        return finish('');
      }

      let text = '';
      try {
        if (fs.existsSync(outFile)) text = fs.readFileSync(outFile, 'utf-8').trim();
      } catch (e) {}

      // The CLI also echoes the transcript on stdout; use it if --text-out produced nothing.
      if (!text) {
        const match = stdout.match(/^text_output=(.*)$/m);
        if (match) text = match[1].trim();
      }

      if (!text) {
        console.warn(`[ASR] Produced no transcript for ${path.basename(resolvedAudio)}.`);
        return finish('');
      }

      console.log(`[ASR] Transcribed: "${text}"`);
      finish(text);
    });
  });
}

module.exports = {
  transcribeAudio,
  resolveAsrBackend,
  // Re-exported from the shared GPU module for backward compatibility.
  getCudaPaths
};
