# AIRI Audio Server 🎙️🚀

> **High-Performance, Zero-Python Node.js & C++ Audio Microservice for AIRI**

`airi-audio-server` is a lightweight, zero-Python Node.js microservice designed to serve C++ audio inference (`audio.cpp` and `whisper.cpp`) with full **OpenAI API compatibility**, **Voice Discovery**, **Paralinguistic Expression Tag Filtering**, and **Unified GPU Task Queueing**.

---

## 📦 Prerequisites & Requirements

`airi-audio-server` is the Node.js API layer that connects to the high-performance C++ `audio.cpp` inference engine. To run speech synthesis, you need the compiled `audiocpp_server.exe` C++ executable and model weight `.gguf` files.

### Option A: Standard Sibling Directory Layout (Default)
Place `audio.cpp` in a sibling folder alongside `airi-audio-server`:
```text
/your-parent-folder/
├── airi-audio-server/
└── audio.cpp/
    ├── build/windows-cuda-release/bin/audiocpp_server.exe
    └── models/
        └── OmniVoice-GGUF/omnivoice-q8_0.gguf
```

### Option B: Custom Existing `audio.cpp` Installation
If `audio.cpp` is located in another folder on your computer (e.g. `C:\Tools\audio.cpp`), simply update `config.json` or run `install.bat` / `node setup.js` — the wizard will prompt you to enter your custom folder path!

---

## ⚡ Core Features

1. **Zero Python Overhead**: Runs pure compiled C++ binaries (`audiocpp_server.exe` and `whisper_cli.exe`) bound to CUDA GPU.
2. **Unified Serialized GPU Queue (`src/queue.js`)**: Single FIFO queue for all GPU tasks (TTS synthesis, STT transcriptions, voice registrations), preventing VRAM collisions and CUDA context corruption.
3. **On-Demand GPU Whisper (`src/stt.js`)**: Runs `whisper.cpp` on CUDA GPU for Speech-to-Text reference transcription and unloads immediately, keeping 100% VRAM free for TTS synthesis.
4. **Shared Ingestion & Short Audio Normalization (`src/voices.js` & `src/ffmpeg.js`)**:
   - Converts uploaded audio clips to 24kHz mono PCM WAV via FFmpeg.
   - Self-concatenates reference clips shorter than 1.5s to 3–5 seconds so zero-shot voice cloning never fails.
5. **Real-Time Factor (RTF) Metrics & Headers**: Computes exact latency, audio duration, RTF, and real-time speed, returning them in custom HTTP headers (`X-Real-Time-Factor`, `X-Realtime-Speed`, `X-Synthesis-Latency-Ms`, `X-Audio-Duration-Sec`).
6. **Dual Tag Bracket Parsing (`<|tag|>` and `[tag]`)**: Parses model-specific paralinguistic expression tags without leaking tags across model families.

---

## 🛠️ Configuration Guide (`config.json`)

All configuration parameters are fully exposed and customizable in `config.json`:

```json
{
  "port": 8095,
  "host": "0.0.0.0",
  "cuda_path": "C:/Program Files/NVIDIA GPU Computing Toolkit/CUDA/v13.1/bin/x64",
  "audio_cpp": {
    "server_exe": "../audio.cpp/build/windows-cuda-release/bin/audiocpp_server.exe",
    "working_dir": "../audio.cpp",
    "internal_port": 8080
  },
  "whisper_cpp": {
    "cli_exe": "../audio.cpp/build/windows-cuda-release/bin/whisper_cli.exe",
    "model_path": "../audio.cpp/models/whisper-small.bin"
  },
  "chatterbox_voices_dir": "../chatterbox/voices",
  "installed_models": ["omnivoice-tts", "fish-audio-tts"],
  "models": {
    "omnivoice-tts": {
      "family": "omnivoice",
      "path": "../audio.cpp/models/OmniVoice-GGUF/omnivoice-q8_0.gguf",
      "allow_unfiltered_tags": false
    },
    "fish-audio-tts": {
      "family": "fish_audio",
      "path": "../audio.cpp/models/Fish-Audio-S2-Pro-GGUF/fish-audio-s2-pro-q8_0.gguf",
      "allow_unfiltered_tags": true
    }
  }
}
```

### Key Parameters:
- `cuda_path`: Path to CUDA Toolkit `bin/x64` binaries on Windows.
- `audio_cpp.server_exe`: Path to `audiocpp_server.exe`.
- `whisper_cpp.cli_exe`: Path to `whisper_cli.exe`.
- `chatterbox_voices_dir`: Directory containing fallback reference voice WAV files.
- `allow_unfiltered_tags`: Set `true` to allow raw model-specific tags (e.g., Fish Audio 15K tags or Higgs `<|tag|>`) to pass straight through.

---

## 🚀 Quick Start

### 1. Installation & Interactive Setup
Run the interactive setup installer:
```cmd
install.bat
```
*(or run `npm run setup`)*

The installer will automatically verify your `audio.cpp` installation and prompt you for custom folder locations if needed.

### 2. Start the Server
```cmd
npm start
```
The server will start on `http://localhost:8095`.

### 3. Run Verification Test
```cmd
npm test
```
*(or run `node test.js`)*

---

## 📡 API Endpoints

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/health` | GET | Server health check probe. |
| `/v1/models` | GET | List installed TTS models (OpenAI compatible). |
| `/v1/voices` | GET | Discovered voice presets & custom cloned voices. |
| `/v1/capabilities` | GET | Supported paralinguistic expression tags manifest. |
| `/v1/audio/speech` | POST | Synthesize speech to Opus OGG / WAV audio. |
| `/v1/audio/transcriptions` | POST | Transcribe audio files via GPU Whisper.cpp. |

---

## 🏷️ Supported Model Tag Mapping (`supported_tags.csv`)

| Model Family | Code Name (`type`) | Description |
| :--- | :--- | :--- |
| **OmniVoice** | `omni` / `omnivoice` | Native laughter, sighs, English confirmation/question tags. |
| **Chatterbox Full** | `chatterbox` | Spoken laughter, coughs, sighs, gasps. |
| **Chatterbox Turbo**| `chatterbox_turbo` | Spoken laughter, coughs, sighs, gasps. |
| **Higgs Audio** | `higgs_audio` | 46 Emotion, SFX, Style, Prosody & Noise tags (`<|tag|>`). |
| **Fish Audio S2 Pro**| `fish_audio` | Full 15K tag bypass enabled (`allow_unfiltered_tags: true`). |

---

## 📄 License
MIT License. Developed for AIRI.
