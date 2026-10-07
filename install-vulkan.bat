@echo off
setlocal enabledelayedexpansion
title AIRI Audio Server - AMD Radeon / Vulkan Setup
cd /d "%~dp0"

rem Force the Vulkan backend for the whole install so config.json and the engine
rem both select it without ambiguity.
set "AIRI_GPU_BACKEND=vulkan"
set "AIRI_BUILD_BACKEND=vulkan"

echo ============================================================
echo      AIRI Audio Server - AMD Radeon / Vulkan Setup
echo ============================================================
echo Target pipeline: AIRI -^> airi-audio-server -^> audiocpp_server -^> Vulkan -^> AMD GPU
echo:

echo [1/5] Installing Node.js dependencies...
call npm install
echo:

echo [2/5] Verifying prerequisites for the Vulkan build...
where cmake >nul 2>nul
if %errorlevel% neq 0 (
    echo [MISSING] CMake. Install it with: winget install Kitware.CMake
)
where ninja >nul 2>nul
if %errorlevel% neq 0 (
    echo [MISSING] Ninja. Install it with: winget install Ninja-build.Ninja
)
if "%VULKAN_SDK%"=="" (
    echo [MISSING] LunarG Vulkan SDK ^(VULKAN_SDK is not set^).
    echo           Install it with: winget install KhronosGroup.VulkanSDK
    echo           then open a NEW terminal so VULKAN_SDK becomes visible.
) else (
    echo Vulkan SDK: %VULKAN_SDK%
)
echo:

echo [3/5] Ensuring the audio.cpp C++ engine source tree...
if not exist "..\audio.cpp\CMakeLists.txt" (
    git clone --depth 1 https://github.com/0xShug0/audio.cpp ..\audio.cpp
) else (
    echo audio.cpp repository detected.
)
echo:

echo [4/5] Building audiocpp_server and audiocpp_cli with the windows-vulkan-release preset...
node "tools\build-audio-cpp.js" vulkan
if errorlevel 1 (
    echo:
    echo [ERROR] Vulkan build failed. Install the missing prerequisites listed above
    echo         (LunarG Vulkan SDK with glslc, VS Build Tools 2022, CMake, Ninja), then
    echo         re-run: npm run build:vulkan
    pause
    exit /b 1
)
echo:

echo [5/5] Launching setup wizard + diagnostics (models, then GPU check)...
node setup.js
node "tools\gpu-info.js"

echo:
echo ============================================================
echo      Vulkan setup complete. Start the server with: npm start
echo ============================================================
pause
