const fs = require('fs');
const path = require('path');
const https = require('https');
const readline = require('readline');

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

const MUSIC_PACKAGES = [
  {
    num: "1",
    id: "yue2-3b",
    name: "YuE 2 3B Q4_0 (Recommended for 8GB GPUs / RTX 4070)",
    vram: "~2.8 GB - 3.3 GB VRAM",
    features: "Dual-tier: ABC symbolic score planning (3-20s) + 48kHz stereo ODE acoustic flow matching. AR LoRA support.",
    files: [
      {
        url: "https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/main/Yue2-3B-GGUF/yue2-3b-q4_0.gguf",
        relPath: "models/Yue2-3B-GGUF/yue2-3b-q4_0.gguf"
      },
      {
        url: "https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/main/Yue2-3B-GGUF/yue2-vae-f16.gguf",
        relPath: "models/Yue2-3B-GGUF/yue2-vae-f16.gguf"
      },
      {
        url: "https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/main/Yue2-3B-GGUF/ar_lora_inst_v3abc.safetensors",
        relPath: "models/Yue2-3B-GGUF/ar_lora_inst_v3abc.safetensors"
      }
    ]
  },
  {
    num: "2",
    id: "minimax-music3",
    name: "MiniMax Music 3.0 GGUF (Requires >=12GB GPU / High VRAM)",
    vram: "~7.2 GB - 8.0 GB VRAM",
    features: "Direct acoustic flow diffusion, 44.1kHz stereo audio.",
    files: [
      {
        url: "https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/main/MiniMax-Music3-GGUF/minimax-music3-q4_0.gguf",
        relPath: "models/MiniMax-Music3-GGUF/minimax-music3-q4_0.gguf"
      }
    ]
  }
];

async function main() {
  console.log("=".repeat(65));
  console.log("      AIRI Audio Server - Generative Music Model Installer        ");
  console.log("=".repeat(65));
  console.log("\nChoose a generative music model suite to install:\n");

  MUSIC_PACKAGES.forEach(pkg => {
    console.log(`  [${pkg.num}] ${pkg.name}`);
    console.log(`      Footprint: ${pkg.vram}`);
    console.log(`      Features : ${pkg.features}\n`);
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.question("Select package to download (1-2, default is 1): ", async (ans) => {
    const choice = ans.trim() || "1";
    const selected = MUSIC_PACKAGES.find(p => p.num === choice) || MUSIC_PACKAGES[0];

    console.log(`\nSelected: ${selected.name}`);
    console.log(`Downloading ${selected.files.length} model component(s)...`);

    for (const file of selected.files) {
      const targetPath = resolvePath(file.relPath);
      if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 1000000) {
        console.log(`✓ Already installed: ${path.basename(targetPath)}`);
        continue;
      }
      try {
        await downloadFile(file.url, targetPath);
      } catch (err) {
        console.warn(`[Download Warning] ${file.url}: ${err.message}`);
      }
    }

    console.log("\n" + "=".repeat(65));
    console.log("✓ Generative Music Model Setup Complete!");
    console.log("You can now call POST /v1/audio/music and POST /v1/audio/music/plan");
    console.log("=".repeat(65) + "\n");
    rl.close();
  });
}

main();
