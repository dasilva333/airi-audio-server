@echo off
title AIRI Audio Server - Interactive Installer & Setup
cd /d "%~dp0"
echo ============================================================
echo         AIRI Audio Server - Installation & Setup            
echo ============================================================
echo.
echo Installing Node.js dependencies...
call npm install
echo.
echo Launching Interactive Model Setup Wizard...
node setup.js
pause
