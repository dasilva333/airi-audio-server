const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8095;
const OUTPUT_FILE = path.join(__dirname, 'higgs_benchmark_result.ogg');

function runHiggsBenchmark() {
  console.log("=".repeat(60));
  console.log("    AIRI Audio Server - Higgs Audio v3 Benchmark Test      ");
  console.log("=".repeat(60));
  console.log(`Target Endpoint: http://localhost:${PORT}/v1/audio/speech`);
  console.log(`Target Voice   : morgan-freeman`);
  console.log(`Target Model   : higgs-audio-tts\n`);

  const payload = JSON.stringify({
    model: "higgs-audio-tts",
    voice: "morgan-freeman",
    input: "<|emotion:amusement|> Welcome to the new audio.cpp C++ inference pipeline! <|sfx:laughter|>",
    response_format: "ogg"
  });

  const req = http.request(`http://127.0.0.1:${PORT}/v1/audio/speech`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    },
    timeout: 120000
  }, (res) => {
    const chunks = [];
    const tStart = Date.now();

    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => {
      if (res.statusCode === 200) {
        const audioBuffer = Buffer.concat(chunks);
        fs.writeFileSync(OUTPUT_FILE, audioBuffer);
        const elapsedSec = ((Date.now() - tStart) / 1000).toFixed(3);

        console.log("=".repeat(60));
        console.log("           HIGGS AUDIO BENCHMARK SUCCESSFUL              ");
        console.log("=".repeat(60));
        console.log(`HTTP Status     : ${res.statusCode} OK`);
        console.log(`Synthesis Time  : ${elapsedSec}s`);
        console.log(`Audio Duration  : ${res.headers['x-audio-duration-sec'] || 'N/A'}s`);
        console.log(`Real-Time Factor: ${res.headers['x-real-time-factor'] || 'N/A'} (${res.headers['x-realtime-speed'] || 'N/A'})`);
        console.log(`Saved Audio File: ${OUTPUT_FILE}`);
        console.log("=".repeat(60));
      } else {
        console.error(`[Benchmark Failed] HTTP Status ${res.statusCode}`);
        console.error(Buffer.concat(chunks).toString('utf-8'));
      }
    });
  });

  req.on('error', (err) => {
    console.error(`[Benchmark Failed] Could not connect to server on port ${PORT}: ${err.message}`);
  });

  req.write(payload);
  req.end();
}

runHiggsBenchmark();
