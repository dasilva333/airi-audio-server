@echo off
setlocal
set "BINDIR=%~dp1"
set "EXE_PATH=%~1"
set "CFG_PATH=%~2"
set "CUSTOM_CUDA_PATH=%~3"

if not "%CUSTOM_CUDA_PATH%"=="" (
    set "CUDA_BIN=%CUSTOM_CUDA_PATH%"
) else if not "%CUDA_PATH%"=="" (
    set "CUDA_BIN=%CUDA_PATH%\bin"
) else (
    set "CUDA_BIN=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.1\bin\x64"
)

set "PATH=%BINDIR%;%CUDA_BIN%;%PATH%"

echo [run_server.bat] BINDIR: "%BINDIR%"
echo [run_server.bat] CUDA:   "%CUDA_BIN%"
echo [run_server.bat] EXE:    "%EXE_PATH%"
echo [run_server.bat] CFG:    "%CFG_PATH%"

"%EXE_PATH%" --config "%CFG_PATH%"
