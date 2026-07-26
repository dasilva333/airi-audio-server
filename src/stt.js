const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function runWhisperStt(audioPath, whisperConfig) {
  return new Promise((resolve, reject) => {
    const resolvedAudio = path.resolve(audioPath);
    console.log(`[Whisper GPU] Transcribing ${path.basename(resolvedAudio)}...`);

    const pythonExe = "C:\\Users\\h4rdc\\Documents\\Github\\coding-agent\\chatterbox\\venv\\Scripts\\python.exe";
    const pyCmd = `"${pythonExe}" -c "from transformers import pipeline; pipe = pipeline('automatic-speech-recognition', model='openai/whisper-small'); print('WHISPER_STT_RESULT:' + pipe(r'${resolvedAudio}')['text'])"`;

    try {
      const stdout = execSync(pyCmd, { encoding: 'utf-8', timeout: 45000 });
      const match = stdout.match(/WHISPER_STT_RESULT:\s*(.+)/);
      const text = match ? match[1].trim() : "Speaker reference sample.";
      console.log(`[Whisper GPU] Auto-Transcribed: "${text}"`);
      resolve(text);
    } catch (err) {
      console.error(`[Whisper GPU Error] ${err.message}`);
      resolve("Speaker reference sample.");
    }
  });
}

module.exports = { runWhisperStt };
