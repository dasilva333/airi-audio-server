const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');
const cors = require('cors');

const configPath = process.env.AIRI_CONFIG ? path.resolve(process.env.AIRI_CONFIG) : path.join(__dirname, '../config.json');
const exampleConfigPath = path.join(__dirname, '../config.example.json');

function loadOrCreateConfig() {
  if (fs.existsSync(configPath)) {
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (e) {
      console.error(`[AIRI Audio Server] Error parsing config.json: ${e.message}`);
      process.exit(1);
    }
  }

  // config.json does not exist. Check if we can run interactive setup wizard
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (isInteractive) {
    console.log('[AIRI Audio Server] config.json not found. Launching setup wizard...\n');
    const setupScript = path.join(__dirname, '../setup.js');
    spawnSync(process.execPath, [setupScript], {
      stdio: 'inherit',
      env: { ...process.env, AIRI_CALLED_FROM_SERVER: '1' }
    });
    if (fs.existsSync(configPath)) {
      try {
        return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      } catch (e) {}
    }
  }

  // If non-interactive or setup didn't finish, auto-create from config.example.json
  if (fs.existsSync(exampleConfigPath)) {
    console.log('[AIRI Audio Server] Initializing config.json from config.example.json template...');
    fs.copyFileSync(exampleConfigPath, configPath);
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }

  throw new Error('Neither config.json nor config.example.json could be found.');
}

const config = loadOrCreateConfig();
const UnifiedGpuQueue = require('./queue');
const TextProcessor = require('./text');
const AudioCppEngine = require('./engine');
const VoiceManager = require('./voices');
const MusicEngine = require('./music');
const VoiceDesignerEngine = require('./voice_design');
const SfxEngine = require('./sfx');
const createRouter = require('./routes');

const app = express();
app.use(cors());
app.use(express.json());

const voicesDir = path.join(__dirname, '../voices');
const vocabularyPath = path.join(voicesDir, 'voice_vocabulary.json');
const tagsCsvPath = path.join(__dirname, '../supported_tags.csv');

const gpuQueue = new UnifiedGpuQueue();
const textProcessor = new TextProcessor(tagsCsvPath);
const voiceManager = new VoiceManager(voicesDir, vocabularyPath, config.asr);
const engine = new AudioCppEngine(config);
const musicEngine = new MusicEngine(config);
const voiceDesigner = new VoiceDesignerEngine(config, voiceManager);
const sfxEngine = new SfxEngine(config);

const router = createRouter(engine, voiceManager, textProcessor, gpuQueue, config, musicEngine, voiceDesigner, sfxEngine);
app.use(router);

// Global health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    engine_ready: engine.isReady,
    active_model: engine.activeModel || engine.getDefaultModelId(),
    voice_designer_ready: voiceDesigner.isAvailable(),
    sfx_engine_ready: sfxEngine.isAvailable()
  });
});

const PORT = config.port || 8090;
const HOST = config.host || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log("=".repeat(60));
  console.log(`[AIRI Audio Server] Running on http://${HOST}:${PORT}`);
  console.log(`OpenAI Speech Endpoint  : http://localhost:${PORT}/v1/audio/speech`);
  console.log(`OpenAI Models Endpoint  : http://localhost:${PORT}/v1/models`);
  console.log(`Voice Discovery         : http://localhost:${PORT}/v1/voices`);
  console.log(`Capabilities Manifest   : http://localhost:${PORT}/v1/capabilities`);
  console.log(`Generative Music Engine : http://localhost:${PORT}/v1/audio/music`);
  console.log(`ABC Score Music Planner : http://localhost:${PORT}/v1/audio/music/plan`);
  console.log(`LoRA Cartridge Manager  : http://localhost:${PORT}/v1/audio/music/loras`);
  console.log(`Voice Designer Endpoint : http://localhost:${PORT}/v1/audio/voice-design`);
  console.log(`Sound Effects (SFX)     : http://localhost:${PORT}/v1/audio/sfx`);
  console.log("=".repeat(60));
});

// Cleanup process on shutdown
process.on('SIGINT', () => {
  console.log('[AIRI Server] Gracefully shutting down...');
  engine.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[AIRI Server] Gracefully shutting down...');
  engine.stop();
  process.exit(0);
});
