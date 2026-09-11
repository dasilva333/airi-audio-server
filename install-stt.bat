@echo off
title AIRI Audio Server - Citrinet STT / ASR Setup & Repair
cd /d "%~dp0"

echo ============================================================
echo      AIRI Audio Server - Citrinet STT Setup & Repair
echo ============================================================
echo:

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not found in system PATH.
    echo Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)

node tools\setup-stt.js
pause
