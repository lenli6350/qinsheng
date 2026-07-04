@echo off
title FamilyVoiceAgent
echo Starting FamilyVoiceAgent local server...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
pause
