const fs = require('fs');
const path = require('path');
const { normalizeAudioToWav, ensureOptimalAudioLength } = require('./ffmpeg');
const { transcribeAudio } = require('./stt');

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

  async ingestVoiceAudio(inputPath, voiceId) {
    if (!fs.existsSync(inputPath)) {
      throw new Error(`Voice reference file not found: ${inputPath}`);
    }

    let targetWavPath = path.join(this.voicesDir, `${voiceId}.wav`);

    // ZERO FILE DELETION RULE: Safely archive existing local file if replacing inside local voicesDir
    const existingFile = this.getVoiceFile(voiceId);
    const resolvedVoicesDir = path.resolve(this.voicesDir);
    const isLocalReplaceable = existingFile
      && existingFile !== targetWavPath
      && path.resolve(existingFile).startsWith(resolvedVoicesDir);
    // The existing local file is often the very file we are ingesting from (e.g. a
    // bundled voices/name.mp3 being normalized to voices/name.wav). Archiving it up
    // front moves FFmpeg's input out from under it, so defer that case until after
    // the normalized WAV has been written.
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

    // Step 3: Transcribe the reference clip with the local ASR engine
    const sidecarTxt = path.join(this.voicesDir, `${voiceId}.txt`);
    let transcript = await transcribeAudio(targetWavPath, this.asrConfig);

    // A mismatched reference transcript wrecks zero-shot cloning, so never let a
    // failed transcription overwrite a transcript that is already known-good.
    if (!transcript) {
      const knownTranscript = this.vocabulary[voiceId]?.transcript;
      if (fs.existsSync(sidecarTxt)) {
        transcript = fs.readFileSync(sidecarTxt, 'utf-8').trim();
      }
      else if (knownTranscript) {
        transcript = knownTranscript;
      }
      if (!transcript) {
        console.warn(`[Voices] No transcript available for '${voiceId}'. Cloning quality will suffer.`);
        transcript = 'Speaker reference sample.';
      }
    }
    else {
      fs.writeFileSync(sidecarTxt, transcript, 'utf-8');
    }

    this.vocabulary[voiceId] = {
      file: targetWavPath,
      transcript: transcript
    };
    this.saveVocabulary();

    return {
      file: targetWavPath,
      transcript: transcript
    };
  }

  async resolveVoice(voiceId) {
    if (!voiceId) return null;

    // Check vocabulary first
    if (this.vocabulary[voiceId] && fs.existsSync(resolvePath(this.vocabulary[voiceId].file))) {
      const vocabFile = resolvePath(this.vocabulary[voiceId].file);
      if (fs.statSync(vocabFile).size > 0) {
        return {
          file: vocabFile,
          transcript: this.vocabulary[voiceId].transcript
        };
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
    return names.map(name => ({
      id: name,
      name: name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
      voice_id: name,
      preview_url: null,
      languages: [{ code: 'en', title: 'English' }],
      gender: 'neutral',
      provider: 'airi',
      type: 'native'
    }));
  }
}

module.exports = VoiceManager;
