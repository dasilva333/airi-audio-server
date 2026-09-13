const fs = require('fs');
const path = require('path');
const { normalizeAudioToWav, ensureOptimalAudioLength } = require('./ffmpeg');
const { transcribeAudio } = require('./stt');

const PLACEHOLDER = 'Speaker reference sample.';

function resolvePath(relativePath) {
  if (!relativePath) return '';
  if (path.isAbsolute(relativePath)) return relativePath;
  return path.resolve(__dirname, '..', relativePath);
}

class VoiceManager {
  constructor(voicesDir, vocabularyPath, asrConfig, chatterboxDir = '../chatterbox/voices') {
    this.voicesDir = resolvePath(voicesDir);
    this.vocabularyPath = resolvePath(vocabularyPath);
    this.chatterboxDir = resolvePath(chatterboxDir);
    this.asrConfig = asrConfig;
    this.vocabulary = {};
    
    // Auto-create voicesDir if missing
    if (!fs.existsSync(this.voicesDir)) {
      fs.mkdirSync(this.voicesDir, { recursive: true });
    }
    this.loadVocabulary();
  }

  loadVocabulary() {
    if (fs.existsSync(this.vocabularyPath)) {
      try {
        const raw = fs.readFileSync(this.vocabularyPath, 'utf-8');
        this.vocabulary = JSON.parse(raw);
      } catch (err) {
        console.error(`[Voices] Error loading vocabulary: ${err.message}`);
        this.vocabulary = {};
      }
    } else {
      // Auto-initialize vocabulary file if missing
      this.vocabulary = {};
      this.saveVocabulary();
    }
  }

  saveVocabulary() {
    const dir = path.dirname(this.vocabularyPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.vocabularyPath, JSON.stringify(this.vocabulary, null, 2), 'utf-8');
  }

  safeArchiveFile(filePath) {
    if (fs.existsSync(filePath)) {
      try {
        const archiveDir = path.join(this.voicesDir, 'archive');
        if (!fs.existsSync(archiveDir)) {
          fs.mkdirSync(archiveDir, { recursive: true });
        }
        const timestamp = Date.now();
        const ext = path.extname(filePath);
        const base = path.basename(filePath, ext);
        const backupPath = path.join(archiveDir, `${base}_${timestamp}${ext}.bak`);
        fs.renameSync(filePath, backupPath);
        console.log(`[Voices Safety] Safely archived previous file: ${path.basename(filePath)} -> archive/${path.basename(backupPath)}`);
      } catch (e) {
        console.error(`[Voices Safety Warning] Could not archive file: ${e.message}`);
      }
    }
  }

  getVoiceFile(voiceId) {
    if (!voiceId) return null;
    const extensions = ['.wav', '.mp3', '.ogg', '.m4a', '.flac'];

    // 1. Check inside local voicesDir
    for (const ext of extensions) {
      const candidate = path.join(this.voicesDir, `${voiceId}${ext}`);
      if (fs.existsSync(candidate) && fs.statSync(candidate).size > 0) return candidate;
    }

    // 2. Check fallback chatterbox voices
    if (fs.existsSync(this.chatterboxDir)) {
      for (const ext of extensions) {
        const candidate = path.join(this.chatterboxDir, `${voiceId}${ext}`);
        if (fs.existsSync(candidate) && fs.statSync(candidate).size > 0) return candidate;
      }
    }

    return null;
  }

