const fs = require('fs');
const path = require('path');
const { normalizeAudioToWav, ensureOptimalAudioLength } = require('./ffmpeg');
const { runWhisperStt } = require('./stt');

class VoiceManager {
  constructor(voicesDir, vocabularyPath, whisperConfig) {
    this.voicesDir = voicesDir;
    this.vocabularyPath = vocabularyPath;
    this.whisperConfig = whisperConfig;
    this.vocabulary = {};
    
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
    }
  }

  saveVocabulary() {
    fs.writeFileSync(this.vocabularyPath, JSON.stringify(this.vocabulary, null, 2), 'utf-8');
  }

  getVoiceFile(voiceId) {
    if (!voiceId) return null;
    const extensions = ['.wav', '.mp3', '.ogg', '.m4a', '.flac'];

    // 1. Check inside local voicesDir
    for (const ext of extensions) {
      const candidate = path.join(this.voicesDir, `${voiceId}${ext}`);
      if (fs.existsSync(candidate)) return candidate;
    }

    // 2. Check fallback chatterbox voices
    const chatterboxVoices = path.join("C:\\Users\\h4rdc\\Documents\\Github\\coding-agent\\chatterbox\\voices");
    for (const ext of extensions) {
      const candidate = path.join(chatterboxVoices, `${voiceId}${ext}`);
      if (fs.existsSync(candidate)) return candidate;
    }

    return null;
  }

  async ingestVoiceAudio(inputPath, voiceId) {
    // Enforce Strict Hidden Rule: Prevent duplicate basenames
    const existingFile = this.getVoiceFile(voiceId);
    let targetWavPath = path.join(this.voicesDir, `${voiceId}.wav`);

    if (existingFile && existingFile !== targetWavPath) {
      console.log(`[Voices] Updating voice '${voiceId}' (replacing ${path.basename(existingFile)})...`);
      try { fs.unlinkSync(existingFile); } catch (e) {}
    }

    // Step 1: Normalize audio format to 24kHz mono PCM WAV via FFmpeg
    await normalizeAudioToWav(inputPath, targetWavPath);

    // Step 2: Auto-concatenation if reference audio is too short (< 1.5s)
    await ensureOptimalAudioLength(targetWavPath);

    // Step 3: Run Whisper STT for reference transcript
    const transcript = await runWhisperStt(targetWavPath, this.whisperConfig);

    // Step 4: Write sidecar .txt file and update vocabulary json
    const sidecarTxt = path.join(this.voicesDir, `${voiceId}.txt`);
    fs.writeFileSync(sidecarTxt, transcript, 'utf-8');

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
    if (this.vocabulary[voiceId] && fs.existsSync(this.vocabulary[voiceId].file)) {
      return this.vocabulary[voiceId];
    }

    const file = this.getVoiceFile(voiceId);
    if (!file) return null;

    // Voice file exists but transcript is missing -> Run shared ingestion pipeline!
    console.log(`[Voices] Missing transcript for voice '${voiceId}'. Running JIT ingestion pipeline...`);
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
    checkDir(path.join("C:\\Users\\h4rdc\\Documents\\Github\\coding-agent\\chatterbox\\voices"));
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
