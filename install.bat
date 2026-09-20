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
if not exist "..\audio.cpp\build\windows-cuda-release\bin\audiocpp_server.exe" if not exist "bin\windows-cuda\audiocpp_server.exe" set NEED_BUILD=1
if not exist "..\audio.cpp\build\windows-cuda-release\bin\audiocpp_cli.exe" if not exist "bin\windows-cuda\audiocpp_cli.exe" set NEED_BUILD=1

if exist "..\audio.cpp" (
    if "%NEED_BUILD%"=="1" (
        echo [4/5] Compiling audio.cpp CUDA binaries [audiocpp_server, audiocpp_cli with Citrinet ASR] via CMake...
        cd /d "..\audio.cpp"
        cmake -B build/windows-cuda-release -DGGML_CUDA=ON
        cmake --build build/windows-cuda-release --config Release --parallel
        cd /d "%~dp0"
    ) else (
        echo [4/5] Pre-compiled multi-generation CUDA binaries verified [sm75, sm86, sm89, sm120].
    )
)
echo:

echo [5/8] Launching Interactive Setup Wizard (Provisions Citrinet ASR and TTS Models)...
node setup.js
echo:

echo ============================================================
echo [6/8] Generative Music Engine Add-on (Optional)
echo ============================================================
echo Would you like to install Generative Music Models (YuE 2 / MiniMax)?
echo You can also run 'npm run add-music' at any time later.
echo:
set /p INSTALL_MUSIC="Install Generative Music Models now? (y/N): "
if /i "%INSTALL_MUSIC%"=="y" (
    node download_music.js
)
echo:

echo ============================================================
echo [7/8] Natural Voice Designer Add-on (Optional)
echo ============================================================
echo Would you like to install MOSS-VoiceGenerator for creating voices
echo from natural text descriptions without audio samples?
echo You can also run 'npm run add-voicegen' at any time later.
echo:
set /p INSTALL_VOICEGEN="Install MOSS-VoiceGenerator now? (y/N): "
if /i "%INSTALL_VOICEGEN%"=="y" (
    node download_voicegen.js
)
echo:

echo ============================================================
echo [8/8] Fast Sound Effects / SFX Add-on (Optional)
echo ============================================================
echo Would you like to install Stable Audio 3 Small SFX for ambient
echo textures, sound effects, and UI foley (8 diffusion steps)?
echo You can also run 'npm run add-sfx' at any time later.
echo:
set /p INSTALL_SFX="Install Stable Audio 3 Small SFX now? (y/N): "
if /i "%INSTALL_SFX%"=="y" (
    node download_sfx.js
)

echo:
echo ============================================================
echo      AIRI Audio Server Installation Complete!               
echo ============================================================
echo Run 'npm start' or 'run_server.bat' to launch the microservice.
pause
