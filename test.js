const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8095;
const OUTPUT_FILE = path.join(__dirname, 'test_result.ogg');

function runTest() {
  console.log("=".repeat(60));
  console.log("      AIRI Audio Server - Verification & Synthesis Test      ");
  console.log("=".repeat(60));
  console.log(`Target Endpoint: http://localhost:${PORT}/v1/audio/speech`);
  console.log(`Target Voice   : morgan-freeman`);
  console.log(`Target Model   : omnivoice-tts\n`);

  const payload = JSON.stringify({
    model: "omnivoice-tts",
    voice: "morgan-freeman",
    input: "Well, [confirmation-en] AIRI Audio Server test completed successfully! [laughter]",
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
        console.log("           AIRI AUDIO SERVER TEST SUCCESSFUL             ");
        console.log("=".repeat(60));
        console.log(`HTTP Status     : ${res.statusCode} OK`);
        console.log(`Synthesis Time  : ${elapsedSec}s`);
        console.log(`Audio Duration  : ${res.headers['x-audio-duration-sec'] || 'N/A'}s`);
        console.log(`Real-Time Factor: ${res.headers['x-real-time-factor'] || 'N/A'} (${res.headers['x-realtime-speed'] || 'N/A'})`);
        console.log(`Saved Audio File: ${OUTPUT_FILE}`);
        console.log("=".repeat(60));
      } else {
        console.error(`[Test Failed] HTTP Status ${res.statusCode}`);
      }
    });
  });

  req.on('error', (err) => {
    console.error(`[Test Failed] Could not connect to server on port ${PORT}: ${err.message}`);
    console.error(`Make sure the server is running ('npm start') before executing this test.`);
  });

  req.write(payload);
  req.end();
}

runTest();
