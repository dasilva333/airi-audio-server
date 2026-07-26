const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function convertWavToOgg(wavBuffer) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-c:a', 'libopus',
      '-b:a', '48k',
      '-ar', '48000',
      '-ac', '1',
      '-f', 'ogg',
      'pipe:1'
    ]);

    const chunks = [];
    ffmpeg.stdout.on('data', chunk => chunks.push(chunk));
    ffmpeg.stderr.on('data', () => {});

    ffmpeg.on('close', code => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        // Fallback to raw WAV if ffmpeg opus fails
        resolve(wavBuffer);
      }
    });

    ffmpeg.on('error', () => resolve(wavBuffer));

    ffmpeg.stdin.write(wavBuffer);
    ffmpeg.stdin.end();
  });
}

function normalizeAudioToWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(inputPath)) {
      return reject(new Error(`Audio reference file not found: ${inputPath}`));
    }

    let stderr = '';
    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-i', inputPath,
      '-ar', '24000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      outputPath
    ]);

    ffmpeg.stderr.on('data', d => stderr += d.toString());

    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`FFmpeg conversion failed for '${path.basename(inputPath)}'.\nFFmpeg Log: ${stderr.trim() || 'Exit code ' + code}`));
      }
      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
        return reject(new Error(`FFmpeg output file '${outputPath}' is missing or empty.`));
      }
      resolve(outputPath);
    });

    ffmpeg.on('error', (err) => {
      reject(new Error(`Failed to execute FFmpeg binary: ${err.message}`));
    });
  });
}

function ensureOptimalAudioLength(wavPath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(wavPath)) {
      return resolve(wavPath);
    }

    // Inspect duration using ffprobe
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      wavPath
    ]);

    let outStr = '';
    ffprobe.stdout.on('data', d => outStr += d.toString());
    ffprobe.on('close', (code) => {
      const duration = parseFloat(outStr.trim()) || 0;
      if (duration > 0 && duration < 1.5) {
        console.log(`[FFmpeg] Reference clip ${path.basename(wavPath)} is too short (${duration}s). Self-concatenating...`);
        // Duplicate clip twice onto itself to reach ~3-4.5 seconds
        const tmpOutput = `${wavPath}.looped.wav`;
        const concatProc = spawn('ffmpeg', [
          '-y',
          '-stream_loop', '2',
          '-i', wavPath,
          '-c', 'copy',
          tmpOutput
        ]);
        concatProc.on('close', (cCode) => {
          if (cCode === 0 && fs.existsSync(tmpOutput)) {
            fs.renameSync(tmpOutput, wavPath);
          }
          resolve(wavPath);
        });
        concatProc.on('error', () => resolve(wavPath));
      } else {
        resolve(wavPath);
      }
    });

    ffprobe.on('error', () => resolve(wavPath));
  });
}

module.exports = {
  convertWavToOgg,
  normalizeAudioToWav,
  ensureOptimalAudioLength
};