  async ingestVoiceAudio(inputPath, voiceId, userProvidedTranscript = null) {
    if (!fs.existsSync(inputPath)) {
      throw new Error(`Voice reference file not found: ${inputPath}`);
    }

    let targetWavPath = path.join(this.voicesDir, `${voiceId}.wav`);

    // ZERO FILE DELETION RULE: Safely archive existing local file only if replacing with the same extension
    const existingFile = this.getVoiceFile(voiceId);
    const resolvedVoicesDir = path.resolve(this.voicesDir);
    const isLocalReplaceable = existingFile
      && existingFile !== targetWavPath
      && path.resolve(existingFile).startsWith(resolvedVoicesDir)
      && path.extname(existingFile).toLowerCase() === path.extname(targetWavPath).toLowerCase();

    const existingIsSource = existingFile && path.resolve(existingFile) === path.resolve(inputPath);

    if (isLocalReplaceable && !existingIsSource) {
      console.log(`[Voices Safety] Archiving previous local voice file '${path.basename(existingFile)}'...`);
      this.safeArchiveFile(existingFile);
    }

    // Step 1: Normalize audio format to 24kHz mono PCM WAV via FFmpeg into local voicesDir
    await normalizeAudioToWav(inputPath, targetWavPath);

    if (isLocalReplaceable && existingIsSource) {
      console.log(`[Voices Safety] Archiving previous local voice file '${path.basename(existingFile)}'...`);
      this.safeArchiveFile(existingFile);
    }

    // Step 2: Auto-concatenation if reference audio is too short (< 1.5s)
    await ensureOptimalAudioLength(targetWavPath);

    // Step 3: Handle transcript (User provided vs ASR)
    const sidecarTxt = path.join(this.voicesDir, `${voiceId}.txt`);
    let transcript = '';
    let hasTranscript = false;

    if (userProvidedTranscript && typeof userProvidedTranscript === 'string' && userProvidedTranscript.trim().length > 0) {
      transcript = userProvidedTranscript.trim();
      hasTranscript = true;
      fs.writeFileSync(sidecarTxt, transcript, 'utf-8');
      console.log(`[Voices] Ingested user-provided reference transcript for voice '${voiceId}' (${transcript.length} chars).`);
    } else {
      // Transcribe reference clip with local ASR engine
      try {
        transcript = await transcribeAudio(targetWavPath, this.asrConfig);
      } catch (asrErr) {
        console.warn(`[Voices Warning] ASR transcription failed for '${voiceId}': ${asrErr.message}`);
        transcript = '';
      }

      if (transcript && transcript !== PLACEHOLDER) {
        hasTranscript = true;
        fs.writeFileSync(sidecarTxt, transcript, 'utf-8');
        console.log(`[Voices] ASR transcription successful for voice '${voiceId}': "${transcript}"`);
      } else {
        // Check if there is an existing known transcript
        const knownTranscript = this.vocabulary[voiceId]?.transcript;
        if (fs.existsSync(sidecarTxt)) {
          const sidecarContent = fs.readFileSync(sidecarTxt, 'utf-8').trim();
          if (sidecarContent && sidecarContent !== PLACEHOLDER) {
            transcript = sidecarContent;
            hasTranscript = true;
          }
        } else if (knownTranscript && knownTranscript !== PLACEHOLDER) {
          transcript = knownTranscript;
          hasTranscript = true;
        }

        if (!hasTranscript) {
          console.warn(`[Voices Notice] Voice '${voiceId}' saved without transcript. Local ASR unconfigured or failed. Zero-shot cloning can be improved by adding a transcript.`);
          transcript = '';
        }
      }
    }

    const relFile = path.relative(path.resolve(__dirname, '..'), targetWavPath).replace(/\\/g, '/');
    this.vocabulary[voiceId] = {
      file: relFile,
      transcript: transcript
    };
    this.saveVocabulary();

    return {
      file: targetWavPath,
      transcript: transcript,
      has_transcript: hasTranscript
    };
  }

  updateVoiceTranscript(voiceId, transcript) {
    if (!voiceId) throw new Error('Missing voiceId');
    const file = this.getVoiceFile(voiceId);
    if (!file) throw new Error(`Voice '${voiceId}' not found on disk`);

    const cleanedText = (transcript || '').trim();
    const sidecarTxt = path.join(this.voicesDir, `${voiceId}.txt`);

    if (cleanedText && cleanedText !== PLACEHOLDER) {
      fs.writeFileSync(sidecarTxt, cleanedText, 'utf-8');
    } else if (fs.existsSync(sidecarTxt)) {
      try { fs.unlinkSync(sidecarTxt); } catch (e) {}
    }

    const relFile = path.relative(path.resolve(__dirname, '..'), file).replace(/\\/g, '/');
    this.vocabulary[voiceId] = {
      file: relFile,
      transcript: cleanedText
    };
    this.saveVocabulary();

    return {
      status: 'updated',
      voice_id: voiceId,
      has_transcript: Boolean(cleanedText && cleanedText !== PLACEHOLDER),
      transcript: cleanedText
    };
  }

