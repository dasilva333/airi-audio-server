const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

class AudioCppEngine {
  constructor(config) {
    this.config = config;
    this.process = null;
    this.isReady = false;
    this.activeModel = null;
    this.activeVoice = null;
  }

  resolvePath(relativePath) {
    if (!relativePath) return '';
    if (path.isAbsolute(relativePath)) return relativePath;
    return path.resolve(__dirname, '..', relativePath);
  }

  getDefaultModelId() {
    if (this.config.installed_models && this.config.installed_models.length > 0) {
      return this.config.installed_models[0];
    }
    return Object.keys(this.config.models)[0] || 'omnivoice-tts';
  }

  resolveModelId(modelId) {
    if (!modelId || modelId === 'tts-1' || !this.config.models[modelId]) {
      return this.getDefaultModelId();
    }
    return modelId;
  }

  async initialize(modelIdInput = null, voiceRef = null, referenceText = '') {
    const modelId = this.resolveModelId(modelIdInput);
    const modelConfig = this.config.models[modelId];

    if (!modelConfig) {
      throw new Error(`Config error: Model '${modelId}' not registered in config.json`);
    }

    const resolvedWorkingDir = this.resolvePath(this.config.audio_cpp.working_dir);
    const resolvedServerExe = this.resolvePath(this.config.audio_cpp.server_exe);
    const resolvedModelPath = this.resolvePath(modelConfig.path);
    const resolvedVoiceRef = voiceRef ? this.resolvePath(voiceRef) : null;

    // Ensure working directory exists
    if (!fs.existsSync(resolvedWorkingDir)) {
      fs.mkdirSync(resolvedWorkingDir, { recursive: true });
    }

    // Stop existing server process if model or voice preset changed
    if (this.process && (this.activeModel !== modelId || this.activeVoice !== resolvedVoiceRef)) {
      console.log(`[Engine] Hot-swapping audio.cpp for model '${modelId}'...`);
      this.stop();
    }

    if (this.process && this.isReady) {
      return modelId;
    }

    const tempConfigPath = path.join(resolvedWorkingDir, 'server.json');
    const serverConfig = {
      host: '127.0.0.1',
      port: this.config.audio_cpp.internal_port,
      backend: 'cuda',
      device: 0,
      threads: 4,
      lazy_load: false,
      models: [
        {
          id: modelId,
          family: modelConfig.family,
          path: resolvedModelPath,
          task: 'tts',
          mode: 'offline',
          session_options: {
            cuda_graphs: 'true',
            mem_saver: 'true'
          },
          ...(resolvedVoiceRef ? {
            default_voice_preset: {
              voice_ref: resolvedVoiceRef,
              reference_text: referenceText || ''
            }
          } : {})
        }
      ]
    };

    // Auto-create/write server.json
    fs.writeFileSync(tempConfigPath, JSON.stringify(serverConfig, null, 2), 'utf-8');

    console.log(`[Engine] Spawning audiocpp_server.exe (${modelId})...`);
    console.log(`[Engine] Executable: ${resolvedServerExe}`);
    console.log(`[Engine] Config: ${tempConfigPath}`);

    const cudaPath = process.env.CUDA_PATH 
      ? path.join(process.env.CUDA_PATH, 'bin')
      : "C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v13.1\\bin\\x64";
      
    const env = {
      ...process.env,
      PATH: `${cudaPath};${process.env.PATH}`
    };

    this.process = spawn(resolvedServerExe, ['--config', tempConfigPath], {
      cwd: resolvedWorkingDir,
      env
    });

    this.activeModel = modelId;
    this.activeVoice = resolvedVoiceRef;

    this.process.stdout.on('data', (data) => {
      const line = data.toString().trim();
      if (line && !line.includes('CUDA graph warmup')) {
        console.log(`[audio.cpp] ${line}`);
      }
    });

    this.process.stderr.on('data', (data) => {
      const line = data.toString().trim();
      // Suppress noisy CUDA graph warmup lines
      if (line && !line.includes('CUDA graph warmup')) {
        console.error(`[audio.cpp err] ${line}`);
      }
    });

    this.process.on('exit', (code) => {
      console.log(`[Engine] audiocpp_server process exited with code ${code}`);
      this.isReady = false;
      this.process = null;
    });

    // Wait for server health check
    await this.pollHealthCheck();
    this.isReady = true;
    console.log(`[Engine] audiocpp_server is READY (${modelId})!`);
    return modelId;
  }

  async pollHealthCheck(timeoutMs = 90000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (!this.process) {
        throw new Error("Server process exited unexpectedly.");
      }
      try {
        const ok = await new Promise((resolve) => {
          const req = http.get(`http://127.0.0.1:${this.config.audio_cpp.internal_port}/health`, (res) => {
            resolve(res.statusCode === 200);
          });
          req.on('error', () => resolve(false));
          req.setTimeout(1000, () => {
            req.destroy();
            resolve(false);
          });
        });
        if (ok) return true;
      } catch (e) {
        // continue polling
      }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error("audiocpp_server health check timed out.");
  }

  async synthesize(promptInput, modelIdInput = null, voiceRef = null, referenceText = '') {
    const resolvedModelId = await this.initialize(modelIdInput, voiceRef, referenceText);

    const resolvedVoiceRef = voiceRef ? this.resolvePath(voiceRef) : null;

    const payload = JSON.stringify({
      model: resolvedModelId,
      input: promptInput,
      ...(resolvedVoiceRef ? { voice_ref: resolvedVoiceRef, reference_text: referenceText } : {})
    });

    return new Promise((resolve, reject) => {
      const req = http.request(`http://127.0.0.1:${this.config.audio_cpp.internal_port}/v1/audio/speech`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 120000
      }, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(Buffer.concat(chunks));
          } else {
            reject(new Error(`Synthesis request failed with status ${res.statusCode}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error("Synthesis request timed out."));
      });

      req.write(payload);
      req.end();
    });
  }

  stop() {
    if (this.process) {
      this.process.kill();
      this.process = null;
      this.isReady = false;
    }
  }
}

module.exports = AudioCppEngine;
