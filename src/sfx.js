const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { resolveEngineBinary } = require('./gpu');

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

class SfxEngine {
  constructor(config) {
    this.config = config;
  }

  resolveModelPath() {
    const candidatePaths = [
      resolvePath('models/Stable-Audio-3-Small-SFX-GGUF'),
      resolvePath('../audio.cpp/models/Stable-Audio-3-Small-SFX-GGUF'),
      resolvePath('models/stable-audio-3-small-sfx'),
      resolvePath('../audio.cpp/models/stable-audio-3-small-sfx')
    ];

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  isAvailable() {
    const modelDir = this.resolveModelPath();
    if (!modelDir) return false;
    return fs.readdirSync(modelDir).some(f => f.endsWith('.gguf') || f.endsWith('.safetensors'));
  }

  async generateSfx(options = {}) {
    const {
      prompt = '',
      text = '',
      duration_seconds = 6,
      num_inference_steps = 8,
      guidance_scale = 1.0,
      seed = null,
      negative_prompt = ''
    } = options;

    const effectivePrompt = (prompt || text || '').trim();
    if (!effectivePrompt) {
      throw new Error("Missing required 'prompt' or 'text' field for sound effects generation.");
    }

    const cliExe = resolveEngineBinary('audiocpp_cli', this.config.audio_cpp?.cli_exe);
    if (!cliExe || !fs.existsSync(cliExe)) {
      throw new Error(`audiocpp_cli executable not found at: ${cliExe}`);
    }

    const modelDir = this.resolveModelPath();
    if (!modelDir || !fs.existsSync(modelDir)) {
      throw new Error('Stable Audio 3 Small SFX model weights not found. Run npm run add-sfx to install.');
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airi-sfx-gen-'));
    const outputWav = path.join(tempDir, `sfx_${Date.now()}.wav`);

    const dur = Math.max(1, Math.min(120, Math.round(duration_seconds)));
    const steps = Math.max(1, Math.min(50, Math.round(num_inference_steps)));

    const cliArgs = [
      '--task', 'gen',
      '--family', 'stable_audio',
      '--model', modelDir,
      '--backend', 'cuda',
      '--text', effectivePrompt,
      '--duration-seconds', dur.toString(),
      '--num-inference-steps', steps.toString(),
      '--guidance-scale', guidance_scale.toString(),
      '--out', outputWav
    ];

    if (seed !== null && seed !== undefined) {
      cliArgs.push('--seed', seed.toString());
    }

    if (negative_prompt && negative_prompt.trim().length > 0) {
      cliArgs.push('--request-option', `negative_prompt=${negative_prompt.trim()}`);
    }

    const binDir = path.dirname(cliExe);
    const cudaPaths = getCudaPaths(this.config.cuda_path);
    const envPath = [binDir, ...cudaPaths, process.env.PATH].filter(Boolean).join(path.delimiter);

    const tStart = Date.now();
    console.log(`[SFX Engine] Synthesizing sound effect (${dur}s, ${steps} steps): "${effectivePrompt}"`);

    return new Promise((resolve, reject) => {
      const proc = spawn(cliExe, cliArgs, {
        cwd: path.dirname(cliExe),
        env: { ...process.env, PATH: envPath }
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', d => {
        const str = d.toString();
        stdout += str;
        if (str.includes('step') || str.includes('RTF') || str.includes('latent')) {
          console.log(`[SFX Engine] ${str.trim()}`);
        }
      });

      proc.stderr.on('data', d => {
        stderr += d.toString();
      });

      proc.on('close', (code) => {
        const latencyMs = Date.now() - tStart;
        if (code === 0 && fs.existsSync(outputWav) && fs.statSync(outputWav).size > 44) {
          const wavBuffer = fs.readFileSync(outputWav);

          try {
            fs.rmSync(tempDir, { recursive: true, force: true });
          } catch (e) {}

          resolve({
            audio_buffer: wavBuffer,
            latency_ms: latencyMs,
            sample_rate: 44100,
            duration_seconds: dur,
            prompt: effectivePrompt
          });
        } else {
          try {
            fs.rmSync(tempDir, { recursive: true, force: true });
          } catch (e) {}
          const errorMsg = stderr || stdout || `Process exited with code ${code}`;
          reject(new Error(`SFX generation failed with exit code ${code}.\nLogs:\n${errorMsg}`));
        }
      });

      proc.on('error', (err) => {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (e) {}
        reject(new Error(`Failed to execute audiocpp_cli for SFX: ${err.message}`));
      });
    });
  }
}

module.exports = SfxEngine;
