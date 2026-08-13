#!/usr/bin/env node
/**
 * Rebuild reference transcripts for every voice in voices/.
 *
 * Zero-shot cloning conditions on both the reference clip and the text of what
 * that clip says, so a missing or placeholder transcript produces badly distorted
 * speech. This re-runs the local ASR engine over every reference clip and rewrites
 * voice_vocabulary.json plus the per-voice .txt sidecars.
 *
 * Usage:
 *   node tools/transcribe-voices.js            # only voices lacking a real transcript
 *   node tools/transcribe-voices.js --all      # re-transcribe everything
 */

const path = require('path');
const config = require('../config.json');
const VoiceManager = require('../src/voices');

const PLACEHOLDER = 'Speaker reference sample.';

async function main() {
  const force = process.argv.includes('--all');
  const voicesDir = path.join(__dirname, '../voices');
  const vocabularyPath = path.join(voicesDir, 'voice_vocabulary.json');
  const manager = new VoiceManager(voicesDir, vocabularyPath, config.asr);

  const voiceIds = manager.listVoices().sort();
  console.log(`Found ${voiceIds.length} voices. Mode: ${force ? 'all' : 'missing/placeholder only'}\n`);

  const done = [];
  const skipped = [];
  const failed = [];

  for (const voiceId of voiceIds) {
    const existing = manager.vocabulary[voiceId]?.transcript;
    if (!force && existing && existing !== PLACEHOLDER) {
      skipped.push(voiceId);
      continue;
    }

    const file = manager.getVoiceFile(voiceId);
    if (!file) {
      failed.push(`${voiceId} (no audio file)`);
      continue;
    }

    try {
      const result = await manager.ingestVoiceAudio(file, voiceId);
      if (!result.transcript || result.transcript === PLACEHOLDER) {
        failed.push(`${voiceId} (no transcript produced)`);
      } else {
        done.push(voiceId);
      }
    } catch (err) {
      failed.push(`${voiceId} (${err.message})`);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Transcribed : ${done.length}`);
  console.log(`Skipped     : ${skipped.length} (already had a transcript)`);
  console.log(`Failed      : ${failed.length}`);
  for (const f of failed) console.log(`  - ${f}`);
  console.log('='.repeat(60));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
