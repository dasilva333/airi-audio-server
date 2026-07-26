# AIRI Audio Server 🎙️🚀

> **High-Performance, Zero-Python Node.js & C++ Audio Microservice for AIRI**

`airi-audio-server` is a lightweight, zero-Python Node.js microservice designed to serve C++ audio inference (`audio.cpp` and `whisper.cpp`) with full **OpenAI API compatibility**, **Voice Discovery**, **Paralinguistic Expression Tag Filtering**, and **Unified GPU Task Queueing**.

---

## ⚡ Core Features & Architectural Innovations

1. **Zero-Compilation Out-Of-The-Box Execution**:
   - Ships with pre-compiled CUDA release binaries bundled in `bin/windows-cuda/`.
   - If a local `audio.cpp` build is not found, `engine.js` automatically falls back to the bundled C++ server binary, requiring **zero C++/CMake compilation steps** for new users!
2. **1-Click Verified Model Auto-Downloader**:
   - `setup.js` / `install.bat` automatically fetches 100% verified `.gguf` model weights directly from the official [`audio-cpp/audio.cpp-gguf`](https://huggingface.co/audio-cpp/audio.cpp-gguf) HuggingFace repository with live progress tracking.
3. **28 Official Bundled Reference Voices**: Ships with 28 official reference voice files (`morgan-freeman`, `snoop-dogg`, `trump-2`, `rick_sanchez`, `egirl`, `lain`, `fiona_irish`, etc.) ready for immediate zero-shot cloning.
4. **Zero File Deletion Policy & Automatic Archiving**:
   - Voice reference files are **never deleted**. Replaced or updated voice files are automatically preserved with timestamped backups in `voices/archive/`.
5. **Unified Serialized GPU Queue (`src/queue.js`)**: Single FIFO queue for all GPU tasks (TTS synthesis, STT transcriptions, voice registrations), preventing VRAM collisions and CUDA context corruption.
6. **On-Demand GPU Whisper (`src/stt.js`)**: Runs `whisper.cpp` on CUDA GPU for Speech-to-Text reference transcription and unloads immediately, keeping 100% VRAM free for TTS synthesis.
7. **Shared Ingestion & Short Audio Normalization (`src/voices.js` & `src/ffmpeg.js`)**:
   - Converts uploaded audio clips to 24kHz mono PCM WAV via FFmpeg safely (including in-place normalization handling).
   - Self-concatenates reference clips shorter than 1.5s to 3–5 seconds so zero-shot voice cloning never fails.
8. **Real-Time Factor (RTF) Metrics & Headers**: Computes exact latency, audio duration, RTF, and real-time speed, returning them in custom HTTP headers (`X-Real-Time-Factor`, `X-Realtime-Speed`, `X-Synthesis-Latency-Ms`, `X-Audio-Duration-Sec`).
9. **Model-Scoped Tag Filtering (`supported_tags.csv` & `src/text.js`)**: Supports comma-delimited model mapping and dual bracket parsing (`<|tag|>` and `[tag]`) to filter tags strictly per model family.

---

## 🎙️ Official Supported TTS Models & 1-Click Auto-Downloader

AIRI Audio Server natively supports the following 5 core TTS models with **1-click automatic downloading**:

| # | Model Name | VRAM | Key Features | HuggingFace GGUF Link |
| :---: | :--- | :---: | :--- | :--- |
| **1** | **OmniVoice Q8_0** *(Recommended)* | ~1.12 GB | Zero-Shot Voice Cloning, Paralinguistic Expression Tags, 0.28 RTF | [`audio-cpp-gguf/OmniVoice-GGUF`](https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/main/OmniVoice-GGUF/omnivoice-q8_0.gguf) |
| **2** | **Higgs Audio v3 TTS Q8_0** | ~4.80 GB | 46 Native Paralinguistic Tags (`<|emotion:...|>`), Zero-Shot Voice Cloning | [`audio-cpp-gguf/Higgs-Audio-v3-TTS-4B-GGUF`](https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/main/Higgs-Audio-v3-TTS-4B-GGUF/higgs-audio-v3-tts-4b-q8_0.gguf) |
| **3** | **Fish Audio S2 Pro Q8_0** | ~6.31 GB | Dual-AR Fast Streaming Synthesis, Zero-Shot Voice Cloning | [`audio-cpp-gguf/Fish-Audio-S2-Pro-GGUF`](https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/main/Fish-Audio-S2-Pro-GGUF/fish-audio-s2-pro-q8_0.gguf) |
| **4** | **Chatterbox TTS Q8_0** | ~2.10 GB | High-Fidelity Expressive Speech Synthesis | [`audio-cpp-gguf/Chatterbox-GGUF`](https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/main/Chatterbox-GGUF/chatterbox-q8_0.gguf) |
| **5** | **MOSS TTS Local v1.5 Q8_0** | ~7.50 GB | Large Scale Multilingual Neural Speech Model | [`audio-cpp-gguf/MOSS-TTS-Local-v1.5-GGUF`](https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/main/MOSS-TTS-Local-v1.5-GGUF/moss-tts-local-v1.5-q8_0.gguf) |

> 🌐 **Looking for additional or less common models?**
> You can find 30+ specialized models (e.g. `PocketTTS`, `MioTTS`, `VibeVoice`, `Supertonic`, `SeedVC`, `Sortformer`) in the official **[`audio-cpp/audio.cpp-gguf`](https://huggingface.co/audio-cpp/audio.cpp-gguf/tree/main)** HuggingFace repository and manually place their `.gguf` weights in `audio.cpp/models/<Model-Name>/`.

---

## 🚀 1-Click Automated Setup

Double-click `install.bat` on Windows! The installer automatically:
1. Installs Node.js dependencies (`npm install`).
2. Verifies FFmpeg in system PATH (or offers automatic installation via `winget`).
3. Clones the official `audio.cpp` C++ engine repository if missing (`git clone https://github.com/0xShug0/audio.cpp`).
4. Verifies/compiles CUDA release binaries (`cmake -DGGML_CUDA=ON`).
5. Launches the interactive model setup wizard (`node setup.js`), which auto-downloads your selected GGUF model weights!

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
  "installed_models": ["omnivoice-tts", "higgs-audio-tts", "fish-audio-tts"],
  "models": {
    "omnivoice-tts": {
      "family": "omnivoice",
      "path": "../audio.cpp/models/OmniVoice-GGUF/omnivoice-q8_0.gguf",
      "allow_unfiltered_tags": false
    },
    "higgs-audio-tts": {
      "family": "higgs_audio_tts",
      "path": "../audio.cpp/models/Higgs-GGUF/higgs-audio-v3-tts-4b-q8_0.gguf",
      "allow_unfiltered_tags": true
    },
    "fish-audio-tts": {
      "family": "fish_audio",
      "path": "../audio.cpp/models/Fish-Audio-S2-Pro-GGUF/fish-audio-s2-pro-q8_0.gguf",
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
| **Higgs Audio v3** | `higgs_audio` / `higgs_audio_tts` | 46 Emotion, SFX, Style, Prosody & Noise tags (`<|tag|>`). |
| **Fish Audio S2 Pro**| `fish_audio` | Full 15K tag bypass enabled (`allow_unfiltered_tags: true`). |
| **Chatterbox** | `chatterbox` | Spoken laughter, coughs, sighs, gasps. |
| **MOSS TTS** | `moss_tts` | Multilingual expression and emotion tags. |

---

## 📄 License
MIT License. Developed for AIRI.
