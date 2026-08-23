const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

function resolvePath(relativePath) {
  if (!relativePath) return '';
  if (path.isAbsolute(relativePath)) return relativePath;
  return path.resolve(__dirname, '..', relativePath);
}

function getCudaPaths(customCudaPath) {
  const detectedPaths = new Set();
  const baseCandidates = [];

  if (customCudaPath) {
    if (Array.isArray(customCudaPath)) {
      customCudaPath.forEach(p => baseCandidates.push(resolvePath(p)));
    } else {
      baseCandidates.push(resolvePath(customCudaPath));
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

    const binDir = path.dirname(cliExe);
    const cudaPaths = getCudaPaths(cfg.cuda_path);
    const envPath = [binDir, ...cudaPaths, process.env.PATH].filter(Boolean).join(path.delimiter);

    const proc = spawn(cliExe, [
      '--task', 'asr',
      '--family', family,
      '--model', modelPath,
      '--backend', backend,
      '--audio', resolvedAudio,
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
