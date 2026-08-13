# AIRI Audio Server 🎙️🚀

> **High-Performance, Zero-Python Node.js & C++ Audio Microservice for AIRI**

`airi-audio-server` is a lightweight, zero-Python Node.js microservice designed to serve C++ audio inference (`audio.cpp` C++ engine) with **OpenAI API compatibility**, **SSE Incremental Audio Streaming**, **Native Parakeet TDT ASR**, **Voice Discovery & Batch Transcription**, and **Unified GPU Task Queueing**.

---

## ⚡ Core Features & Architectural Innovations

1. **Incremental Audio Streaming over SSE (`stream_format: "sse"`)**:
   - `POST /v1/audio/speech` supports Server-Sent Events (SSE) streaming without requiring text splitting.
   - Emits base64-encoded, self-contained 44-byte WAV chunks (`pcmToWav`) in real time, dropping Time-To-First-Token (TTFT) to ~230ms while preserving 100% natural utterance prosody.
2. **Native Parakeet TDT ASR (`src/stt.js` & `tools/transcribe-voices.js`)**:
   - Runs `audiocpp_cli` with `Parakeet-TDT-0.6B-v3` on CUDA GPU for Speech-to-Text reference transcription and unloads immediately, keeping VRAM free for TTS synthesis.
   - Includes automatic FFmpeg normalization (WebM/Opus/MP3 -> 16kHz PCM WAV).
   - Batch voice transcript utility: `npm run transcribe-voices` rebuilds high-accuracy reference transcripts for all cloned voices to ensure peak zero-shot voice cloning fidelity.
3. **Zero-Compilation Out-Of-The-Box Execution**:
   - Ships with pre-compiled CUDA release binaries bundled in `bin/windows-cuda/`.
   - If a local `audio.cpp` build is not found, `engine.js` automatically falls back to the bundled C++ server binary.
4. **1-Click Verified Model Auto-Downloader**:
   - `setup.js` / `install.bat` automatically fetches 100% verified `.gguf` model weights (both TTS models and Parakeet TDT ASR) directly from HuggingFace with live progress tracking.
5. **Robust Child Process Hot-Swapping & Safety**:
   - Detaches all event handlers before killing terminating instances and explicitly awaits process exit before spawning replacements (`waitForExit`), preventing port 8080 collisions and race conditions during model/voice switches.
6. **Configurable Idle Keepalive Warmer**:
   - Optional lightweight ping to mitigate GPU power-state / CUDA paging cold-start delays.
   - **Default set to `0` (disabled)** so no background inferences run or compete when ComfyUI or other workloads run in parallel.
7. **Zero File Deletion Policy & Automatic Archiving**:
   - Voice reference files are **never deleted**. Replaced or updated voice files are automatically preserved with timestamped backups in `voices/archive/`.
8. **Shared Ingestion & Short Audio Normalization (`src/voices.js` & `src/ffmpeg.js`)**:
   - Converts uploaded audio clips to 24kHz mono PCM WAV via FFmpeg safely (handling in-place normalization).
   - Self-concatenates reference clips shorter than 1.5s to 3–5 seconds so zero-shot voice cloning never fails.
9. **Unified Serialized GPU Queue (`src/queue.js`)**: Single FIFO queue for all GPU tasks (TTS synthesis, STT transcriptions, voice registrations), preventing VRAM collisions.
10. **Real-Time Factor (RTF) Metrics & Headers**: Computes exact latency, audio duration, RTF, and real-time speed, returning them in custom HTTP headers (`X-Real-Time-Factor`, `X-Realtime-Speed`, `X-Synthesis-Latency-Ms`, `X-Audio-Duration-Sec`).

---

## 🎙️ Official Supported TTS Models & 1-Click Auto-Downloader

AIRI Audio Server natively supports the following 5 core TTS models with **1-click automatic downloading**:

