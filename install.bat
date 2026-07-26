@echo off
title AIRI Audio Server - Automated 1-Click Installer
cd /d "%~dp0"

echo ============================================================
echo      AIRI Audio Server - Automated 1-Click Installer       
echo ============================================================
echo.

:: 1. Install Node.js dependencies
echo [1/4] Installing Node.js dependencies...
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] npm install failed. Please ensure Node.js is installed.
    pause
    exit /b 1
)

:: 2. Check & Clone official public audio.cpp repository
if not exist "..\audio.cpp" (
    echo.
    echo [2/4] Cloning official audio.cpp C++ engine repository...
    git clone https://github.com/0xShug0/audio.cpp ..\audio.cpp
    if %errorlevel% neq 0 (
        echo [WARNING] Failed to clone audio.cpp automatically. Proceeding to setup...
    )
) else (
    echo [2/4] audio.cpp repository detected.
)

:: 3. Check & Build audio.cpp CUDA binaries
if exist "..\audio.cpp" (
    if not exist "..\audio.cpp\build\windows-cuda-release\bin\audiocpp_server.exe" (
        echo.
        echo [3/4] Compiling audio.cpp CUDA binaries via CMake...
        cd /d "..\audio.cpp"
        cmake -B build/windows-cuda-release -DGGML_CUDA=ON
        cmake --build build/windows-cuda-release --config Release --parallel
        cd /d "%~dp0"
    ) else (
        echo [3/4] audiocpp_server.exe CUDA binary verified.
    )
)

:: 4. Launch Interactive Setup Wizard
echo.
echo [4/4] Launching Interactive Setup Wizard...
node setup.js
pause
