const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { convertWavToOgg } = require('./ffmpeg');
const { runWhisperStt } = require('./stt');

const upload = multer({ dest: path.join(__dirname, '../temp_uploads') });

function parseWavDuration(buffer) {
  if (buffer.length < 44) return 0;
  const byteRate = buffer.readUInt32LE(28);
  if (byteRate === 0) return 0;
  return (buffer.length - 44) / byteRate;
}

function createRouter(engine, voiceManager, textProcessor, gpuQueue, config) {
  const router = express.Router();

  // GET /v1/models (OpenAI Specification)
  router.get('/v1/models', (req, res) => {
    const installed = config.installed_models || Object.keys(config.models);
    res.json({
      object: 'list',
      data: installed.map(id => ({
        id: id,
        object: 'model',
        created: 1700000000,
        owned_by: 'airi'
      }))
    });
  });

  // GET Voice Discovery Waterfall (/v1/voices, /v1/audio/voices, /voices)
  const handleListVoices = (req, res) => {
    res.json(voiceManager.listVoiceObjects());
  };
  router.get('/v1/voices', handleListVoices);
  router.get('/v1/audio/voices', handleListVoices);
  router.get('/voices', handleListVoices);

  // GET Capabilities Manifest (/v1/capabilities, /chatterbox/capabilities)
  const handleCapabilities = (req, res) => {
    res.json({
      voices: voiceManager.listVoices(),
      profiles: [],
      modes: config.installed_models || Object.keys(config.models),
      speech: {
        supportsPresets: false,
        supportsExpressionTags: true,
        supportsMannerisms: false,
        expressionTags: [
          { category: "emotion", tag: "question-en", description: "OmniVoice: English question intonation" },
          { category: "emotion", tag: "sigh", description: "OmniVoice: Native sigh" },
          { category: "emotion", tag: "laughter", description: "OmniVoice: Native laughter" },
          { category: "emotion", tag: "surprise-oh", description: "OmniVoice: Surprised oh" },
          { category: "emotion", tag: "confirmation-en", description: "OmniVoice: English confirmation" }
        ],
        mannerisms: []
      }
    });
  };
  router.get('/v1/capabilities', handleCapabilities);
  router.get('/chatterbox/capabilities', handleCapabilities);

  // POST /v1/voices & /v1/audio/voices (Custom Voice Registration Endpoint)
  const handleRegisterVoice = async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: { message: "No audio file uploaded." } });
      }
      const voiceId = req.body.voice_id || req.body.name || path.basename(req.file.originalname, path.extname(req.file.originalname));
      const cleanVoiceId = voiceId.toLowerCase().replace(/[^a-z0-9_-]/g, '_');

      const result = await gpuQueue.enqueue(async () => {
        return await voiceManager.ingestVoiceAudio(req.file.path, cleanVoiceId);
      });

      try { fs.unlinkSync(req.file.path); } catch (e) {}

      res.status(201).json({
        status: 'registered',
        voice_id: cleanVoiceId,
        file: result.file,
        transcript: result.transcript
      });
    } catch (err) {
      console.error(`[Voice Register Error] ${err.message}`);
      res.status(500).json({ error: { message: err.message } });
    }
  };
  router.post('/v1/voices', upload.single('file'), handleRegisterVoice);
  router.post('/v1/audio/voices', upload.single('file'), handleRegisterVoice);

  // POST /v1/audio/transcriptions (OpenAI Speech-to-Text Endpoint)
  router.post('/v1/audio/transcriptions', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: { message: "No audio file provided." } });
      }
      const transcript = await gpuQueue.enqueue(async () => {
        return await runWhisperStt(req.file.path, config.whisper_cpp);
      });
      try { fs.unlinkSync(req.file.path); } catch (e) {}

      res.json({ text: transcript });
    } catch (err) {
      console.error(`[STT Error] ${err.message}`);
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // POST /v1/audio/speech & /audio/speech (OpenAI Speech Synthesis Endpoint)
  const handleSpeech = async (req, res) => {
    try {
      let { model, input, voice = 'morgan-freeman', response_format = 'ogg', allow_unfiltered_tags = false } = req.body;

      // AIRI Health Check Fallback: If voice is 'alloy' or model is 'tts-1', fallback gracefully!
      if (!voice || voice === 'alloy' || !voiceManager.getVoiceFile(voice)) {
        voice = 'morgan-freeman';
      }

      // Check non-spoken text rule: return 204 No Content if input lacks pronounceable letters
      if (!textProcessor.hasPronounceableText(input)) {
        console.log(`[API] Input text contains no pronounceable words. Returning 204 No Content.`);
        return res.status(204).send();
      }

      const modelId = engine.resolveModelId(model);
      const modelCfg = config.models[modelId] || {};
      const shouldBypass = allow_unfiltered_tags || modelCfg.allow_unfiltered_tags || false;

      // Clean emojis & filter/preserve tags based on model family
      const cleanedInput = textProcessor.process(input, modelCfg.family, shouldBypass);

      console.log(`[API] Speech Request: model='${modelId}', voice='${voice}', fmt='${response_format}'`);
      const tStart = Date.now();

      // Enqueue job in Unified Serialized GPU FIFO Queue
      const { finalBuffer, rawWavBuffer, audioDuration } = await gpuQueue.enqueue(async () => {
        // Resolve voice reference & JIT STT transcription if needed
        const voiceData = await voiceManager.resolveVoice(voice);
        const voiceRef = voiceData ? voiceData.file : null;
        const refText = voiceData ? voiceData.transcript : '';

        // Synthesize via audio.cpp
        const rawBuffer = await engine.synthesize(cleanedInput, modelId, voiceRef, refText);
        const dur = parseWavDuration(rawBuffer);

        let finalBuf = rawBuffer;
        if (response_format === 'ogg' || response_format === 'opus') {
          finalBuf = await convertWavToOgg(rawBuffer);
        }

        return { finalBuffer: finalBuf, rawWavBuffer: rawBuffer, audioDuration: dur };
      });

      const latencyMs = Date.now() - tStart;
      const latencySec = (latencyMs / 1000).toFixed(3);
      const rtf = audioDuration > 0 ? (latencyMs / 1000 / audioDuration).toFixed(4) : "0.0000";
      const realtimeSpeed = latencyMs > 0 && audioDuration > 0 ? (audioDuration / (latencyMs / 1000)).toFixed(2) : "0.00";

      console.log("=".repeat(60));
      console.log(`[API RTF Metric] Synthesis SUCCESS`);
      console.log(`  Model           : ${modelId}`);
      console.log(`  Latency         : ${latencySec}s (${latencyMs} ms)`);
      console.log(`  Audio Duration  : ${audioDuration.toFixed(2)}s`);
      console.log(`  Real-Time Factor: ${rtf} (${realtimeSpeed}x real-time speed)`);
      console.log("=".repeat(60));

      const contentType = response_format === 'ogg' ? 'audio/ogg' : 'audio/wav';
      res.setHeader('Content-Type', contentType);
      res.setHeader('X-Synthesis-Latency-Ms', latencyMs.toString());
      res.setHeader('X-Audio-Duration-Sec', audioDuration.toFixed(2));
      res.setHeader('X-Real-Time-Factor', rtf);
      res.setHeader('X-Realtime-Speed', `${realtimeSpeed}x`);

      return res.status(200).send(finalBuffer);

    } catch (err) {
      console.error(`[Speech API Error] ${err.message}`);
      res.status(500).json({ error: { message: err.message } });
    }
  };

  router.post('/v1/audio/speech', handleSpeech);
  router.post('/audio/speech', handleSpeech);

  return router;
}

module.exports = createRouter;