| # | Model Name | VRAM | Key Features | HuggingFace GGUF Link |
| :---: | :--- | :---: | :--- | :--- |
| **1** | **OmniVoice Q8_0** *(Recommended)* | ~1.12 GB | Zero-Shot Voice Cloning, Paralinguistic Expression Tags, 0.28 RTF | [`audio-cpp-gguf/OmniVoice-GGUF`](https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/main/OmniVoice-GGUF/omnivoice-q8_0.gguf) |
| **2** | **Higgs Audio v3 TTS Q8_0** | ~4.80 GB | 46 Native Paralinguistic Tags (`<|emotion:...|>`), Zero-Shot Voice Cloning, SSE Streaming | [`audio-cpp-gguf/Higgs-Audio-v3-TTS-4B-GGUF`](https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/main/Higgs-Audio-v3-TTS-4B-GGUF/higgs-audio-v3-tts-4b-q8_0.gguf) |
| **3** | **Fish Audio S2 Pro Q8_0** | ~6.31 GB | Dual-AR Fast Streaming Synthesis, Zero-Shot Voice Cloning, 1.25 RTF | [`audio-cpp-gguf/Fish-Audio-S2-Pro-GGUF`](https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/main/Fish-Audio-S2-Pro-GGUF/fish-audio-s2-pro-q8_0.gguf) |
| **4** | **Chatterbox TTS Q8_0** | ~2.10 GB | High-Fidelity Expressive Speech Synthesis | [`audio-cpp-gguf/Chatterbox-GGUF`](https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/main/Chatterbox-GGUF/chatterbox-q8_0.gguf) |
| **5** | **MOSS TTS Local v1.5 Q8_0** | ~7.50 GB | Large Scale Multilingual Neural Speech Model | [`audio-cpp-gguf/MOSS-TTS-Local-v1.5-GGUF`](https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/main/MOSS-TTS-Local-v1.5-GGUF/moss-tts-local-v1.5-q8_0.gguf) |

---

## 🚀 1-Click Automated Setup

Double-click `install.bat` on Windows! The installer automatically:
1. Installs Node.js dependencies (`npm install`).
2. Verifies FFmpeg in system PATH (or offers automatic installation via `winget`).
3. Clones the official `audio.cpp` C++ engine repository if missing (`git clone https://github.com/0xShug0/audio.cpp`).
4. Verifies/compiles CUDA release binaries (`audiocpp_server.exe` and `audiocpp_cli.exe` via `cmake -DGGML_CUDA=ON`).
5. Launches the interactive model setup wizard (`node setup.js`), which auto-downloads Parakeet TDT ASR weights and your chosen TTS model!

```cmd
install.bat
```

---

## 🛠️ Configuration Guide (`config.json`)

All configuration parameters are fully exposed and customizable in `config.json`:

```json
{
  "port": 8095,
  "host": "0.0.0.0",
  "audio_cpp": {
    "server_exe": "../audio.cpp/build/windows-cuda-release/bin/audiocpp_server.exe",
    "working_dir": "../audio.cpp",
    "internal_port": 8080,
    "stream_frame_interval": 25,
    "keep_alive_interval_ms": 0
  },
  "asr": {
    "cli_exe": "../audio.cpp/build/windows-cuda-release/bin/audiocpp_cli.exe",
    "model_path": "../audio.cpp/models/Parakeet-TDT-0.6B-v3-GGUF/parakeet-tdt-0.6b-v3-q8_0.gguf",
    "family": "parakeet_tdt",
    "backend": "cuda"
  },
  "chatterbox_voices_dir": "../chatterbox/voices",
  "installed_models": [
    "higgs-audio-tts",
    "omnivoice-tts"
  ],
  "models": {
    "omnivoice-tts": {
      "family": "omnivoice",
      "path": "../audio.cpp/models/OmniVoice-GGUF/omnivoice-q8_0.gguf",
      "allow_unfiltered_tags": true
    },
    "fish-audio-tts": {
      "family": "fish_audio",
      "path": "../audio.cpp/models/Fish-Audio-S2-Pro-GGUF/fish-audio-s2-pro-q8_0.gguf",
      "allow_unfiltered_tags": true
    },
    "higgs-audio-tts": {
      "family": "higgs_audio_tts",
      "path": "../audio.cpp/models/Higgs-GGUF/higgs-audio-v3-tts-4b-q8_0.gguf",
      "allow_unfiltered_tags": true
    }
  }
}
```

---

## 🚀 Server Commands

### Start Server
```cmd
npm start
```
Starts `airi-audio-server` on `http://localhost:8095`.

### Run Model Setup Wizard
```cmd
npm run setup
```
*(or `npm run add-model`)*

### Batch Transcribe Reference Voices
```cmd
npm run transcribe-voices
```
*(Rebuilds accurate reference transcripts for all clips in `voices/` via Parakeet TDT ASR)*

---

## 📡 API Endpoints

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/health` | GET | Server health check probe. |
| `/v1/models` | GET | List installed TTS & ASR models (OpenAI compatible). |
| `/v1/voices` | GET | Discovered voice presets & custom cloned voices (`{ voices: [...] }`). |
| `/v1/capabilities` | GET | Supported paralinguistic expression tags manifest. |
| `/v1/audio/speech` | POST | Synthesize speech. Supports standard binary (OGG/WAV) or SSE streaming (`stream_format: "sse"`). |
| `/v1/audio/transcriptions` | POST | Transcribe audio files via native GPU Parakeet TDT ASR. |

---

## 📄 License
MIT License. Developed for AIRI.
