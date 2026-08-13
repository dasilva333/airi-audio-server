# Changelog

All notable changes to `airi-audio-server` are documented in this file.

---

## [1.1.0] - 2026-08-13

### 🚀 Highlights
- **Sub-Second Streaming TTS (~230ms TTFT)**: Integrated Server-Sent Events (SSE) incremental delivery for `audio.cpp` speech generation, bypassing upstream text splitting to preserve continuous sentence prosody.
- **Native Parakeet TDT ASR (Zero Python)**: Completely replaced the Python Whisper pipeline with `audio.cpp`'s native CUDA-accelerated `audiocpp_cli` running `parakeet_tdt`.
- **Process Safety & Hot-Swap Improvements**: Eliminated port-binding race conditions and state corruption during model and voice switching.

---

### ✨ Features & Enhancements

- **SSE Streaming Support (`POST /v1/audio/speech`)**:
  - Added support for `stream_format: "sse"` in request payloads.
  - Implemented `pcmToWav()` in `src/routes.js` to wrap raw PCM frames in standalone 44-byte WAV headers, allowing client-side `decodeAudioData` without MediaSource Extensions.
  - Implemented `engine.synthesizeStream()` in `src/engine.js` to parse newline-delimited SSE chunks from `audio.cpp` and stream them as `speech.audio.delta` events.
  - Added detailed timing metrics (`ttft_ms`, `total_ms`, and realtime multipliers) emitted in `speech.audio.done` and server logs.

- **Parakeet TDT ASR Integration**:
  - Replaced legacy Python/HuggingFace script in `src/stt.js` with `audiocpp_cli` executing `--task asr --family parakeet_tdt`.
  - Added FFmpeg pre-normalization (`normalizeAudioToWav`) for STT uploads so WebM, Opus, MP3, and other compressed browser recordings transcribe accurately without silent failures.
  - Updated `setup.js` to verify and auto-download `parakeet-tdt-0.6b-v3-q8_0.gguf` weights directly from HuggingFace.
  - Updated `install.bat` to verify and compile both `audiocpp_server.exe` and `audiocpp_cli.exe`.

- **Batch Voice Transcription Tool (`tools/transcribe-voices.js`)**:
  - Added `npm run transcribe-voices` to re-transcribe reference audio files in `voices/` and populate accurate `.txt` sidecars and `voice_vocabulary.json`.
  - Preserves known-good transcripts and prevents empty ASR results from overwriting valid transcripts.

- **Child Process Lifecycle & Hot-Swap Safety**:
  - Added `waitForExit()` to ensure terminating `audiocpp_server` processes release port 8080 before spawning replacement instances.
  - Detaches event listeners (`stdout`, `stderr`, `exit`) before terminating child processes so late async callbacks cannot wipe state on the active engine.

- **Configurable Idle Keepalive Warmer**:
  - Added `startKeepAlive()` / `stopKeepAlive()` to combat GPU power-state / CUDA memory paging cold starts.
  - Configured with `keep_alive_interval_ms: 0` (disabled by default) in `config.json` to prevent background inferences from colliding with parallel GPU workloads (e.g. ComfyUI).

- **OpenAI & AIRI Client Compatibility**:
  - `GET /v1/models` now advertises the ASR model in addition to TTS models.
  - `GET /v1/voices` wraps the voice array as `{ voices: [...] }` to align with AIRI chatterbox provider expectations.
  - Fixed voice ingestion archiving order in `src/voices.js` so source files are normalized before being moved to archive.

---

## [1.0.0] - Initial Release
- Initial release of `airi-audio-server` supporting `audio.cpp` and `whisper.cpp` with OpenAI-compatible API, Unified GPU Queue, and model management.
