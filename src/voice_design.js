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

    const cliExe = resolveEngineBinary('audiocpp_cli', this.config.audio_cpp?.cli_exe);
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
    const cudaPaths = getCudaPaths(this.config.cuda_path);
    const envPath = [binDir, ...cudaPaths, process.env.PATH].filter(Boolean).join(path.delimiter);

    const tStart = Date.now();
    console.log(`[VoiceDesign Engine] Synthesizing voice persona: "${instruct.substring(0, 60)}..."`);

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
