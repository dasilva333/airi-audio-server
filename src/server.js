const path = require('path');
const express = require('express');
const cors = require('cors');

const config = require('../config.json');
const UnifiedGpuQueue = require('./queue');
const TextProcessor = require('./text');
const AudioCppEngine = require('./engine');
const VoiceManager = require('./voices');
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

const router = createRouter(engine, voiceManager, textProcessor, gpuQueue, config);
app.use(router);

// Global health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    engine_ready: engine.isReady,
    active_model: engine.activeModel || engine.getDefaultModelId()
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
