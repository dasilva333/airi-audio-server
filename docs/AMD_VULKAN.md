# AMD Radeon (Vulkan) Setup Guide

This guide covers running `airi-audio-server` on an AMD Radeon GPU (e.g. **Radeon RX 9070 XT**, RDNA4) with no NVIDIA/CUDA dependency, using the Vulkan backend of `audio.cpp`.

Target pipeline:

```
AIRI -> airi-audio-server -> audiocpp_server -> Vulkan -> AMD GPU
```

The NVIDIA/CUDA path is unaffected: `airi-audio-server` keeps working with the bundled CUDA binaries when an NVIDIA GPU is present.

---

## 1. How backend selection works

The backend is chosen from (highest priority first):

1. Environment variable `AIRI_GPU_BACKEND` (`cuda` | `vulkan` | `cpu`).
2. `config.json` -> `gpu.backend`.
3. `auto` (the default).

`auto` means:

- NVIDIA GPU detected via `nvidia-smi` -> **cuda**
- otherwise a Vulkan-capable adapter detected -> **vulkan**
- otherwise -> **hard error** (the server refuses to start; it never silently falls back to CPU)

The device index comes from `AIRI_GPU_DEVICE` or `gpu.device` (default `0`).

```json
"gpu": {
  "backend": "auto",
  "device": 0,
  "vulkan_sdk_path": ""
}
```

`vulkan_sdk_path` is optional — the SDK is auto-discovered from `VULKAN_SDK` or `C:\VulkanSDK\<version>`.

## 2. Prerequisites to build the Vulkan binary

| Requirement | Purpose | Install |
| :--- | :--- | :--- |
| Visual Studio Build Tools 2022 (C++ desktop workload, MSVC x64) | compiler | `winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"` |
| CMake | build system | `winget install Kitware.CMake` |
| Ninja | generator | `winget install Ninja-build.Ninja` |
| LunarG Vulkan SDK (**includes `glslc`**) | Vulkan backend + shader compiler | `winget install KhronosGroup.VulkanSDK` |
| Git | clone audio.cpp | `winget install Git.Git` |

> After installing the Vulkan SDK, open a **new terminal** so that `VULKAN_SDK` is visible, or set `gpu.vulkan_sdk_path` in `config.json`.

Runtime note: the Vulkan loader (`vulkan-1.dll`) ships with the AMD graphics driver, so nothing extra is needed at runtime.

## 3. Build

One-shot (recommended):

```cmd
install-vulkan.bat
```

It forces `AIRI_GPU_BACKEND=vulkan`, checks prerequisites, clones `../audio.cpp` if needed, builds `audiocpp_server` + `audiocpp_cli` with the `windows-vulkan-release` preset, runs the model setup wizard and prints diagnostics.

Manual build:

```cmd
cd ..\audio.cpp
scripts\build_windows.ps1 -Preset windows-vulkan-release -Target audiocpp_server
scripts\build_windows.ps1 -Preset windows-vulkan-release -Target audiocpp_cli
```

or via the project helper:

```cmd
npm run build:vulkan
```

The helper prints exactly what is missing instead of failing inside CMake.

## 4. Where binaries are searched

For the resolved backend, `resolveEngineBinary` looks in order:

1. the configured `audio_cpp.server_exe` / `asr.cli_exe`, if it exists and matches the backend;
2. `bin/windows-vulkan/` (bundled override slot);
3. `<working_dir>/build/windows-vulkan-release/bin/`;
4. `../audio.cpp/build/windows-vulkan-release/bin/`.

A Vulkan request never returns a CUDA binary.

## 5. Run

```cmd
npm start
```

The generated `server.json` contains `"backend": "vulkan"`, and `run_server.bat` passes `--backend vulkan` explicitly. The engine prints the requested backend, device index and the GPU device name reported by `audio.cpp`.

## 6. Verify it really runs on the GPU

```cmd
npm run gpu-info
```

Expected for an RX 9070 XT:

```
Resolved backend    : vulkan
Reason              : auto: no NVIDIA GPU; Vulkan-capable adapter detected (AMD Radeon RX 9070 XT)
audiocpp_server     : ...\build\windows-vulkan-release\bin\audiocpp_server.exe [OK]
Vulkan SDK          : C:\VulkanSDK\<version>
glslc available     : yes
```

While the server is running, `gpu-info` also queries `/health`:

```
backend             : vulkan
gpu_device          : AMD Radeon RX 9070 XT
cpu_fallback        : false
```

Heartbeat check with a real synthesis:

```cmd
npm run test:synthesis
```

This synthesizes through `/v1/audio/speech` and reports the Real-Time Factor (RTF).

## 7. Troubleshooting

- **`VULKAN_SDK` not set** — reopen the terminal after installing the SDK, or set `gpu.vulkan_sdk_path`.
- **`glslc` not found** — the Vulkan SDK install is incomplete; reinstall it (glslc is required to compile shaders).
- **`audiocpp_server executable not found for backend 'vulkan'`** — the Vulkan build did not finish. Run `npm run build:vulkan` and read its prerequisite report.
- **`Could not determine an inference backend`** — neither NVIDIA nor a Vulkan adapter was detected. Set `gpu.backend` explicitly (`vulkan` or `cpu`).
- **Model coverage** — audio.cpp documents that CUDA is its most optimized path; some model families may be less complete on Vulkan. If a specific model fails on Vulkan, try another family and report it rather than assuming CPU.

## 8. CPU backend (explicit only)

To intentionally run on CPU (slower), build with `npm run build:cpu` and set:

```cmd
set AIRI_GPU_BACKEND=cpu
npm start
```

This is never selected automatically.
