@echo off
setlocal enabledelayedexpansion
rem ---------------------------------------------------------------------------
rem AIRI Audio Server - audio.cpp launcher (backend-agnostic)
rem
rem Args:
rem   %1  EXE_PATH      audiocpp_server.exe to run
rem   %2  CFG_PATH      generated server.json
rem   %3  RUNTIME_PATHS semicolon-separated runtime lib dirs for the backend
rem   %4  BACKEND       cuda | vulkan | cpu | metal
rem ---------------------------------------------------------------------------
set "EXE_PATH=%~1"
set "CFG_PATH=%~2"
set "RUNTIME_PATHS=%~3"
set "BACKEND=%~4"
set "BINDIR=%~dp1"

if "%BACKEND%"=="" set "BACKEND=cuda"

set "EXTRA_PATHS=%RUNTIME_PATHS%"

if /i "%BACKEND%"=="cuda" (
    rem --- CUDA runtime discovery (preserved legacy behaviour) ---
    if not "%CUDA_PATH%"=="" (
        if exist "%CUDA_PATH%\bin\x64" (
            if "!EXTRA_PATHS!"=="" (set "EXTRA_PATHS=%CUDA_PATH%\bin\x64") else (set "EXTRA_PATHS=!EXTRA_PATHS!;%CUDA_PATH%\bin\x64")
        )
        if exist "%CUDA_PATH%\bin" (
            if "!EXTRA_PATHS!"=="" (set "EXTRA_PATHS=%CUDA_PATH%\bin") else (set "EXTRA_PATHS=!EXTRA_PATHS!;%CUDA_PATH%\bin")
        )
        if exist "%CUDA_PATH%\nvvm\bin\x64" (
            if "!EXTRA_PATHS!"=="" (set "EXTRA_PATHS=%CUDA_PATH%\nvvm\bin\x64") else (set "EXTRA_PATHS=!EXTRA_PATHS!;%CUDA_PATH%\nvvm\bin\x64")
        )
        if exist "%CUDA_PATH%\libnvvp" (
            if "!EXTRA_PATHS!"=="" (set "EXTRA_PATHS=%CUDA_PATH%\libnvvp") else (set "EXTRA_PATHS=!EXTRA_PATHS!;%CUDA_PATH%\libnvvp")
        )
    )

    rem Auto-detect installed CUDA toolkits (CUDA 13+ bin\x64 and CUDA 12/11 bin layouts)
    for /d %%V in ("C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v*") do (
        if exist "%%V\bin\x64" (
            if "!EXTRA_PATHS!"=="" (set "EXTRA_PATHS=%%V\bin\x64") else (set "EXTRA_PATHS=!EXTRA_PATHS!;%%V\bin\x64")
        )
        if exist "%%V\bin" (
            if "!EXTRA_PATHS!"=="" (set "EXTRA_PATHS=%%V\bin") else (set "EXTRA_PATHS=!EXTRA_PATHS!;%%V\bin")
        )
        if exist "%%V\nvvm\bin\x64" (
            if "!EXTRA_PATHS!"=="" (set "EXTRA_PATHS=%%V\nvvm\bin\x64") else (set "EXTRA_PATHS=!EXTRA_PATHS!;%%V\nvvm\bin\x64")
        )
        if exist "%%V\libnvvp" (
            if "!EXTRA_PATHS!"=="" (set "EXTRA_PATHS=%%V\libnvvp") else (set "EXTRA_PATHS=!EXTRA_PATHS!;%%V\libnvvp")
        )
    )

    if "!EXTRA_PATHS!"=="" (
        echo [run_server.bat] WARNING: CUDA backend selected but no CUDA runtime was found. Set CUDA_PATH or config.cuda_path.
    )
)

if /i "%BACKEND%"=="vulkan" (
    rem The Vulkan loader (vulkan-1.dll) normally ships with the GPU driver, so no
    rem path is strictly required. Inject the SDK Bin dir when it is available.
    if not "%VULKAN_SDK%"=="" (
        if exist "%VULKAN_SDK%\Bin" (
            if "!EXTRA_PATHS!"=="" (set "EXTRA_PATHS=%VULKAN_SDK%\Bin") else (set "EXTRA_PATHS=!EXTRA_PATHS!;%VULKAN_SDK%\Bin")
        )
        if exist "%VULKAN_SDK%\bin" (
            if "!EXTRA_PATHS!"=="" (set "EXTRA_PATHS=%VULKAN_SDK%\bin") else (set "EXTRA_PATHS=!EXTRA_PATHS!;%VULKAN_SDK%\bin")
        )
    )
    if "!EXTRA_PATHS!"=="" (
        echo [run_server.bat] NOTE: Vulkan runtime uses the driver-provided loader; no extra paths injected.
    )
)

set "PATH=%BINDIR%;!EXTRA_PATHS!;%PATH%"

echo [run_server.bat] BACKEND: %BACKEND%
echo [run_server.bat] BINDIR:  "%BINDIR%"
echo [run_server.bat] RUNTIME: "!EXTRA_PATHS!"
echo [run_server.bat] EXE:     "%EXE_PATH%"
echo [run_server.bat] CFG:     "%CFG_PATH%"

rem server.json already declares the backend; pass --backend explicitly for
rem non-CUDA backends so a Vulkan/CPU selection can never be silently ignored.
if /i "%BACKEND%"=="cuda" (
    "%EXE_PATH%" --config "%CFG_PATH%"
) else (
    "%EXE_PATH%" --config "%CFG_PATH%" --backend %BACKEND%
)
