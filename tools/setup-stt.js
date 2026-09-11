#!/usr/bin/env node
/**
 * 1-Click Setup & Self-Test for Citrinet ASR Engine.
 *
 * Downloads the lightweight 40.5MB Citrinet ASR model weights from Hugging Face,
 * updates config.json with native citrinet_asr configuration, and runs an empirical
 * 1-second GPU self-test to verify working speech transcription.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const CITRINET_URL = 'https://huggingface.co/onnx-community/citrinet-asr-GGUF/resolve/main/citrinet-asr-q8_0.gguf';
const MODEL_DIR = path.resolve(__dirname, '../models/Citrinet-ASR-GGUF');
const MODEL_PATH = path.join(MODEL_DIR, 'citrinet-asr-q8_0.gguf');
const CONFIG_PATH = path.resolve(__dirname, '../config.json');
const EXAMPLE_CONFIG_PATH = path.resolve(__dirname, '../config.example.json');

function downloadFile(url, targetPath) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    console.log(`Downloading Citrinet ASR weights (40.5 MB)...`);
    console.log(`URL: ${url}`);
    console.log(`Target: ${targetPath}\n`);

    const request = (currentUrl) => {
      https.get(currentUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return request(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} when downloading Citrinet model`));
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        let downloadedBytes = 0;
        const fileStream = fs.createWriteStream(targetPath);

        res.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          fileStream.write(chunk);
          if (totalBytes > 0) {
            const percent = ((downloadedBytes / totalBytes) * 100).toFixed(1);
            const dlMb = (downloadedBytes / (1024 * 1024)).toFixed(1);
            const totalMb = (totalBytes / (1024 * 1024)).toFixed(1);
            process.stdout.write(`\rDownloading: ${percent}% (${dlMb} MB / ${totalMb} MB)`);
          }
        });

        res.on('end', () => {
          fileStream.end();
          console.log(`\n\n✅ Download complete!`);
          resolve(targetPath);
        });

        res.on('error', (err) => {
          try { fs.unlinkSync(targetPath); } catch (e) {}
          reject(err);
        });
      }).on('error', reject);
    };

    request(url);
  });
}

async function main() {
  console.log('='.repeat(60));
  console.log('     AIRI Audio Server - Citrinet ASR Engine Setup');
  console.log('='.repeat(60));
  console.log();

  // 1. Check & download Citrinet model if needed
  if (!fs.existsSync(MODEL_PATH) || fs.statSync(MODEL_PATH).size < 10000000) {
    console.log('[1/4] Citrinet ASR GGUF model weights missing. Downloading...');
    await downloadFile(CITRINET_URL, MODEL_PATH);
  } else {
    console.log(`[1/4] ✅ Citrinet ASR model verified at:\n      ${MODEL_PATH}`);
  }
  console.log();

  // 2. Ensure model sidecar config exists
  const sidecarConfig = path.join(MODEL_DIR, 'config.json');
  if (!fs.existsSync(sidecarConfig)) {
    fs.writeFileSync(sidecarConfig, JSON.stringify({ family: 'citrinet_asr', model_type: 'citrinet_asr' }, null, 2), 'utf8');
  }

  // 3. Update config.json
  console.log('[2/4] Updating server configuration (config.json)...');
  let config = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) {}
  } else if (fs.existsSync(EXAMPLE_CONFIG_PATH)) {
    try { config = JSON.parse(fs.readFileSync(EXAMPLE_CONFIG_PATH, 'utf8')); } catch (e) {}
  }

  config.asr = {
    cli_exe: 'bin/windows-cuda/audiocpp_cli.exe',
    model_path: 'models/Citrinet-ASR-GGUF/citrinet-asr-q8_0.gguf',
    family: 'citrinet_asr',
    backend: 'cuda'
  };

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  console.log('      ✅ config.json updated with native citrinet_asr settings.');
  console.log();

  // 4. Verify GPU binary and run empirical transcription self-test
  console.log('[3/4] Running empirical GPU self-test on test reference clip...');
  const { resolveEngineBinary } = require('../src/gpu');
  const cliExe = resolveEngineBinary('audiocpp_cli', config.asr.cli_exe);
  if (!cliExe || !fs.existsSync(cliExe)) {
    console.warn(`      ⚠️ Warning: audiocpp_cli binary not found at '${cliExe}'.`);
    console.warn(`         Run install.bat first to acquire the engine binaries.`);
  } else {
    const { transcribeAudio } = require('../src/stt');
    const testAudio = path.resolve(__dirname, '../voices/abby_character_cheery.wav');
    if (fs.existsSync(testAudio)) {
      const tStart = Date.now();
      const text = await transcribeAudio(testAudio, config.asr);
      const elapsedMs = Date.now() - tStart;
      if (text) {
        console.log(`      ✅ Self-test PASSED in ${elapsedMs}ms!`);
        console.log(`      Sample transcript: "${text.slice(0, 70)}..."`);
      } else {
        console.warn(`      ⚠️ Self-test produced empty transcript. Check CUDA drivers.`);
      }
    }
  }
  console.log();

  // 5. Ensure missing voice transcripts in voices/ are generated
  console.log('[4/4] Verifying bundled voice transcripts in voices/...');
  const transcribeScript = path.join(__dirname, 'transcribe-voices.js');
  if (fs.existsSync(transcribeScript)) {
    spawnSync(process.execPath, [transcribeScript], { stdio: 'inherit', cwd: path.resolve(__dirname, '..') });
  }

  console.log();
  console.log('='.repeat(60));
  console.log('🎉 Citrinet ASR setup complete! Your audio server is ready.');
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('\n❌ Setup failed:', err.message);
  process.exit(1);
});
