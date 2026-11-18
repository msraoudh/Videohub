@echo off
rem VideoHub in its own window on the dedicated graphics card (NVIDIA / AMD).
rem Starts the local hub if needed (server only), then opens VideoHub in an Electron window that picks the GPU at launch.
rem First time only: run  npm install  in this folder (downloads Electron).
cd /d "%~dp0"
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo Electron is not installed yet. Running npm install in %~dp0 ...
  call npm install || (echo npm install failed & pause & exit /b 1)
)
node "%~dp0..\scripts\install.mjs" open --server >nul 2>&1
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0main.cjs"
