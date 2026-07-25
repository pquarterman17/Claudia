@echo off
setlocal
title Claudia

rem Run from the repo root no matter where this was launched from.
cd /d "%~dp0"

rem Already running? Just show it rather than failing on a port clash.
netstat -ano | findstr "LISTENING" | findstr "127.0.0.1:4317" >nul 2>&1
if %errorlevel%==0 (
  echo Claudia is already running - opening it.
  start "" "http://localhost:4318"
  timeout /t 2 /nobreak >nul
  exit /b 0
)

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Node.js is required but was not found on PATH.
  echo   Install it from https://nodejs.org then run this again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo.
  echo   First run - installing dependencies. This takes a minute or two.
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   npm install failed. See the messages above.
    echo.
    pause
    exit /b 1
  )
)

rem Open the browser once the dev server has had a moment to bind.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 4; Start-Process 'http://localhost:4318'"

echo.
echo   Claudia is starting.
echo   UI:     http://localhost:4318
echo   Server: http://127.0.0.1:4317
echo.
echo   Close this window, or press Ctrl+C, to stop it.
echo.

call npm run dev

rem Only reached if the dev server exits on its own, which means something broke.
echo.
echo   Claudia stopped.
echo.
pause
