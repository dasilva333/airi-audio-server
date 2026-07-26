# AIRI Audio Server 🎙️🚀

> **High-Performance, Zero-Python Node.js & C++ Audio Microservice for AIRI**

`airi-audio-server` is a lightweight, zero-Python Node.js microservice designed to serve C++ audio inference (`audio.cpp` and `whisper.cpp`) with full **OpenAI API compatibility**, **Voice Discovery**, **Paralinguistic Expression Tag Filtering**, and **Unified GPU Task Queueing**.

---

## ⚡ 1-Click Automated Setup

Double-click `install.bat` on Windows! The installer automatically:
1. Installs Node.js dependencies (`npm install`).
2. Clones the `audio.cpp` C++ engine repository if missing (`git clone`).
3. Compiles the CUDA release binaries (`cmake -DGGML_CUDA=ON`).
4. Launches the interactive model configuration wizard (`node setup.js`).

```cmd
install.bat
```

---

## 📦 Directory Architecture

By default, `install.bat` arranges `audio.cpp` in a sibling directory layout:
```text
/your-parent-folder/
├── airi-audio-server/
└── audio.cpp/
    ├── build/windows-cuda-release/bin/audiocpp_server.exe
    └── models/
        └── OmniVoice-GGUF/omnivoice-q8_0.gguf
```

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

## 🚀 Server Commands

### Start Server
```cmd
npm start
```
Starts `airi-audio-server` on `http://localhost:8095`.

### Run Verification Test
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
