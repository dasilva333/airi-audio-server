const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const http = require('http');

class AudioCppEngine {
  constructor(config) {
    this.config = config;
    this.process = null;
    this.isReady = false;
    this.activeModel = null;
    this.activeVoice = null;
    this.lastLogs = [];
  }

  logMessage(msg) {
    this.lastLogs.push(msg);
    if (this.lastLogs.length > 100) {
      this.lastLogs.shift();
    }
  }

  resolvePath(relativePath) {
    if (!relativePath) return '';
    if (path.isAbsolute(relativePath)) return relativePath;
    return path.resolve(__dirname, '..', relativePath);
  }

  getServerExePath() {
    if (this.config.audio_cpp?.server_exe) {
      const configuredPath = this.resolvePath(this.config.audio_cpp.server_exe);
      if (fs.existsSync(configuredPath)) return configuredPath;
    }
    // Bundled Pre-built Binary Fallback
    const bundledPath = path.resolve(__dirname, '../bin/windows-cuda/audiocpp_server.exe');
    if (fs.existsSync(bundledPath)) {
      console.log(`[Engine] Using bundled pre-compiled binary: ${bundledPath}`);
      return bundledPath;
    }
    throw new Error(`audiocpp_server executable not found.`);
  }

  getCudaPath() {
    if (this.config.cuda_path) {
      return this.resolvePath(this.config.cuda_path);
    }
    if (process.env.CUDA_PATH) {
      return path.join(process.env.CUDA_PATH, 'bin');
    }
    return "C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v13.1\\bin\\x64";
  }

  getDefaultModelId() {
    if (this.config.installed_models && this.config.installed_models.length > 0) {
      return this.config.installed_models[0];
    }
    return Object.keys(this.config.models)[0] || 'omnivoice-tts';
  }

  resolveModelId(modelId) {
    if (!modelId || modelId === 'tts-1' || modelId === 'chatterbox' || !this.config.models[modelId]) {
      const defaultId = this.getDefaultModelId();
      if (modelId && modelId !== defaultId && modelId !== 'tts-1') {
        console.warn(`[Engine Warning] Requested model '${modelId}' not registered in config.json. Mapping to primary model '${defaultId}'.`);
      }
      return defaultId;
    }
    return modelId;
  }

  async initialize(modelIdInput = null, voiceRef = null, referenceText = '') {
    const modelId = this.resolveModelId(modelIdInput);
    const modelConfig = this.config.models[modelId];

    if (!modelConfig) {
      throw new Error(`Config error: Model '${modelId}' not registered in config.json`);
    }

    const resolvedServerExe = this.getServerExePath();
    let resolvedWorkingDir = this.resolvePath(this.config.audio_cpp?.working_dir || "../audio.cpp");
    if (!fs.existsSync(resolvedWorkingDir)) {
      resolvedWorkingDir = path.dirname(resolvedServerExe);
    }

    const resolvedModelPath = this.resolvePath(modelConfig.path);
    const resolvedVoiceRef = voiceRef ? this.resolvePath(voiceRef) : null;
    const cudaBinPath = this.getCudaPath();

    if (!fs.existsSync(resolvedModelPath)) {
      throw new Error(`Model weights not found at: ${resolvedModelPath}`);
    }

    // Stop existing server process if model or voice preset changed
    if (this.process && (this.activeModel !== modelId || this.activeVoice !== resolvedVoiceRef)) {
      console.log(`[Engine] Hot-swapping audio.cpp for model '${modelId}'...`);
      this.stop();
    }

    if (this.process && this.isReady) {
      return modelId;
    }

    this.lastLogs = [];
    const tempConfigPath = path.join(resolvedWorkingDir, 'server.json');
    const serverConfig = {
      host: '127.0.0.1',
      port: this.config.audio_cpp?.internal_port || 8080,
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
    console.log(`[Engine] Executable : ${resolvedServerExe}`);
    console.log(`[Engine] Config     : ${tempConfigPath}`);
    console.log(`[Engine] CUDA Path  : ${cudaBinPath}`);

    const binDir = path.dirname(resolvedServerExe);

    if (process.platform === 'win32') {
      const runnerBat = path.join(__dirname, '../run_server.bat');
      this.process = spawn(`"${runnerBat}"`, [`"${resolvedServerExe}"`, `"${tempConfigPath}"`, `"${cudaBinPath}"`], {
        cwd: resolvedWorkingDir,
        shell: true
      });
    } else {
      this.process = spawn(resolvedServerExe, ['--config', tempConfigPath], {
        cwd: resolvedWorkingDir,
        env: {
          ...process.env,
          PATH: `${binDir}:${cudaBinPath}:${process.env.PATH}`
        }
      });
    }

    this.activeModel = modelId;
    this.activeVoice = resolvedVoiceRef;

    this.process.stdout.on('data', (data) => {
      const line = data.toString().trim();
      if (line) {
        this.logMessage(`[stdout] ${line}`);
        if (!line.includes('CUDA graph warmup')) {
          console.log(`[audio.cpp] ${line}`);
        }
      }
    });

    this.process.stderr.on('data', (data) => {
      const line = data.toString().trim();
      if (line) {
        this.logMessage(`[stderr] ${line}`);
        // Suppress noisy CUDA graph warmup lines from console
        if (!line.includes('CUDA graph warmup')) {
          console.error(`[audio.cpp err] ${line}`);
        }
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
        const lastErrOutput = this.lastLogs.slice(-20).join('\n');
        throw new Error(`audiocpp_server process exited unexpectedly during initialization.\n--- Captured Engine Logs ---\n${lastErrOutput || 'No stdout/stderr logged.'}`);
      }
      try {
        const ok = await new Promise((resolve) => {
          const req = http.get(`http://127.0.0.1:${this.config.audio_cpp?.internal_port || 8080}/health`, (res) => {
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
    const lastErrOutput = this.lastLogs.slice(-20).join('\n');
    throw new Error(`audiocpp_server health check timed out after 90s.\n--- Captured Engine Logs ---\n${lastErrOutput || 'No stdout/stderr logged.'}`);
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
      const req = http.request(`http://127.0.0.1:${this.config.audio_cpp?.internal_port || 8080}/v1/audio/speech`, {
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
            const lastErrOutput = this.lastLogs.slice(-20).join('\n');
            reject(new Error(`Synthesis request failed with HTTP ${res.statusCode}.\n--- Captured Engine Logs ---\n${lastErrOutput}`));
          }
        });
      });

      req.on('error', (err) => {
        const lastErrOutput = this.lastLogs.slice(-20).join('\n');
        reject(new Error(`Synthesis network error: ${err.message}\n--- Captured Engine Logs ---\n${lastErrOutput}`));
      });

      req.on('timeout', () => {
        req.destroy();
        const lastErrOutput = this.lastLogs.slice(-20).join('\n');
        reject(new Error(`Synthesis request timed out after 120s.\n--- Captured Engine Logs ---\n${lastErrOutput}`));
      });

      req.write(payload);
      req.end();
    });
  }

  stop() {
    if (this.process) {
      try {
        if (process.platform === 'win32') {
          execSync(`taskkill /pid ${this.process.pid} /T /F`);
        } else {
          this.process.kill();
        }
      } catch (e) {}
      this.process = null;
      this.isReady = false;
    }
  }
}

module.exports = AudioCppEngine;
