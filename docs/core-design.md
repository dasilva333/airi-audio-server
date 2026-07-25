# AIRI Audio Server (`airi-audio-server`) - Core Architecture & Design Manifest

## 1. Scope & Core Architectural Principles

**AIRI Audio Server** (`airi-audio-server`) is a zero-Python, ultra-fast C++/Node.js audio microservice providing OpenAI-compatible Text-to-Speech (TTS), Speech-to-Text (STT), and voice management endpoints specifically engineered for AIRI.

---

## 2. Invariants & System Capabilities

### 1. Unified Serialized GPU Job Queue & VRAM Management
* **Single FIFO Job Queue for All Operations**: ALL GPU operations (TTS synthesis requests, STT Whisper transcriptions, and JIT voice registrations) pass through a single, unified FIFO job queue.
* **Zero GPU Contention**: STT and TTS jobs never execute concurrently.
* **On-Demand GPU Whisper**: `whisper.cpp` runs on CUDA GPU for maximum speed, but is loaded on-demand and **unloaded from VRAM immediately after transcription completion** to keep 100% of VRAM available for TTS models.

### 2. Shared Voice Ingestion Pipeline & Audio Normalization
* **Unified Ingestion Function (`ingestVoiceAudio`)**: A single shared pipeline consumed by both `POST /v1/voices` and `POST /v1/audio/speech` (when a voice file lacks a sidecar transcript).
* **Short Audio Self-Concatenation**: If reference audio is too short (< 1.5s), the ingestion pipeline automatically merges/concatenates the audio file onto itself via `ffmpeg` until it reaches optimal length (3.0s–5.0s) so it passes zero-shot model cloning requirements cleanly.
* **Automatic Whisper Sidecar**: Auto-transcribes via GPU `whisper.cpp`, writes `<voice_id>.txt`, and registers the transcript into `voices/voice_vocabulary.json`.

### 3. Default Return Format: Opus OGG (`audio/ogg`)
* Matches legacy Chatterbox behavior: Audio responses default to **Opus OGG (`audio/ogg`)** for seamless compatibility across Telegram, Discord, and AIRI clients.
* Uses an in-memory `ffmpeg` stdio pipeline to transcode `audio.cpp` PCM WAV buffers directly to OGG in RAM without disk I/O latency.

### 4. Paralinguistic Tag Bridge & Bypass Guard
* **`supported_tags.csv` Catalog**: Serves as the central, token-efficient source of truth for paralinguistic expression tags.
* **Tag Bypass Guard Flag (`allow_unfiltered_tags`)**: Models with massive token vocabularies (e.g. Fish Audio S2, Higgs Audio with 15K+ tags) can set `"allow_unfiltered_tags": true` to bypass tag filtering.

### 5. Non-Spoken Text & Emojis (`204 No Content`)
* Prompts containing only emojis, punctuation, or non-pronounceable characters return `204 No Content` instantly, avoiding unnecessary GPU inference calls.

### 6. Zero-Stream Policy (`stream: true` Not Supported)
* Matches legacy server behavior: Requests return complete, un-streamed audio buffers. Streaming (`stream: true`) is explicitly disabled.

---

## 3. User Setup & Model Management Flow

```
 ┌──────────────────────┐      ┌─────────────────────────────┐      ┌──────────────────────────────────┐
 │  Double-Click        │      │ Interactive Model Setup     │      │ Auto-Download & Register         │
 │  install.bat         ├─────►│ Menu (Select 1-9)           ├─────►│ - Download GGUF & Sidecars       │
 │  (or npm run setup)  │      │ - OmniVoice Q8_0 (Default)  │      │ - Register in config.json        │
 └──────────────────────┘      │ - Fish Audio S2 Pro Q8_0    │      │ - Launch airi-audio-server       │
                               └─────────────────────────────┘      └──────────────────────────────────┘
```

### A. One-Click Setup Script (`install.bat` / `npm run setup`)
1. Runs `npm install` for Node.js API dependencies.
2. Checks/validates `audio.cpp` and `whisper.cpp` C++ binaries.
3. Launches an interactive CLI setup wizard (`setup.js`):
   - Displays a numbered list (1 to 9) of supported models with VRAM requirements & features.
   - User inputs their choice (e.g. `1` for OmniVoice Q8_0).
   - Automatically downloads GGUF weights and sidecar JSON files, then registers the model in `config.json`.

### B. CLI Model Management Wrappers (`npm run add-model`)
- **`npm run add-model <model-id>`**: Download and register a model (e.g. `npm run add-model omnivoice`).
- **`npm run list-models`**: Displays installed vs available models.
- **`npm run remove-model <model-id>`**: Safely removes GGUF weights and updates configuration.

---

## 4. Complete API Endpoints Specification

### A. Speech Synthesis Endpoint (`POST /v1/audio/speech` & `POST /audio/speech`)
```json
{
  "model": "omnivoice-tts",
  "input": "Hello world",
  "voice": "morgan-freeman",
  "speed": 1.0,
  "allow_unfiltered_tags": false
}
```
* **Response Header**: `Content-Type: audio/ogg` (default) or `audio/wav` / `audio/mpeg`.

### B. Voice Discovery & Registration Endpoints
- `GET /v1/voices`, `GET /v1/audio/voices`, `GET /voices`: Returns list of voices.
- `POST /v1/voices`, `POST /v1/audio/voices`: Registers new custom voice with shared `ingestVoiceAudio` pipeline.

### C. Model Listing Endpoint (`GET /v1/models`)
```json
{
  "object": "list",
  "data": [
    {
      "id": "omnivoice-tts",
      "object": "model",
      "created": 1700000000,
      "owned_by": "airi"
    }
  ]
}
```

### D. Capabilities Endpoints (`GET /v1/capabilities` & `GET /chatterbox/capabilities`)
Returns available voices, active model modes, supported expression tags, and supported audio formats.

### E. Speech-to-Text Endpoint (`POST /v1/audio/transcriptions`)
Accepts `multipart/form-data` audio file and returns `{"text": "Transcribed text output..."}` via GPU `whisper.cpp`.
