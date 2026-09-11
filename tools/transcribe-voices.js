#!/usr/bin/env node
/**
 * Rebuild reference transcripts for every voice in voices/.
 *
 * Zero-shot cloning conditions on both the reference clip and the text of what
 * that clip says, so a missing or placeholder transcript produces badly distorted
 * speech. This re-runs the local Citrinet ASR engine over every reference clip and rewrites
 * voice_vocabulary.json plus the per-voice .txt sidecars.
 *
 * Usage:
 *   node tools/transcribe-voices.js            # voices lacking a valid transcript
 *   node tools/transcribe-voices.js --all      # re-transcribe everything
 */

const fs = require('fs');
const path = require('path');
const config = require('../config.json');
const { transcribeAudio } = require('../src/stt');

const PLACEHOLDER = 'Speaker reference sample.';

async function main() {
  const force = process.argv.includes('--all');
  const voicesDir = path.resolve(__dirname, '../voices');
  const vocabularyPath = path.join(voicesDir, 'voice_vocabulary.json');

  let vocabulary = {};
  if (fs.existsSync(vocabularyPath)) {
    try {
      vocabulary = JSON.parse(fs.readFileSync(vocabularyPath, 'utf8'));
    } catch (e) {
      vocabulary = {};
    }
  }

  // Scan voices directory for audio files
  const audioExtensions = new Set(['.wav', '.mp3', '.ogg', '.m4a', '.flac']);
  const files = fs.readdirSync(voicesDir).filter(f => audioExtensions.has(path.extname(f).toLowerCase()));

  // Deduplicate by voiceId (base name)
  const voiceMap = new Map();
  for (const f of files) {
    const ext = path.extname(f);
    const base = path.basename(f, ext);
    if (base.startsWith('personal_')) continue;

    // Prefer WAV over MP3/OGG if both exist
    if (!voiceMap.has(base) || ext.toLowerCase() === '.wav') {
      voiceMap.set(base, f);
    }
  }

  const voiceIds = Array.from(voiceMap.keys()).sort();
  console.log(`Found ${voiceIds.length} bundled voices in voices/. Mode: ${force ? 'all' : 'missing/placeholder only'}\n`);

  const done = [];
  const skipped = [];
  const failed = [];

  const asrConfig = config.asr || {
    family: 'citrinet_asr',
    model_path: 'models/Citrinet-ASR-GGUF/citrinet-asr-q8_0.gguf',
    backend: 'cuda'
  };

  for (const voiceId of voiceIds) {
    const audioFileName = voiceMap.get(voiceId);
    const audioPath = path.join(voicesDir, audioFileName);
    const sidecarTxt = path.join(voicesDir, `${voiceId}.txt`);

    let existingTxt = null;
    if (fs.existsSync(sidecarTxt)) {
      existingTxt = fs.readFileSync(sidecarTxt, 'utf8').trim();
    }
    const existingVocab = vocabulary[voiceId]?.transcript;

    // Identify known corrupted / placeholder transcripts
    const isCorrupted = (txt) => {
      if (!txt) return true;
      if (txt === PLACEHOLDER) return true;
      if (txt.startsWith("Mae'r unrhyw o'r cyfnodd")) return true; // Welsh hallucination
      return false;
    };

    if (!force && !isCorrupted(existingTxt) && !isCorrupted(existingVocab)) {
      skipped.push(voiceId);
      continue;
    }

    try {
      console.log(`[Transcribing] ${voiceId} (${audioFileName})...`);
      const transcript = await transcribeAudio(audioPath, asrConfig);

      if (!transcript || transcript === PLACEHOLDER) {
        failed.push(`${voiceId} (no transcript produced)`);
      } else {
        fs.writeFileSync(sidecarTxt, transcript, 'utf8');
        vocabulary[voiceId] = {
          file: `voices/${audioFileName}`,
          transcript: transcript
        };
        done.push(`${voiceId}: "${transcript}"`);
        console.log(`  -> "${transcript}"\n`);
      }
    } catch (err) {
      console.error(`  [Error] ${voiceId}: ${err.message}\n`);
      failed.push(`${voiceId} (${err.message})`);
    }
  }

  // Clean vocabulary of any placeholder or deleted entries
  for (const k of Object.keys(vocabulary)) {
    if (isCorrupted(vocabulary[k]?.transcript)) {
      delete vocabulary[k];
    }
  }

  fs.writeFileSync(vocabularyPath, JSON.stringify(vocabulary, null, 2), 'utf8');

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Transcribed : ${done.length}`);
  console.log(`Skipped     : ${skipped.length} (already had valid transcript)`);
  console.log(`Failed      : ${failed.length}`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`  - ${f}`);
  }
  console.log('='.repeat(60));
}

function isCorrupted(txt) {
  if (!txt) return true;
  if (txt === PLACEHOLDER) return true;
  if (txt.startsWith("Mae'r unrhyw o'r cyfnodd")) return true;
  return false;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
