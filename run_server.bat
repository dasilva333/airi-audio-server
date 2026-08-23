@echo off
setlocal enabledelayedexpansion
set "BINDIR=%~dp1"
set "EXE_PATH=%~1"
set "CFG_PATH=%~2"
set "CUSTOM_CUDA_PATH=%~3"

set "CUDA_PATHS="
if not "%CUSTOM_CUDA_PATH%"=="" (
    set "CUDA_PATHS=%CUSTOM_CUDA_PATH%"
)

if not "%CUDA_PATH%"=="" (
    if exist "%CUDA_PATH%\bin\x64" (
        if "!CUDA_PATHS!"=="" (set "CUDA_PATHS=%CUDA_PATH%\bin\x64") else (set "CUDA_PATHS=!CUDA_PATHS!;%CUDA_PATH%\bin\x64")
    )
    if exist "%CUDA_PATH%\bin" (
        if "!CUDA_PATHS!"=="" (set "CUDA_PATHS=%CUDA_PATH%\bin") else (set "CUDA_PATHS=!CUDA_PATHS!;%CUDA_PATH%\bin")
    )
    if exist "%CUDA_PATH%\nvvm\bin\x64" (
        if "!CUDA_PATHS!"=="" (set "CUDA_PATHS=%CUDA_PATH%\nvvm\bin\x64") else (set "CUDA_PATHS=!CUDA_PATHS!;%CUDA_PATH%\nvvm\bin\x64")
    )
    if exist "%CUDA_PATH%\libnvvp" (
        if "!CUDA_PATHS!"=="" (set "CUDA_PATHS=%CUDA_PATH%\libnvvp") else (set "CUDA_PATHS=!CUDA_PATHS!;%CUDA_PATH%\libnvvp")
    )
)

rem Auto-detect any installed CUDA versions (supporting CUDA 13+ bin\x64 and CUDA 12/11 bin layouts)
for /d %%V in ("C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v*") do (
    if exist "%%V\bin\x64" (
        if "!CUDA_PATHS!"=="" (set "CUDA_PATHS=%%V\bin\x64") else (set "CUDA_PATHS=!CUDA_PATHS!;%%V\bin\x64")
    )
    if exist "%%V\bin" (
        if "!CUDA_PATHS!"=="" (set "CUDA_PATHS=%%V\bin") else (set "CUDA_PATHS=!CUDA_PATHS!;%%V\bin")
    )
    if exist "%%V\nvvm\bin\x64" (
        if "!CUDA_PATHS!"=="" (set "CUDA_PATHS=%%V\nvvm\bin\x64") else (set "CUDA_PATHS=!CUDA_PATHS!;%%V\nvvm\bin\x64")
    )
    if exist "%%V\libnvvp" (
        if "!CUDA_PATHS!"=="" (set "CUDA_PATHS=%%V\libnvvp") else (set "CUDA_PATHS=!CUDA_PATHS!;%%V\libnvvp")
    )
)

if "!CUDA_PATHS!"=="" (
    echo [run_server.bat] WARNING: CUDA_PATH not set and no CUDA installation detected.
)

set "PATH=%BINDIR%;!CUDA_PATHS!;%PATH%"

echo [run_server.bat] BINDIR: "%BINDIR%"
echo [run_server.bat] CUDA:   "!CUDA_PATHS!"
echo [run_server.bat] EXE:    "%EXE_PATH%"
echo [run_server.bat] CFG:    "%CFG_PATH%"

"%EXE_PATH%" --config "%CFG_PATH%"
