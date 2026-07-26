const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

function resolvePath(relativePath) {
  if (!relativePath) return '';
  if (path.isAbsolute(relativePath)) return relativePath;
  return path.resolve(__dirname, '..', relativePath);
}

function getSttCliExePath(whisperConfig) {
  const primary = resolvePath(whisperConfig?.cli_exe);
  if (primary && fs.existsSync(primary)) {
    return primary;
  }
  const bundledCli = path.join(__dirname, '..', 'bin', 'windows-cuda', 'audiocpp_cli.exe');
  if (fs.existsSync(bundledCli)) {
    return bundledCli;
  }
  const bundledWhisper = path.join(__dirname, '..', 'bin', 'windows-cuda', 'whisper_cli.exe');
  if (fs.existsSync(bundledWhisper)) {
    return bundledWhisper;
  }
  return primary;
}

function runWhisperStt(audioPath, whisperConfig) {
  return new Promise((resolve, reject) => {
    const resolvedCli = getSttCliExePath(whisperConfig);
    const resolvedModel = resolvePath(whisperConfig?.model_path);
    const resolvedAudio = resolvePath(audioPath);

    if (!fs.existsSync(resolvedCli)) {
      console.warn(`[Whisper.cpp GPU Warning] CLI executable not found at ${resolvedCli}. Defaulting to fallback transcript.`);
      return resolve("Speaker reference sample.");
    }

    const binDir = path.dirname(resolvedCli);
    const cudaPath = process.env.CUDA_PATH 
      ? path.join(process.env.CUDA_PATH, 'bin')
      : "C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v13.1\\bin\\x64";

    const env = {
      ...process.env,
      PATH: `${binDir};${cudaPath};${process.env.PATH}`
    };

    console.log(`[Whisper.cpp GPU] Transcribing ${path.basename(resolvedAudio)} with ${path.basename(resolvedCli)}...`);
    const args = [
      '-m', resolvedModel,
      '-f', resolvedAudio,
      '-nt',
      '--language', 'en'
    ];

    const proc = spawn(resolvedCli, args, { env });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());

    proc.on('close', (code) => {
      if (code === 0) {
        const cleanText = stdout
          .split('\n')
          .map(line => line.replace(/\[\d\d:\d\d:\d\d\.\d\d\d --> \d\d:\d\d:\d\d\.\d\d\d\]/g, '').trim())
          .filter(line => line.length > 0)
          .join(' ')
          .trim();

        console.log(`[Whisper.cpp GPU] Transcript: "${cleanText}"`);
        resolve(cleanText || "Speaker reference sample.");
      } else {
        console.error(`[Whisper.cpp GPU Error] Process exited with code ${code}: ${stderr}`);
        resolve("Speaker reference sample.");
      }
    });

    proc.on('error', (err) => {
      console.error(`[Whisper.cpp GPU Error] ${err.message}`);
      resolve("Speaker reference sample.");
    });
  });
}

module.exports = { runWhisperStt };
