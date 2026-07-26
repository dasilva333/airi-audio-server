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
    relPath: "models/OmniVoice-GGUF/omnivoice-q8_0.gguf"
  },
  {
    num: "2",
    id: "fish-audio-tts",
    name: "Fish Audio S2 Pro Q8_0",
    family: "fish_audio",
    vram: "~6.31 GB",
    features: "Dual-AR Fast Streaming Synthesis, Zero-Shot Voice Cloning, 1.25 RTF",
    relPath: "models/Fish-Audio-S2-Pro-GGUF/fish-audio-s2-pro-q8_0.gguf"
  },
  {
    num: "3",
    id: "higgs-audio-tts",
    name: "Higgs Audio v3 TTS Q8_0",
    family: "higgs_audio",
    vram: "~4.80 GB",
    features: "46 Native Paralinguistic Tags (<|emotion:...|>), Zero-Shot Voice Cloning",
    relPath: "models/Higgs-GGUF/higgs-audio-q8_0.gguf"
  },
  {
    num: "4",
    id: "kokoro-tts",
    name: "Kokoro TTS Q8_0",
    family: "kokoro",
    vram: "~0.85 GB",
    features: "Ultra-Lightweight Speech Model",
    relPath: "models/Kokoro-GGUF/kokoro-q8_0.gguf"
  },
  {
    num: "5",
    id: "qwen-audio-tts",
    name: "Qwen3 Audio TTS Q8_0",
    family: "qwen_audio",
    vram: "~3.50 GB",
    features: "Multilingual Voice Synthesis",
    relPath: "models/Qwen-GGUF/qwen-q8_0.gguf"
  }
];

function resolvePath(p) {
  if (!p) return '';
  if (path.isAbsolute(p)) return p;
  return path.resolve(__dirname, p);
}

function runSetup() {
  console.log("=".repeat(60));
  console.log("      AIRI Audio Server - Interactive Model Setup Wizard      ");
  console.log("=".repeat(60));

  let config = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    } catch (e) {}
  }

  let audioCppDir = config.audio_cpp?.working_dir || "../audio.cpp";
  let resolvedServerExe = resolvePath(config.audio_cpp?.server_exe || path.join(audioCppDir, "build/windows-cuda-release/bin/audiocpp_server.exe"));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const checkAndPromptAudioCpp = (callback) => {
    if (!fs.existsSync(resolvedServerExe)) {
      console.log("\n" + "!".repeat(60));
      console.log("⚠️  NOTICE: audio.cpp C++ Engine Binary Not Found!");
      console.log("!".repeat(60));
      console.log(`Could not find 'audiocpp_server.exe' at:\n  ${resolvedServerExe}\n`);
      console.log("If audio.cpp is installed in another directory on your computer,");
      console.log("you can specify the folder path below.\n");

      rl.question("Enter your audio.cpp directory path (or press Enter to keep default): ", (userPath) => {
        const customPath = userPath.trim();
        if (customPath) {
          audioCppDir = customPath;
          const newExePath = path.join(audioCppDir, "build/windows-cuda-release/bin/audiocpp_server.exe");
          if (!config.audio_cpp) config.audio_cpp = {};
          config.audio_cpp.working_dir = audioCppDir;
          config.audio_cpp.server_exe = newExePath;
          config.whisper_cpp = {
            cli_exe: path.join(audioCppDir, "build/windows-cuda-release/bin/whisper_cli.exe"),
            model_path: path.join(audioCppDir, "models/whisper-small.bin")
          };
          resolvedServerExe = resolvePath(newExePath);
        }
        callback();
      });
    } else {
      callback();
    }
  };

  checkAndPromptAudioCpp(() => {
    console.log("\nSelect the primary TTS model to enable for AIRI Audio Server:\n");
    MODEL_CATALOG.forEach(m => {
      const fullPath = path.join(audioCppDir, m.relPath);
      const exists = fs.existsSync(resolvePath(fullPath)) ? "✓ Found" : "✗ Missing";
      console.log(`  [${m.num}] ${m.name} (${exists})`);
      console.log(`      VRAM: ${m.vram} | Features: ${m.features}`);
      console.log(`      Path: ${fullPath}\n`);
    });

    rl.question("Enter your choice (1-5, default is 1): ", (answer) => {
      const choice = answer.trim() || "1";
      const selected = MODEL_CATALOG.find(m => m.num === choice) || MODEL_CATALOG[0];

      console.log(`\nSelected Model: ${selected.name}`);

      const modelFullPath = path.join(audioCppDir, selected.relPath);

      config.installed_models = [selected.id];
      if (!config.models) config.models = {};
      config.models[selected.id] = {
        family: selected.family,
        path: modelFullPath,
        allow_unfiltered_tags: selected.family === 'fish_audio' || selected.family === 'higgs_audio'
      };

      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
      console.log(`\nConfig updated successfully! Registered '${selected.id}' as primary model in config.json.\n`);

      if (!fs.existsSync(resolvePath(resolvedServerExe))) {
        console.log("!".repeat(60));
        console.log("📋 SETUP INSTRUCTION FOR EXTERNAL USERS:");
        console.log("To run airi-audio-server, you need the compiled C++ audio.cpp binary.");
        console.log("1. Clone audio.cpp repo: git clone https://github.com/0xShug0/audio.cpp");
        console.log("2. Build with CMake: cmake -B build/windows-cuda-release -DGGML_CUDA=ON && cmake --build build/windows-cuda-release --config Release");
        console.log("3. Or update 'audio_cpp.server_exe' in config.json to point to your existing build.");
        console.log("!".repeat(60) + "\n");
      }

      console.log("Starting AIRI Audio Server...");
      rl.close();

      // Start server
      try {
        execSync('npm start', { stdio: 'inherit', cwd: __dirname });
      } catch (e) {}
    });
  });
}

runSetup();
