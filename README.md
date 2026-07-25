# AIRI Audio Server (`airi-audio-server`)

A zero-Python, high-performance C++/Node.js audio microservice providing OpenAI-compatible Text-to-Speech (TTS), Speech-to-Text (STT), and custom voice management endpoints engineered specifically for AIRI.

---

## 🌟 Key Features

* **Zero-Python Dependency**: Built 100% on Node.js + C++ inference binaries (`audio.cpp` and `whisper.cpp`). A single `npm install` and `npm start` setup for end users.
* **Unified Serialized GPU Queue**: All GPU TTS synthesis and STT Whisper jobs pass through a unified FIFO queue, ensuring zero GPU execution collisions or thread contention.
* **On-Demand GPU Whisper (`whisper.cpp`)**: Runs `whisper.cpp` on CUDA GPU for ultra-fast STT, unloading weights from VRAM immediately after completion to keep 100% of VRAM free for TTS synthesis.
* **Just-In-Time Voice Auto-Transcription**: Dropping voice clips into `voices/` or calling `POST /v1/voices` automatically converts audio to 24kHz mono PCM WAV via FFmpeg and runs GPU Whisper to generate sidecar transcripts.
* **Short Audio Self-Concatenation**: If reference audio is too short (< 1.5s), the server automatically self-concatenates the clip to 3–5 seconds so zero-shot voice cloning succeeds cleanly.
* **Paralinguistic Tag Bridge & Bypass Guard**: Bridges `supported_tags.csv` to `/v1/capabilities` and supports `"allow_unfiltered_tags": true` for models with massive tag vocabularies (e.g. Fish Audio S2, Higgs Audio with 15K+ tags).
* **AIRI Health Check Compatibility**: Probes requesting `model: "tts-1"` or `voice: "alloy"` automatically fall back to the primary installed model (`omnivoice-tts`) and default voice (`morgan-freeman`), returning HTTP 200 audio bytes.
* **Opus OGG Default Return Format**: Audio synthesis defaults to Opus OGG (`audio/ogg`) for seamless playback across Telegram, Discord, and AIRI clients.
* **-65.5% VRAM Reduction**: Requires only **1.12 GB VRAM** for `omnivoice-q8_0.gguf` (vs. 3.25 GB in PyTorch).

---

## 🚀 Quick Start

### One-Click Setup
Double-click **`install.bat`** (or run `npm run setup`) to launch the interactive model setup wizard.

### Direct Server Start
```bash
npm start
```

---

## 📡 API Endpoints Specification

### 1. OpenAI Speech Synthesis (`POST /v1/audio/speech` & `POST /audio/speech`)
```bash
curl -X POST http://localhost:8095/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{
    "model": "omnivoice-tts",
    "voice": "morgan-freeman",
    "input": "Well, [confirmation-en] I suppose that is true, [sigh] but who would have thought? [question-en]",
    "response_format": "ogg"
  }' \
  --output speech.ogg
```

### 2. Custom Voice Registration Endpoint (`POST /v1/voices`)
```bash
curl -X POST http://localhost:8095/v1/voices \
  -F "file=@/path/to/speaker_audio.mp3" \
  -F "voice_id=custom-speaker"
```

### 3. Speech-to-Text Endpoint (`POST /v1/audio/transcriptions`)
```bash
curl -X POST http://localhost:8095/v1/audio/transcriptions \
  -F "file=@/path/to/speech_sample.wav"
```

### 4. Voice Discovery (`GET /v1/voices`, `GET /v1/audio/voices`, `GET /voices`)
```bash
curl http://localhost:8095/v1/voices
```

### 5. Capabilities Manifest (`GET /v1/capabilities`)
```bash
curl http://localhost:8095/v1/capabilities
```

### 6. OpenAI Model List (`GET /v1/models`)
```bash
curl http://localhost:8095/v1/models
```

---

## 📄 License
MIT License