  deleteVoice(voiceId) {
    if (!voiceId) throw new Error('Missing voiceId');
    const file = this.getVoiceFile(voiceId);
    if (!file) throw new Error(`Voice '${voiceId}' not found on disk`);

    // Safely archive audio file
    this.safeArchiveFile(file);

    // Safely archive sidecar txt if present
    const sidecarTxt = path.join(this.voicesDir, `${voiceId}.txt`);
    if (fs.existsSync(sidecarTxt)) {
      this.safeArchiveFile(sidecarTxt);
    }

    // Remove from vocabulary
    delete this.vocabulary[voiceId];
    this.saveVocabulary();

    return {
      status: 'archived',
      voice_id: voiceId
    };
  }

  async resolveVoice(voiceId) {
    if (!voiceId) return null;

    // Check vocabulary first (rejecting any legacy placeholder strings)
    if (this.vocabulary[voiceId] && fs.existsSync(resolvePath(this.vocabulary[voiceId].file))) {
      const vocabFile = resolvePath(this.vocabulary[voiceId].file);
      const vocabTranscript = this.vocabulary[voiceId].transcript;
      if (fs.statSync(vocabFile).size > 0 && vocabTranscript && vocabTranscript !== PLACEHOLDER) {
        return {
          file: vocabFile,
          transcript: vocabTranscript
        };
      }
    }

    // Check sidecar .txt file if present
    const sidecarTxt = path.join(this.voicesDir, `${voiceId}.txt`);
    if (fs.existsSync(sidecarTxt)) {
      const txt = fs.readFileSync(sidecarTxt, 'utf-8').trim();
      if (txt && txt !== PLACEHOLDER) {
        const file = this.getVoiceFile(voiceId);
        if (file) {
          const relFile = path.relative(path.resolve(__dirname, '..'), file).replace(/\\/g, '/');
          this.vocabulary[voiceId] = {
            file: relFile,
            transcript: txt
          };
          this.saveVocabulary();
          return {
            file: file,
            transcript: txt
          };
        }
      }
    }

    const file = this.getVoiceFile(voiceId);
    if (!file) return null;

    // Voice file exists but transcript is missing -> Run shared ingestion pipeline into local voices/
    console.log(`[Voices] Missing transcript for voice '${voiceId}'. Ingesting reference into local voices/ folder...`);
    return await this.ingestVoiceAudio(file, voiceId);
  }

  listVoices() {
    const list = new Set(Object.keys(this.vocabulary));

    const checkDir = (dirPath) => {
      if (fs.existsSync(dirPath)) {
        const files = fs.readdirSync(dirPath);
        for (const f of files) {
          const ext = path.extname(f).toLowerCase();
          if (['.wav', '.mp3', '.ogg', '.m4a', '.flac'].includes(ext)) {
            list.add(path.basename(f, ext));
          }
        }
      }
    };

    checkDir(this.voicesDir);
    checkDir(this.chatterboxDir);
    return Array.from(list);
  }

  listVoiceObjects() {
    const names = this.listVoices();
    return names.map((name) => {
      let transcript = this.vocabulary[name]?.transcript || '';
      if (!transcript) {
        const sidecarTxt = path.join(this.voicesDir, `${name}.txt`);
        if (fs.existsSync(sidecarTxt)) {
          transcript = fs.readFileSync(sidecarTxt, 'utf-8').trim();
        } else if (this.chatterboxDir) {
          const cbTxt = path.join(this.chatterboxDir, `${name}.txt`);
          if (fs.existsSync(cbTxt)) {
            transcript = fs.readFileSync(cbTxt, 'utf-8').trim();
          }
        }
      }

      const hasTranscript = Boolean(transcript && transcript !== PLACEHOLDER);
      const isNative = this.chatterboxDir && fs.existsSync(path.join(this.chatterboxDir, `${name}.wav`));

      return {
        id: name,
        name: name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
        voice_id: name,
        has_transcript: hasTranscript,
        reference_text: hasTranscript ? transcript : '',
        preview_url: `/v1/voices/${name}/audio`,
        languages: [{ code: 'en', title: 'English' }],
        gender: 'neutral',
        provider: 'airi',
        type: isNative ? 'native' : 'cloned'
      };
    });
  }
}

module.exports = VoiceManager;
