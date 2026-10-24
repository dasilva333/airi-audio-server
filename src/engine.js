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
    this.keepAliveTimer = null;
    this.lastSynthesisAt = 0;
    this.keepAliveInFlight = false;
    // The raw arguments of the last real request. The warmer must replay these
    // verbatim: initialize() hot-swaps whenever the voice differs, so a ping with a
    // null voiceRef would restart the engine on every tick.
    this.lastVoiceRef = null;
    this.lastReferenceText = '';
  }

  noteSynthesis(voiceRef, referenceText) {
    this.lastSynthesisAt = Date.now();
    this.lastVoiceRef = voiceRef;
    this.lastReferenceText = referenceText || '';
  }

  /**
   * Synthesis is ~1.5s on a warm engine but ~15s once it has sat idle for under a
   * minute, even though the weights stay resident in VRAM the whole time. A tiny
   * throwaway generation on an interval keeps it in the fast state.
   * Disabled when keep_alive_interval_ms <= 0 (default: 0).
   */
  startKeepAlive() {
    const intervalMs = this.config.audio_cpp?.keep_alive_interval_ms ?? 0;
    if (intervalMs <= 0 || this.keepAliveTimer) return;

    this.keepAliveTimer = setInterval(() => {
      if (!this.isReady || !this.process) return;
      // A real request already keeps the engine warm; only fill in the gaps.
      if (Date.now() - this.lastSynthesisAt < intervalMs) return;
      if (this.keepAliveInFlight) return;

      // Ping the voice that is actually loaded, not the last one requested. When two
      // voices alternate those differ, and initialize() would hot-swap the engine on
      // every tick — the exact stall the warmer exists to prevent.
      const model = this.activeModel;
      const voice = this.activeVoice;
      if (!model) return;

      this.keepAliveInFlight = true;
      this.synthesize('Hm.', model, voice, this.lastReferenceText)
        .catch(() => {})
        .finally(() => { this.keepAliveInFlight = false; });
    }, intervalMs);

    // Never hold the event loop open on account of the warmer.
    if (this.keepAliveTimer.unref) this.keepAliveTimer.unref();
  }

  stopKeepAlive() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
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
    const { resolveEngineBinary } = require('./gpu');
    const configured = this.config.audio_cpp?.server_exe;
    const resolved = resolveEngineBinary('audiocpp_server', configured);
    if (resolved) return resolved;
    throw new Error('audiocpp_server executable not found. Please verify bin/windows-cuda/ or compile audio.cpp.');
  }

  getCudaPaths() {
    const { getCudaPaths } = require('./gpu');
    const result = getCudaPaths(this.config.cuda_path);
    if (result.length === 0) {
      console.warn('[Engine] WARNING: CUDA toolkit not found. Set CUDA_PATH environment variable or cuda_path in config.json.');
    }
    return result;
  }

  getCudaPath() {
    return this.getCudaPaths().join(path.delimiter);
  }

  getDefaultModelId() {
    if (this.config.installed_models && this.config.installed_models.length > 0) {
      return this.config.installed_models[0];
    }
    return Object.keys(this.config.models)[0] || 'omnivoice-tts';
  }

  resolveModelId(modelId) {
    if (!modelId || modelId === 'tts-1' || modelId === 'chatterbox') {
      return this.getDefaultModelId();
    }
    if (this.config.models && this.config.models[modelId]) {
      return modelId;
    }
    // Check friendly aliases (e.g. 'higgs' -> 'higgs-audio-tts', 'omni' -> 'omnivoice-tts', 'fish' -> 'fish-audio-tts')
    if (this.config.models) {
      const cleanReq = modelId.toLowerCase().replace(/[-_]/g, '');
      for (const id of Object.keys(this.config.models)) {
        const cleanId = id.toLowerCase().replace(/[-_]/g, '');
        if (cleanId === cleanReq || cleanId.includes(cleanReq) || cleanReq.includes(cleanId.replace('tts', ''))) {
          return id;
        }
      }
    }
    const defaultId = this.getDefaultModelId();
    if (modelId !== defaultId) {
      console.warn(`[Engine Warning] Requested model '${modelId}' not registered in config.json. Mapping to primary model '${defaultId}'.`);
    }
    return defaultId;
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
      throw new Error(`Model weights file (.gguf) not found at:\n  ${resolvedModelPath}\n\nPlease download the .gguf model weights file and place it in that directory.`);
    }

    // Stop existing server process if model or voice preset changed
    if (this.process && (this.activeModel !== modelId || this.activeVoice !== resolvedVoiceRef)) {
      console.log(`[Engine] Hot-swapping audio.cpp for model '${modelId}'...`);
      // Wait for the old process to actually exit before spawning its replacement,
      // otherwise the two race for the internal port.
      await this.waitForExit(this.stop());
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
      threads: this.config.audio_cpp?.threads || 8,
      lazy_load: false,
      models: [
        {
          id: modelId,
          family: modelConfig.family,
          path: resolvedModelPath,
          task: 'tts',
          // Streaming sessions also serve ordinary non-SSE requests, so this is safe
          // for the buffered path and enables SSE for callers that ask for it. Models
          // whose audio.cpp integration lacks streaming can opt out via config.
          mode: modelConfig.mode || (modelConfig.family === 'fish_audio' ? 'offline' : 'streaming'),
          session_options: {
            cuda_graphs: modelConfig.session_options?.cuda_graphs || (modelConfig.family === 'fish_drama3' ? 'false' : 'true'),
            mem_saver: 'true',
            ...(modelConfig.session_options || {})
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
    const disableCudaGraphs = modelConfig.session_options?.cuda_graphs === 'false' || modelConfig.family === 'fish_drama3';
    const currentPath = process.env.PATH || process.env.Path || '';
    const envOverrides = {
      ...process.env,
      PATH: `${binDir};${cudaBinPath};${currentPath}`,
      ...(disableCudaGraphs ? { GGML_CUDA_DISABLE_GRAPHS: '1' } : {})
    };
    delete envOverrides.Path;

    if (process.platform === 'win32') {
      const runnerBat = path.join(__dirname, '../run_server.bat');
      this.process = spawn(`"${runnerBat}"`, [`"${resolvedServerExe}"`, `"${tempConfigPath}"`, `"${cudaBinPath}"`], {
        cwd: resolvedWorkingDir,
        shell: true,
        env: envOverrides
      });
    } else {
      this.process = spawn(resolvedServerExe, ['--config', tempConfigPath], {
        cwd: resolvedWorkingDir,
        env: envOverrides
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

    // Captured so a late 'exit' from a superseded process cannot clear the state of
    // whichever process is current by the time it fires.
    const spawnedChild = this.process;
    this.lastExitCode = null;
    this.process.on('exit', (code) => {
      if (this.process !== spawnedChild) return;
      console.log(`[Engine] audiocpp_server process exited with code ${code}`);
      this.lastExitCode = code;
      this.isReady = false;
      this.process = null;
    });

    // Wait for server health check
    await this.pollHealthCheck();
    this.isReady = true;
    console.log(`[Engine] audiocpp_server is READY (${modelId})!`);
    this.startKeepAlive();
    return modelId;
  }

  async pollHealthCheck(timeoutMs = 300000) {
    const { isCudaMissingExitCode, formatCudaMissingBanner, getGpuComputeCap } = require('./gpu');
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (!this.process) {
        if (isCudaMissingExitCode(this.lastExitCode)) {
          const banner = formatCudaMissingBanner(getGpuComputeCap());
          console.error(`\n${banner}\n`);
          throw new Error(banner);
        }
        const lastErrOutput = this.lastLogs.slice(-20).join('\n');
        throw new Error(`audiocpp_server process exited unexpectedly during initialization (code ${this.lastExitCode}).\n--- Captured Engine Logs ---\n${lastErrOutput || 'No stdout/stderr logged.'}`);
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
    this.noteSynthesis(voiceRef, referenceText);
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
        timeout: this.config.audio_cpp?.request_timeout_ms || 600000
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
        const timeoutSec = Math.round((this.config.audio_cpp?.request_timeout_ms || 600000) / 1000);
        const lastErrOutput = this.lastLogs.slice(-20).join('\n');
        reject(new Error(`Synthesis request timed out after ${timeoutSec}s.\n--- Captured Engine Logs ---\n${lastErrOutput}`));
      });

      req.write(payload);
      req.end();
    });
  }

  /**
   * Synthesize with incremental delivery.
   *
   * Consumes audio.cpp's OpenAI-style SSE stream and invokes onChunk(pcmBuffer) for
   * each `speech.audio.delta` as it is produced, rather than waiting for the whole
   * utterance. Resolves once the stream completes.
   */
  async synthesizeStream(promptInput, modelIdInput, voiceRef, referenceText, onChunk) {
    this.noteSynthesis(voiceRef, referenceText);
    const resolvedModelId = await this.initialize(modelIdInput, voiceRef, referenceText);
    const resolvedVoiceRef = voiceRef ? this.resolvePath(voiceRef) : null;

    // How much audio the engine decodes before handing a piece back, in codec frames of
    // 40ms each. This no longer splits the text — the whole reply is one generation —
    // so lowering it costs decoder overhead but never prosody.
    const streamFrameInterval = this.config.audio_cpp?.stream_frame_interval || 25;

    const payload = JSON.stringify({
      model: resolvedModelId,
      input: promptInput,
      stream_format: 'sse',
      options: { stream_frame_interval: String(streamFrameInterval) },
      ...(resolvedVoiceRef ? { voice_ref: resolvedVoiceRef, reference_text: referenceText } : {})
    });

    return new Promise((resolve, reject) => {
      const req = http.request(`http://127.0.0.1:${this.config.audio_cpp?.internal_port || 8080}/v1/audio/speech`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: this.config.audio_cpp?.request_timeout_ms || 600000
      }, (res) => {
        if (res.statusCode !== 200) {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => reject(new Error(
            `Streaming synthesis failed with HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString().slice(0, 300)}`
          )));
          return;
        }

        let buffered = '';
        let chunkCount = 0;

        res.on('data', (data) => {
          buffered += data.toString();
          // SSE frames are newline-delimited; keep any partial trailing line.
          const lines = buffered.split('\n');
          buffered = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const body = line.slice(5).trim();
            if (!body || body === '[DONE]') continue;

            let event;
            try {
              event = JSON.parse(body);
            } catch (e) {
              continue;
            }

            if (event.type === 'speech.audio.delta' && event.audio) {
              chunkCount++;
              onChunk(Buffer.from(event.audio, 'base64'), chunkCount);
            }
          }
        });

        res.on('end', () => resolve({ chunkCount }));
        res.on('error', err => reject(new Error(`Streaming synthesis error: ${err.message}`)));
      });

      req.on('error', err => reject(new Error(`Streaming synthesis network error: ${err.message}`)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Streaming synthesis timed out after 300s.'));
      });

      req.write(payload);
      req.end();
    });
  }

  stop() {
    this.stopKeepAlive();
    const child = this.process;
    if (!child) return null;

    // Detach the handlers before killing. A terminating process still flushes
    // buffered stdout and fires 'exit' asynchronously, and those late callbacks
    // would otherwise clear state belonging to the replacement process.
    this.process = null;
    this.isReady = false;
    try {
      if (child.stdout) child.stdout.removeAllListeners('data');
      if (child.stderr) child.stderr.removeAllListeners('data');
      child.removeAllListeners('exit');

      if (process.platform === 'win32') {
        execSync(`taskkill /pid ${child.pid} /T /F`);
      } else {
        child.kill();
      }
    } catch (e) {}

    return child;
  }

  waitForExit(child, timeoutMs = 10000) {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (e) {}
        resolve();
      }, timeoutMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

module.exports = AudioCppEngine;
