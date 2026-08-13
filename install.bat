@echo off
title AIRI Audio Server - Automated 1-Click Installer
cd /d "%~dp0"

echo ============================================================
echo      AIRI Audio Server - Automated 1-Click Installer       
echo ============================================================
echo:

echo [1/5] Installing Node.js dependencies...
call npm install
echo:

echo [2/5] Verifying FFmpeg installation...
where ffmpeg >nul 2>nul
if %errorlevel% neq 0 (
    echo [NOTICE] FFmpeg not found in PATH. Attempting automatic install via winget...
    winget install ffmpeg --accept-source-agreements --accept-package-agreements
) else (
    echo [2/5] FFmpeg binary verified in PATH.
)
echo:

if not exist "..\audio.cpp" (
    echo [3/5] Cloning official audio.cpp C++ engine repository...
    git clone https://github.com/0xShug0/audio.cpp ..\audio.cpp
) else (
    echo [3/5] audio.cpp repository detected.
)
echo:

set NEED_BUILD=0
if not exist "..\audio.cpp\build\windows-cuda-release\bin\audiocpp_server.exe" set NEED_BUILD=1
if not exist "..\audio.cpp\build\windows-cuda-release\bin\audiocpp_cli.exe" set NEED_BUILD=1

if exist "..\audio.cpp" (
    if "%NEED_BUILD%"=="1" (
        echo [4/5] Compiling audio.cpp CUDA binaries (audiocpp_server, audiocpp_cli with Parakeet ASR) via CMake...
        cd /d "..\audio.cpp"
        cmake -B build/windows-cuda-release -DGGML_CUDA=ON
        cmake --build build/windows-cuda-release --config Release --parallel
        cd /d "%~dp0"
    ) else (
        echo [4/5] audiocpp_server.exe and audiocpp_cli.exe CUDA binaries verified.
    )
)
echo:

echo [5/5] Launching Interactive Setup Wizard (Provisions Parakeet ASR and TTS Models)...
node setup.js
pause
