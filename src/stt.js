const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

function resolvePath(relativePath) {
  if (!relativePath) return '';
  if (path.isAbsolute(relativePath)) return relativePath;
  return path.resolve(__dirname, '..', relativePath);
}

/**
 * Transcribe an audio file with the local audio.cpp ASR engine.
 *
 * Runs audiocpp_cli as a one-shot process so GPU memory is released as soon as
 * the transcript is produced, leaving VRAM free for TTS synthesis. Returns an
 * empty string on any failure: a wrong transcript degrades zero-shot cloning
 * more than a missing one, so callers decide what to fall back to.
 */
function transcribeAudio(audioPath, asrConfig) {
  return new Promise((resolve) => {
    const cfg = asrConfig || {};
    const cliExe = resolvePath(cfg.cli_exe);
    const modelPath = resolvePath(cfg.model_path);
    const family = cfg.family || 'parakeet_tdt';
    const backend = cfg.backend || 'cuda';
    const timeoutMs = cfg.timeout_ms || 120000;

    const resolvedAudio = path.resolve(audioPath);

    if (!cliExe || !fs.existsSync(cliExe)) {
      console.warn(`[ASR] audiocpp_cli not found at '${cliExe}'. Skipping transcription.`);
      return resolve('');
    }
    if (!modelPath || !fs.existsSync(modelPath)) {
      console.warn(`[ASR] ASR model weights not found at '${modelPath}'. Skipping transcription.`);
      return resolve('');
    }
    if (!fs.existsSync(resolvedAudio)) {
      console.warn(`[ASR] Audio file not found: ${resolvedAudio}`);
      return resolve('');
    }

    const outFile = path.join(os.tmpdir(), `airi-asr-${process.pid}-${Date.now()}.txt`);
    console.log(`[ASR] Transcribing ${path.basename(resolvedAudio)} via ${family}...`);

    const proc = spawn(cliExe, [
      '--task', 'asr',
      '--family', family,
      '--model', modelPath,
      '--backend', backend,
      '--audio', resolvedAudio,
      '--text-out', outFile,
    ]);

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { fs.unlinkSync(outFile); } catch (e) {}
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

module.exports = { transcribeAudio };
