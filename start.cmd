@echo off
cd /d "%~dp0"
if not exist node_modules\three\build\three.module.js (
  echo Run npm install in this folder first.
  pause
  exit /b 1
)
echo Open http://127.0.0.1:5173 in Chrome. Keep this window open.
node server.mjs
if errorlevel 1 pause
