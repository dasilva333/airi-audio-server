const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  resolveEngineBinary,
  requireBackend,
  getBackendRuntimePaths
} = require('./gpu');

function resolvePath(relativePath) {
  if (!relativePath) return '';
  if (path.isAbsolute(relativePath)) return relativePath;
  return path.resolve(__dirname, '..', relativePath);
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

    const backendInfo = requireBackend(this.config);
    const backend = backendInfo.backend;

    const cliExe = resolveEngineBinary('audiocpp_cli', this.config.audio_cpp?.cli_exe, backend, this.config);
    if (!cliExe || !fs.existsSync(cliExe)) {
      throw new Error(`audiocpp_cli executable not found for backend '${backend}'.`);
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
      '--backend', backend,
      '--device', String(backendInfo.device),
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
    const runtimePaths = getBackendRuntimePaths(this.config, backend);
    const envPath = [binDir, ...runtimePaths, process.env.PATH].filter(Boolean).join(path.delimiter);

    const tStart = Date.now();
    console.log(`[SFX Engine] Synthesizing sound effect (${dur}s, ${steps} steps, backend=${backend}): "${effectivePrompt}"`);

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
