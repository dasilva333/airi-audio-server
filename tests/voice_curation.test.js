const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const VoiceManager = require('../src/voices');

describe('Voice Curation & Acoustic Alignment (src/voices.js)', () => {
  const voicesDir = path.join(__dirname, '..', 'voices');
  const vocabPath = path.join(voicesDir, 'test_vocabulary.json');
  const voiceManager = new VoiceManager(voicesDir, vocabPath, null, voicesDir);

  const testVoiceId = 'test-voice-auto';
  const testTranscript = 'This is an exact reference transcript for zero-shot acoustic alignment.';
  const updatedTranscript = 'This is an updated phonetic reference transcript.';
  
  // Minimal valid 44-byte PCM WAV header + silence
  const sampleWav = Buffer.from([
    0x52, 0x49, 0x46, 0x46, // "RIFF"
    0x2c, 0x00, 0x00, 0x00, // Size: 44
    0x57, 0x41, 0x56, 0x45, // "WAVE"
    0x66, 0x6d, 0x74, 0x20, // "fmt "
    0x10, 0x00, 0x00, 0x00, // Subchunk1Size (16)
    0x01, 0x00,             // AudioFormat (1 = PCM)
    0x01, 0x00,             // NumChannels (1)
    0x44, 0xac, 0x00, 0x00, // SampleRate (44100)
    0x88, 0x58, 0x01, 0x00, // ByteRate (88200)
    0x02, 0x00,             // BlockAlign (2)
    0x10, 0x00,             // BitsPerSample (16)
    0x64, 0x61, 0x74, 0x61, // "data"
    0x08, 0x00, 0x00, 0x00, // Subchunk2Size (8 bytes)
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
  ]);

  let tempUploadPath;

  before(() => {
    const tempDir = path.join(__dirname, '..', 'temp_uploads');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    tempUploadPath = path.join(tempDir, 'temp_test_audio.wav');
    fs.writeFileSync(tempUploadPath, sampleWav);
  });

  after(() => {
    if (fs.existsSync(tempUploadPath)) {
      fs.unlinkSync(tempUploadPath);
    }
    if (fs.existsSync(vocabPath)) {
      fs.unlinkSync(vocabPath);
    }
    try {
      voiceManager.deleteVoice(testVoiceId);
    } catch {}
  });

  test('ingestVoiceAudio() saves voice with userProvidedTranscript and marks has_transcript true', async () => {
    const res = await voiceManager.ingestVoiceAudio(
      tempUploadPath,
      testVoiceId,
      testTranscript
    );

    assert.ok(res.file, 'should return target file path');
    assert.strictEqual(res.has_transcript, true);
    assert.strictEqual(res.transcript, testTranscript);

    // Verify files on disk
    const targetWav = path.join(voicesDir, `${testVoiceId}.wav`);
    const targetTxt = path.join(voicesDir, `${testVoiceId}.txt`);

    assert.ok(fs.existsSync(targetWav), 'audio WAV file should exist on disk');
    assert.ok(fs.existsSync(targetTxt), 'transcript TXT file should exist on disk');

    const diskText = fs.readFileSync(targetTxt, 'utf-8').trim();
    assert.strictEqual(diskText, testTranscript);
  });

  test('listVoiceObjects() includes newly ingested voice with transcript metadata', () => {
    const list = voiceManager.listVoiceObjects();
    const found = list.find(v => v.voice_id === testVoiceId || v.id === testVoiceId);

    assert.ok(found, 'newly ingested voice should be listed in catalog');
    assert.strictEqual(found.has_transcript, true);
    assert.strictEqual(found.reference_text, testTranscript);
  });

  test('updateVoiceTranscript() updates transcript on disk and in catalog', () => {
    const res = voiceManager.updateVoiceTranscript(testVoiceId, updatedTranscript);

    assert.strictEqual(res.status, 'updated');
    assert.strictEqual(res.transcript, updatedTranscript);

    const targetTxt = path.join(voicesDir, `${testVoiceId}.txt`);
    const diskText = fs.readFileSync(targetTxt, 'utf-8').trim();
    assert.strictEqual(diskText, updatedTranscript);

    const list = voiceManager.listVoiceObjects();
    const found = list.find(v => v.voice_id === testVoiceId || v.id === testVoiceId);
    assert.strictEqual(found.reference_text, updatedTranscript);
  });

  test('deleteVoice() throws or rejects path traversal attempts', () => {
    const traversalAttempt = '../../secret_system_file';
    assert.throws(
      () => voiceManager.deleteVoice(traversalAttempt),
      /not found|Missing/
    );
  });

  test('deleteVoice() permanently removes voice files and unindexes from catalog', () => {
    const res = voiceManager.deleteVoice(testVoiceId);
    assert.strictEqual(res.status, 'archived');

    const targetWav = path.join(voicesDir, `${testVoiceId}.wav`);
    const targetTxt = path.join(voicesDir, `${testVoiceId}.txt`);

    assert.ok(!fs.existsSync(targetWav), 'WAV file should be removed');
    assert.ok(!fs.existsSync(targetTxt), 'TXT file should be removed');

    const list = voiceManager.listVoiceObjects();
    const found = list.find(v => v.voice_id === testVoiceId || v.id === testVoiceId);
    assert.strictEqual(found, undefined, 'voice should no longer be in catalog');
  });
});
