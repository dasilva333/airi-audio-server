const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

const CONFIG_PATH = path.join(__dirname, 'config.json');

const MODEL_CATALOG = [
  {
    num: "1",
    id: "omnivoice-tts",
    name: "OmniVoice Q8_0 (Recommended)",
    family: "omnivoice",
    vram: "~1.12 GB",
    features: "Zero-Shot Voice Cloning, Paralinguistic Expression Tags, 0.28 RTF",
    path: "C:/Users/h4rdc/Documents/Github/coding-agent/audio.cpp/models/OmniVoice-GGUF/omnivoice-q8_0.gguf"
  },
  {
    num: "2",
    id: "fish-audio-tts",
    name: "Fish Audio S2 Pro Q8_0",
    family: "fish_audio",
    vram: "~6.31 GB",
    features: "Dual-AR Fast Streaming Synthesis, Zero-Shot Voice Cloning, 1.25 RTF",
    path: "C:/Users/h4rdc/Documents/Github/coding-agent/audio.cpp/models/Fish-Audio-S2-Pro-GGUF/fish-audio-s2-pro-q8_0.gguf"
  },
  {
    num: "3",
    id: "kokoro-tts",
    name: "Kokoro TTS Q8_0",
    family: "kokoro",
    vram: "~0.85 GB",
    features: "Ultra-Lightweight Speech Model",
    path: "C:/Users/h4rdc/Documents/Github/coding-agent/audio.cpp/models/Kokoro-GGUF/kokoro-q8_0.gguf"
  },
  {
    num: "4",
    id: "qwen-audio-tts",
    name: "Qwen3 Audio TTS Q8_0",
    family: "qwen_audio",
    vram: "~3.50 GB",
    features: "Multilingual Voice Synthesis",
    path: "C:/Users/h4rdc/Documents/Github/coding-agent/audio.cpp/models/Qwen-GGUF/qwen-q8_0.gguf"
  }
];

function runSetup() {
  console.log("=".repeat(60));
  console.log("      AIRI Audio Server - Interactive Model Setup Wizard      ");
  console.log("=".repeat(60));
  console.log("Installing Node.js dependencies...");
  try {
    execSync('npm install', { stdio: 'inherit', cwd: __dirname });
  } catch (e) {
    console.error(`Dependency install warning: ${e.message}`);
  }

  console.log("\nSelect the primary TTS model to enable for AIRI Audio Server:\n");
  MODEL_CATALOG.forEach(m => {
    console.log(`  [${m.num}] ${m.name}`);
    console.log(`      VRAM: ${m.vram} | Features: ${m.features}`);
    console.log(`      Path: ${m.path}\n`);
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.question("Enter your choice (1-4, default is 1): ", (answer) => {
    const choice = answer.trim() || "1";
    const selected = MODEL_CATALOG.find(m => m.num === choice) || MODEL_CATALOG[0];

    console.log(`\nSelected Model: ${selected.name}`);

    // Update config.json
    let config = {};
    if (fs.existsSync(CONFIG_PATH)) {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }

    config.installed_models = [selected.id];
    if (!config.models) config.models = {};
    config.models[selected.id] = {
      family: selected.family,
      path: selected.path,
      allow_unfiltered_tags: selected.family === 'fish_audio'
    };

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    console.log(`\nConfig updated successfully! Registered '${selected.id}' as primary model in config.json.\n`);
    console.log("Starting AIRI Audio Server...");
    rl.close();

    // Start server
    try {
      execSync('npm start', { stdio: 'inherit', cwd: __dirname });
    } catch (e) {}
  });
}

runSetup();
