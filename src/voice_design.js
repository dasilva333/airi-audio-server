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

class VoiceDesignerEngine {
  constructor(config, voiceManager = null) {
    this.config = config;
    this.voiceManager = voiceManager;
  }

  resolveModelPath() {
    const candidatePaths = [
      resolvePath('models/MOSS-VoiceGenerator-GGUF'),
      resolvePath('../audio.cpp/models/MOSS-VoiceGenerator-GGUF'),
      resolvePath('models/moss-voicegen'),
      resolvePath('../audio.cpp/models/moss-voicegen')
    ];

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  isAvailable() {
    const modelDir = this.resolveModelPath();
    if (!modelDir) return false;
    const ggufFile = path.join(modelDir, 'moss_voicegen_bf16_codec_f16_decode.gguf');
    return fs.existsSync(ggufFile) || fs.readdirSync(modelDir).some(f => f.endsWith('.gguf') || f.endsWith('.safetensors'));
  }

  async generateVoice(options = {}) {
    const {
      instruct = 'A warm, engaging voice with clear articulation and balanced tone.',
      text = 'Hello, this is a test of my newly designed synthetic voice.',
      language = 'English',
      save_as_voice = null,
      seed = null,
      audio_temperature = 1.5,
      audio_top_p = 0.6,
      audio_top_k = 50,
      audio_repetition_penalty = 1.1
    } = options;

    const backendInfo = requireBackend(this.config);
    const cliExe = resolveEngineBinary('audiocpp_cli', this.config.audio_cpp?.cli_exe, backendInfo.backend, this.config);
    if (!cliExe || !fs.existsSync(cliExe)) {
      throw new Error(`audiocpp_cli executable not found at: ${cliExe}`);
    }

    const modelDir = this.resolveModelPath();
    if (!modelDir || !fs.existsSync(modelDir)) {
      throw new Error('MOSS-VoiceGenerator model weights not found. Run npm run add-voicegen to install.');
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airi-voice-design-'));
    const outputWav = path.join(tempDir, `voice_design_${Date.now()}.wav`);

    const cliArgs = [
      '--family', 'moss_voicegen',
      '--task', 'vdes',
      '--model', modelDir,
      '--backend', backendInfo.backend,
      '--device', String(backendInfo.device),
      '--instruct', instruct,
      '--text', text,
      '--language', language,
      '--request-option', `audio_temperature=${audio_temperature}`,
      '--request-option', `audio_top_p=${audio_top_p}`,
      '--request-option', `audio_top_k=${audio_top_k}`,
      '--request-option', `audio_repetition_penalty=${audio_repetition_penalty}`,
      '--out', outputWav
    ];

    if (seed !== null && seed !== undefined) {
      cliArgs.push('--seed', seed.toString());
    }

    const binDir = path.dirname(cliExe);
    const runtimePaths = getBackendRuntimePaths(this.config, backendInfo.backend);
    const envPath = [binDir, ...runtimePaths, process.env.PATH].filter(Boolean).join(path.delimiter);

    const tStart = Date.now();
    console.log(`[VoiceDesign Engine] Synthesizing voice persona (backend=${backendInfo.backend}): "${instruct.substring(0, 60)}..."`);

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
        if (str.includes('RTF') || str.includes('step') || str.includes('frame')) {
          console.log(`[VoiceDesign Engine] ${str.trim()}`);
        }
      });

      proc.stderr.on('data', d => {
        stderr += d.toString();
      });

      proc.on('close', async (code) => {
        const latencyMs = Date.now() - tStart;
        if (code === 0 && fs.existsSync(outputWav) && fs.statSync(outputWav).size > 44) {
          const wavBuffer = fs.readFileSync(outputWav);

          let savedVoice = null;
          if (save_as_voice && this.voiceManager) {
            try {
              const cleanVoiceId = save_as_voice.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
              console.log(`[VoiceDesign Engine] Ingesting generated persona into voices/ catalog as '${cleanVoiceId}'...`);
              savedVoice = await this.voiceManager.ingestVoiceAudio(outputWav, cleanVoiceId, text);
            } catch (err) {
              console.warn(`[VoiceDesign Engine Warning] Failed to auto-ingest into voices catalog: ${err.message}`);
            }
          }

          try {
            fs.rmSync(tempDir, { recursive: true, force: true });
          } catch (e) {}

          resolve({
            audio_buffer: wavBuffer,
            latency_ms: latencyMs,
            sample_rate: 24000,
            instruct,
            text,
            language,
            saved_voice: savedVoice
          });
        } else {
          try {
            fs.rmSync(tempDir, { recursive: true, force: true });
          } catch (e) {}
          const errorMsg = stderr || stdout || `Process exited with code ${code}`;
          reject(new Error(`Voice design failed with exit code ${code}.\nLogs:\n${errorMsg}`));
        }
      });

      proc.on('error', (err) => {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (e) {}
        reject(new Error(`Failed to execute audiocpp_cli for voice design: ${err.message}`));
      });
    });
  }
}

module.exports = VoiceDesignerEngine;
