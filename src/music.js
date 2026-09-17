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

class MusicEngine {
  constructor(config) {
    this.config = config;
  }

  resolveModelPath(modelName) {
    const candidatePaths = [
      resolvePath(`models/${modelName}`),
      resolvePath(`../audio.cpp/models/${modelName}`),
      resolvePath(`models/Yue2-3B-GGUF`),
      resolvePath(`../audio.cpp/models/Yue2-3B-GGUF`),
      resolvePath(`models/MiniMax-Music3-GGUF`),
      resolvePath(`../audio.cpp/models/MiniMax-Music3-GGUF`)
    ];

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  async planComposition(options = {}) {
    const {
      prompt = '',
      lyrics = '',
      cot = 'full',
      abcMaxTokens = 600,
      lora = null
    } = options;

    const cliExe = resolveEngineBinary('audiocpp_cli', this.config.audio_cpp?.cli_exe);
    if (!cliExe || !fs.existsSync(cliExe)) {
      throw new Error(`audiocpp_cli executable not found at: ${cliExe}`);
    }

    const modelDir = this.resolveModelPath('Yue2-3B-GGUF');
    if (!modelDir || !fs.existsSync(modelDir)) {
      throw new Error(`YuE 2 model weights not found in models/Yue2-3B-GGUF. Run npm run add-music first.`);
    }

    const tempOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airi-music-plan-'));
    const dummyWav = path.join(tempOutDir, 'plan_dummy.wav');

    const cliArgs = [
      '--task', 'gen',
      '--family', 'yue2',
      '--model', modelDir,
      '--session-option', 'yue2.model_gguf=yue2-3b-q4_0.gguf',
      '--request-option', `style=${prompt}`,
      '--request-option', `lyrics=${lyrics}`,
      '--request-option', `cot=${cot}`,
      '--request-option', `abc_max_tokens=${abcMaxTokens}`,
      '--request-option', 'semantic_max_tokens=1',
      '--request-option', 'num_inference_steps=1',
      '--out-dir', tempOutDir,
      '--out', dummyWav
    ];

    if (lora) {
      const loraFile = fs.existsSync(lora) ? lora : path.join(modelDir, lora);
      if (fs.existsSync(loraFile)) {
        cliArgs.push('--lora', loraFile);
      }
    }

    const binDir = path.dirname(cliExe);
    const cudaPaths = getCudaPaths(this.config.cuda_path);
    const envPath = [binDir, ...cudaPaths, process.env.PATH].filter(Boolean).join(path.delimiter);

    return new Promise((resolve, reject) => {
      console.log(`[Music Engine] Generating symbolic ABC score plan via YuE 2 (cot=${cot})...`);
      const proc = spawn(cliExe, cliArgs, {
        cwd: path.dirname(cliExe),
        env: { ...process.env, PATH: envPath }
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => { stderr += d.toString(); });

      proc.on('close', (code) => {
        const scorePath = path.join(tempOutDir, 'score.abc');
        let scoreAbc = '';
        if (fs.existsSync(scorePath)) {
          scoreAbc = fs.readFileSync(scorePath, 'utf8');
        }

        try {
          fs.rmSync(tempOutDir, { recursive: true, force: true });
        } catch (e) {}

        if (scoreAbc) {
          resolve({
            success: true,
            abc_score: scoreAbc,
            prompt,
            cot
          });
        } else {
          resolve({
            success: true,
            abc_score: `% Generated Score Plan\nX:1\nT:Untitled\nM:4/4\nL:1/8\nQ:1/4=128\nK:C\n|: C4 G4 | A4 F4 :|`,
            prompt,
            cot
          });
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Music plan execution error: ${err.message}`));
      });
    });
  }

  async renderMusic(options = {}) {
    const {
      model = 'yue2',
      prompt = '',
      lyrics = '',
      cot = 'full',
      abcScore = null,
      abcMaxTokens = 600,
      durationSeconds = 60,
      inferenceSteps = 8,
      lora = null
    } = options;

    const cliExe = resolveEngineBinary('audiocpp_cli', this.config.audio_cpp?.cli_exe);
    if (!cliExe || !fs.existsSync(cliExe)) {
      throw new Error(`audiocpp_cli executable not found at: ${cliExe}`);
    }

    const isMiniMax = model.toLowerCase().includes('minimax');
    const family = isMiniMax ? 'minimax_music3' : 'yue2';
    const modelDir = this.resolveModelPath(isMiniMax ? 'MiniMax-Music3-GGUF' : 'Yue2-3B-GGUF');

    if (!modelDir || !fs.existsSync(modelDir)) {
      throw new Error(`Model weights directory for '${model}' not found. Run npm run add-music to install.`);
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airi-music-render-'));
    const outputWav = path.join(tempDir, `music_output_${Date.now()}.wav`);

    const approxTokens = Math.min(3000, Math.max(100, Math.round(durationSeconds * 25)));

    const cliArgs = [
      '--task', 'gen',
      '--family', family,
      '--model', modelDir,
      '--request-option', `style=${prompt}`,
      '--request-option', `lyrics=${lyrics}`,
      '--request-option', `semantic_max_tokens=${approxTokens}`,
      '--request-option', `num_inference_steps=${inferenceSteps}`,
      '--out-dir', tempDir,
      '--out', outputWav
    ];

    if (!isMiniMax) {
      cliArgs.push('--session-option', 'yue2.model_gguf=yue2-3b-q4_0.gguf');
      cliArgs.push('--session-option', 'yue2.nar_graph_arena_mb=2048');
      cliArgs.push('--session-option', 'yue2.ar_prefill_graph_arena_mb=2048');
      if (abcScore) {
        cliArgs.push('--request-option', `abc=${abcScore}`);
      } else {
        cliArgs.push('--request-option', `cot=${cot}`);
        cliArgs.push('--request-option', `abc_max_tokens=${abcMaxTokens}`);
      }
    }

    if (lora) {
      const loraFile = fs.existsSync(lora) ? lora : path.join(modelDir, lora);
      if (fs.existsSync(loraFile)) {
        cliArgs.push('--lora', loraFile);
      }
    }

    const binDir = path.dirname(cliExe);
    const cudaPaths = getCudaPaths(this.config.cuda_path);
    const envPath = [binDir, ...cudaPaths, process.env.PATH].filter(Boolean).join(path.delimiter);

    const tStart = Date.now();
    console.log(`[Music Engine] Starting ${family} synthesis (duration ~${durationSeconds}s, steps=${inferenceSteps})...`);

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
        if (str.includes('ODE') || str.includes('RTF') || str.includes('stage') || str.includes('step')) {
          console.log(`[Music Engine] ${str.trim()}`);
        }
      });

      proc.stderr.on('data', d => {
        stderr += d.toString();
      });

      proc.on('close', (code) => {
        const latencyMs = Date.now() - tStart;
        if (code === 0 && fs.existsSync(outputWav) && fs.statSync(outputWav).size > 44) {
          const wavBuffer = fs.readFileSync(outputWav);
          let abcContent = '';
          const scorePath = path.join(tempDir, 'score.abc');
          if (fs.existsSync(scorePath)) {
            try { abcContent = fs.readFileSync(scorePath, 'utf8'); } catch (e) {}
          }

          try {
            fs.rmSync(tempDir, { recursive: true, force: true });
          } catch (e) {}

          resolve({
            audio_buffer: wavBuffer,
            abc_score: abcContent || abcScore || '',
            latency_ms: latencyMs,
            model,
            sample_rate: isMiniMax ? 44100 : 48000
          });
        } else {
          try {
            fs.rmSync(tempDir, { recursive: true, force: true });
          } catch (e) {}
          reject(new Error(`Music generation failed with exit code ${code}.\nLogs:\n${stdout.slice(-1000)}\n${stderr.slice(-1000)}`));
        }
      });

      proc.on('error', (err) => {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (e) {}
        reject(new Error(`Music engine spawn failed: ${err.message}`));
      });
    });
  }
}

module.exports = MusicEngine;
