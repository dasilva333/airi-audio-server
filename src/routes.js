const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { convertWavToOgg, normalizeAudioToWav } = require('./ffmpeg');
const { transcribeAudio } = require('./stt');

const upload = multer({ dest: path.join(__dirname, '../temp_uploads') });

/**
 * Wrap raw PCM in a self-contained WAV container.
 *
 * Each streamed chunk is emitted as a complete WAV rather than a slice of one, so a
 * browser client can decodeAudioData() every chunk on its own and schedule them in
 * sequence. Slices of a single WAV would need MediaSource to play.
 */
function pcmToWav(pcmBuffer, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);           // PCM fmt chunk size
  header.writeUInt16LE(1, 20);            // audio format: PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmBuffer.length, 40);

  return Buffer.concat([header, pcmBuffer]);
}

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
    const ids = [...installed];

    // Advertise the ASR model too. OpenAI-compatible STT clients pick a transcription
    // model from this list, and AIRI filters it for ids containing whisper/stt/asr/
    // transcription, so a TTS-only catalog leaves its model picker empty.
    if (config.asr && config.asr.model_path) {
      ids.push(config.asr.model_id || 'parakeet-tdt-asr');
    }

    res.json({
      object: 'list',
      data: ids.map(id => ({
        id: id,
        object: 'model',
        created: 1700000000,
        owned_by: 'airi'
      }))
    });
  });

  // GET Voice Discovery Waterfall (/v1/voices, /v1/audio/voices, /voices)
  // AIRI's chatterbox provider reads `data.voices`, so the list is wrapped rather
  // than returned as a bare array.
  const handleListVoices = (req, res) => {
    res.json({ voices: voiceManager.listVoiceObjects() });
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
      console.error(`[Voice Register Error] ${err.stack || err.message}`);
      res.status(500).json({ error: { message: err.message, stack: err.stack } });
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
      // The ASR engine only reads PCM WAV, and clients commonly upload WebM/Opus or
      // MP3, which it decodes as silence. Normalize first so any browser-recorded
      // format transcribes instead of silently returning an empty string.
      const normalizedPath = `${req.file.path}.wav`;
      let transcript = '';
      try {
        await normalizeAudioToWav(req.file.path, normalizedPath);
        transcript = await gpuQueue.enqueue(async () => {
          return await transcribeAudio(normalizedPath, config.asr);
        });
      } finally {
        try { fs.unlinkSync(req.file.path); } catch (e) {}
        try { fs.unlinkSync(normalizedPath); } catch (e) {}
      }

      res.json({ text: transcript });
    } catch (err) {
      console.error(`[STT Error] ${err.stack || err.message}`);
      res.status(500).json({ error: { message: err.message, stack: err.stack } });
    }
  });

  // POST /v1/audio/speech & /audio/speech (OpenAI Speech Synthesis Endpoint)
  const handleSpeech = async (req, res) => {
    try {
      let { model, input, voice = 'morgan-freeman', response_format = 'ogg', allow_unfiltered_tags = false } = req.body;

      const requestedVoice = voice;
      // AIRI Health Check & Voice Validation Fallback
      if (!voice || voice === 'alloy' || !voiceManager.getVoiceFile(voice)) {
        voice = 'morgan-freeman';
        if (requestedVoice && requestedVoice !== 'alloy' && requestedVoice !== 'morgan-freeman') {
          console.warn(`[Voices Warning] Requested voice '${requestedVoice}' not found on disk. Falling back to default voice '${voice}'.`);
        }
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

      // Incremental delivery: emit each generated chunk as a standalone WAV over SSE
      // so the client can start playing before the whole utterance is synthesized.
      if (req.body.stream_format === 'sse') {
        const stamp = () => new Date().toISOString().slice(11, 23);
        console.log(`[${stamp()}] [API] Streaming request received: model='${modelId}', voice='${voice}', chars=${input.length}`);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        const tStreamStart = Date.now();
        let firstChunkMs = null;
        let queueWaitMs = null;
        let audioMs = 0;

        try {
          await gpuQueue.enqueue(async () => {
            queueWaitMs = Date.now() - tStreamStart;
            console.log(`[${stamp()}] [API]   GPU queue acquired after ${queueWaitMs}ms`);
            const voiceData = await voiceManager.resolveVoice(voice);
            const tSynth = Date.now();
            console.log(`[${stamp()}] [API]   voice resolved (+${tSynth - tStreamStart}ms), starting synthesis`);
            return await engine.synthesizeStream(
              cleanedInput,
              modelId,
              voiceData ? voiceData.file : null,
              voiceData ? voiceData.transcript : '',
              (pcmChunk, index) => {
                if (firstChunkMs === null) firstChunkMs = Date.now() - tStreamStart;
                const wav = pcmToWav(pcmChunk);
                const chunkSec = (wav.length - 44) / (24000 * 2);
                audioMs += chunkSec * 1000;
                console.log(`[${stamp()}] [API]   chunk ${index} sent at +${Date.now() - tStreamStart}ms (${chunkSec.toFixed(2)}s audio)`);
                res.write(`data: ${JSON.stringify({
                  type: 'speech.audio.delta',
                  index,
                  audio: wav.toString('base64'),
                })}\n\n`);
              }
            );
          });

          const totalMs = Date.now() - tStreamStart;
          res.write(`data: ${JSON.stringify({
            type: 'speech.audio.done',
            timing: { ttft_ms: firstChunkMs, total_ms: totalMs },
          })}\n\n`);
          console.log(
            `[${stamp()}] [API] Stream complete: queue ${queueWaitMs}ms, TTFT ${firstChunkMs}ms, `
            + `total ${totalMs}ms for ${(audioMs / 1000).toFixed(2)}s audio `
            + `(${(audioMs / totalMs).toFixed(2)}x realtime)`
          );
        } catch (err) {
          console.error(`[Speech Stream Error] ${err.stack || err.message}`);
          res.write(`data: ${JSON.stringify({ type: 'error', error: { message: err.message } })}\n\n`);
        }

        res.write('data: [DONE]\n\n');
        return res.end();
      }

      console.log(`[API] Speech Request: model='${modelId}', voice='${voice}' (requested: '${requestedVoice}'), fmt='${response_format}'`);
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
      console.log(`  Voice           : ${voice} (requested: ${requestedVoice})`);
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
      console.error(`[Speech API Error] Detailed Failure:\n${err.stack || err.message}`);
      return res.status(500).json({ 
        error: { 
          message: err.message,
          details: "Check server console output for captured audio.cpp engine logs."
        } 
      });
    }
  };

  router.post('/v1/audio/speech', handleSpeech);
  router.post('/audio/speech', handleSpeech);

  return router;
}

module.exports = createRouter;
