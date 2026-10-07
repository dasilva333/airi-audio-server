@echo off
setlocal enabledelayedexpansion
title AIRI Audio Server - Automated Installer
cd /d "%~dp0"

echo ============================================================
echo      AIRI Audio Server - Automated 1-Click Installer
echo ============================================================
echo:

echo [1/6] Installing Node.js dependencies...
call npm install
echo:

echo [2/6] Verifying FFmpeg installation...
where ffmpeg >nul 2>nul
if %errorlevel% neq 0 (
    echo [NOTICE] FFmpeg not found in PATH. Attempting automatic install via winget...
    winget install ffmpeg --accept-source-agreements --accept-package-agreements
) else (
    echo FFmpeg binary verified in PATH.
)
echo:

echo [3/6] Ensuring the audio.cpp C++ engine source tree...
if not exist "..\audio.cpp\CMakeLists.txt" (
    echo Cloning official audio.cpp repository...
    git clone --depth 1 https://github.com/0xShug0/audio.cpp ..\audio.cpp
) else (
    echo audio.cpp repository detected.
)
echo:

echo [4/6] Building the audio.cpp engine for the detected GPU backend...
set "BUILD_BACKEND=%AIRI_BUILD_BACKEND%"
if "%BUILD_BACKEND%"=="" (
    for /f "delims=" %%B in ('node "tools\detect-backend.js"') do set "BUILD_BACKEND=%%B"
)
echo      Selected backend: %BUILD_BACKEND%
node "tools\build-audio-cpp.js" %BUILD_BACKEND%
if errorlevel 1 (
    echo:
    echo [WARNING] The native build did not complete. Missing prerequisites were listed above.
    echo           AMD / Vulkan : install the LunarG Vulkan SDK, then run: npm run build:vulkan
    echo           NVIDIA / CUDA: install the CUDA Toolkit,   then run: npm run build:cuda
    echo           Bundled CUDA binaries in bin\windows-cuda\ stay usable on NVIDIA GPUs.
)
echo:

echo [5/6] Launching Interactive Setup Wizard (Citrinet ASR + TTS models)...
node setup.js
echo:

echo ============================================================
echo [6/6] Optional Add-ons
echo ============================================================
echo Would you like to install Generative Music Models (YuE 2 / MiniMax)?
set /p INSTALL_MUSIC="Install Generative Music Models now? (y/N): "
if /i "%INSTALL_MUSIC%"=="y" node download_music.js

echo:
echo Would you like to install MOSS-VoiceGenerator for creating voices
echo from natural text descriptions without audio samples?
set /p INSTALL_VOICEGEN="Install MOSS-VoiceGenerator now? (y/N): "
if /i "%INSTALL_VOICEGEN%"=="y" node download_voicegen.js

echo:
echo Would you like to install Stable Audio 3 Small SFX for sound effects
echo and UI foley (8 diffusion steps)?
set /p INSTALL_SFX="Install Stable Audio 3 Small SFX now? (y/N): "
if /i "%INSTALL_SFX%"=="y" node download_sfx.js

echo:
echo ============================================================
echo      GPU / backend diagnostics
echo ============================================================
node "tools\gpu-info.js"

echo:
echo ============================================================
echo      AIRI Audio Server Installation Complete!
echo ============================================================
echo Run 'npm start' or 'audio_ctl.bat start' to launch the microservice.
pause
