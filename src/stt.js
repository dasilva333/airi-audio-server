const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

function runWhisperStt(audioPath, whisperConfig) {
  return new Promise((resolve, reject) => {
    const cudaPath = "C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v13.1\\bin\\x64";
    const env = {
      ...process.env,
      PATH: `${cudaPath};${process.env.PATH}`
    };

    console.log(`[Whisper.cpp GPU] Transcribing: ${path.basename(audioPath)}...`);
    const args = [
      '-m', whisperConfig.model_path,
      '-f', audioPath,
      '-nt', // No timestamps
      '--language', 'en'
    ];

    const proc = spawn(whisperConfig.cli_exe, args, { env });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());

    proc.on('close', (code) => {
      if (code === 0) {
        // Clean transcript text
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
