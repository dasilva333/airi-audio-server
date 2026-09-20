const fs = require('fs');
const path = require('path');
const https = require('https');

function resolvePath(p) {
  if (!p) return '';
  if (path.isAbsolute(p)) return p;
  return path.resolve(__dirname, p);
}

function downloadFile(url, targetPath) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    console.log(`\nStarting download from Hugging Face / Model Hub:`);
    console.log(`URL   : ${url}`);
    console.log(`Target: ${targetPath}\n`);

    const request = (currentUrl) => {
      https.get(currentUrl, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          return request(response.headers.location);
        }

        if (response.statusCode !== 200) {
          return reject(new Error(`Download failed. HTTP Status: ${response.statusCode}`));
        }

        const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
        let downloadedBytes = 0;
        let lastReport = 0;

        const fileStream = fs.createWriteStream(targetPath);
        response.pipe(fileStream);

        response.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          const now = Date.now();
          if (now - lastReport > 800 || downloadedBytes === totalBytes) {
            lastReport = now;
            if (totalBytes > 0) {
              const pct = ((downloadedBytes / totalBytes) * 100).toFixed(1);
              const mb = (downloadedBytes / (1024 * 1024)).toFixed(1);
              const totalMb = (totalBytes / (1024 * 1024)).toFixed(1);
              process.stdout.write(`\rDownloading: [${mb} MB / ${totalMb} MB] (${pct}%)`);
            } else {
              const mb = (downloadedBytes / (1024 * 1024)).toFixed(1);
              process.stdout.write(`\rDownloading: ${mb} MB`);
            }
          }
        });

        fileStream.on('finish', () => {
          fileStream.close();
          console.log(`\n✓ Download complete: ${path.basename(targetPath)}`);
          resolve();
        });

        fileStream.on('error', (err) => {
          fs.unlink(targetPath, () => {});
          reject(err);
        });
      }).on('error', (err) => {
        fs.unlink(targetPath, () => {});
        reject(err);
      });
    };

    request(url);
  });
}

async function main() {
  console.log("=".repeat(65));
  console.log(" AIRI Audio Server - Stable Audio 3 Small SFX Model Installer  ");
  console.log("=".repeat(65));
  console.log("\nStable Audio 3 Small SFX generates ultra-fast high-fidelity sound");
  console.log("effects, foley, and ambient textures using rectified flow diffusion (8 steps).");
  console.log("VRAM footprint: ~1.5 GB. Ideal for realtime UI/ambient SFX.\n");
  console.log("Model: stable-audio-3-small-sfx-q8_0.gguf (~1.2 GB)");
  console.log("Repo : audio-cpp/audio.cpp-gguf\n");

  const url = "https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/main/Stable-Audio-3-Small-SFX-GGUF/stable-audio-3-small-sfx-q8_0.gguf";
  const targetPath = resolvePath("models/Stable-Audio-3-Small-SFX-GGUF/stable-audio-3-small-sfx-q8_0.gguf");

  if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 1000000) {
    console.log(`✓ Stable Audio 3 Small SFX is already installed at: ${targetPath}`);
    return;
  }

  try {
    await downloadFile(url, targetPath);
    console.log("\n" + "=".repeat(65));
    console.log("✓ Stable Audio 3 Small SFX Setup Complete!");
    console.log("You can now call POST /v1/audio/sfx");
    console.log("=".repeat(65) + "\n");
  } catch (err) {
    console.error(`\n[Download Error] ${err.message}`);
    process.exit(1);
  }
}

main();
