const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeAudioToWav } = require('../src/ffmpeg');

function createStereoPcmWav(sampleRate, durationSeconds) {
  const channels = 2;
  const bitsPerSample = 16;
  const frameCount = Math.floor(sampleRate * durationSeconds);
  const dataSize = frameCount * channels * (bitsPerSample / 8);
  const wav = Buffer.alloc(44 + dataSize);

  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  wav.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const sample = Math.round(Math.sin(2 * Math.PI * 440 * frame / sampleRate) * 12000);
    wav.writeInt16LE(sample, 44 + frame * 4);
    wav.writeInt16LE(sample, 46 + frame * 4);
  }

  return wav;
}

test('normalizeAudioToWav uses SoXR and produces 24 kHz mono 16-bit PCM', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airi-ffmpeg-test-'));
  const inputPath = path.join(tempDir, 'stereo-input.wav');
  const outputPath = path.join(tempDir, 'normalized.wav');

  try {
    fs.writeFileSync(inputPath, createStereoPcmWav(44100, 0.2));
    await normalizeAudioToWav(inputPath, outputPath);

    const wav = fs.readFileSync(outputPath);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(24), 24000);
    assert.equal(wav.readUInt16LE(34), 16);

    const durationSeconds = (wav.length - 44) / (24000 * 2);
    assert.ok(Math.abs(durationSeconds - 0.2) < 0.001);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
