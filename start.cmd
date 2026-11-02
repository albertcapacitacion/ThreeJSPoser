@echo off
cd /d "%~dp0"
if not exist node_modules\three\build\three.module.js (
  echo Run npm install in this folder first.
  pause
  exit /b 1
)
echo Starting local server. Use the URL shown below and keep this window open.
node server.mjs
if errorlevel 1 pause
