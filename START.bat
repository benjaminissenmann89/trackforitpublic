@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title ansem.io tracker (trackforitpublic)

rem Everything stays inside this folder: Node in .node\, browsers in .playwright\, state in data\ and logs\
set "NODE_VER=24.19.0"
set "PLAYWRIGHT_BROWSERS_PATH=%~dp0.playwright"

rem ---------- 1. Find Node.js (needs v20+) ----------
where node >nul 2>nul
if errorlevel 1 goto :try_local_node
node -e "process.exit(+process.versions.node.split('.')[0]>=20?0:1)" >nul 2>nul
if not errorlevel 1 goto :node_ok

:try_local_node
if exist ".node\node.exe" (
  set "PATH=%CD%\.node;%PATH%"
  goto :node_ok
)
if exist "%ProgramFiles%\nodejs\node.exe" (
  "%ProgramFiles%\nodejs\node.exe" -e "process.exit(+process.versions.node.split('.')[0]>=20?0:1)" >nul 2>nul
  if not errorlevel 1 (
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
    goto :node_ok
  )
)

where winget >nul 2>nul
if errorlevel 1 goto :portable_node
echo Node.js not found. Installing Node.js LTS with winget...
winget install -e --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
if exist "%ProgramFiles%\nodejs\node.exe" (
  set "PATH=%ProgramFiles%\nodejs;%PATH%"
  goto :node_ok
)

:portable_node
echo Node.js not found. Downloading portable Node.js v%NODE_VER% into .node\ ...
set "NODE_ZIP=%TEMP%\trackforitpublic-node-v%NODE_VER%.zip"
curl -fL --retry 3 -o "%NODE_ZIP%" "https://nodejs.org/dist/v%NODE_VER%/node-v%NODE_VER%-win-x64.zip"
if errorlevel 1 goto :fail_node
if exist ".node" rmdir /s /q ".node"
mkdir ".node"
tar -xf "%NODE_ZIP%" -C ".node" --strip-components=1
if errorlevel 1 goto :fail_node
del /q "%NODE_ZIP%" >nul 2>nul
if not exist ".node\node.exe" goto :fail_node
set "PATH=%CD%\.node;%PATH%"

:node_ok
for /f "delims=" %%v in ('node -v') do echo Using Node.js %%v

rem ---------- 2. First run only: install dependencies + Chromium ----------
if exist "node_modules\.setup-done" goto :secrets
echo.
echo First run: installing dependencies and the Chromium browser. This takes a few minutes...
call npm ci --no-audit --no-fund
if errorlevel 1 goto :fail_setup
node node_modules\playwright\cli.js install chromium
if errorlevel 1 goto :fail_setup
echo setup done> "node_modules\.setup-done"

rem ---------- 3. Restore secrets (.env etc.) from secrets.enc ----------
:secrets
if exist ".env" goto :run
set "UNLOCK_KEY=%~1"
set "TRIES=0"
:ask_key
set /a TRIES+=1
if %TRIES% gtr 3 goto :fail_unlock
if not defined UNLOCK_KEY set /p "UNLOCK_KEY=Enter the unlock key: "
if not defined UNLOCK_KEY goto :ask_key
node src\secrets.js unlock "%UNLOCK_KEY%"
if not errorlevel 1 goto :run
set "UNLOCK_KEY="
goto :ask_key

rem ---------- 4. Run forever, restart on crash ----------
:run
echo.
echo ================================================================
echo   ansem.io tracker is running.
echo   KEEP THIS WINDOW OPEN. Minimizing it is fine.
echo   Closing this window STOPS the tracker.
echo   To start it again later, double-click START.bat
echo ================================================================
echo.
:loop
node track.js
set "RC=%errorlevel%"
if "%RC%"=="3" goto :already_running
echo.
echo Tracker stopped (exit code %RC%). Restarting in 15 seconds... close this window to stop.
ping -n 16 127.0.0.1 >nul
goto :loop

:already_running
echo.
echo The tracker is already running in another window. Not starting a second copy.
echo This window closes in 10 seconds.
ping -n 11 127.0.0.1 >nul
exit /b 3

:fail_node
echo.
echo ERROR: Could not download or extract Node.js v%NODE_VER%. Check the internet connection and run START.bat again.
pause
exit /b 1

:fail_setup
echo.
echo ERROR: First-run setup failed. Check the messages above, then run START.bat again.
pause
exit /b 1

:fail_unlock
echo.
echo ERROR: Could not unlock the secrets (wrong key?). Run START.bat again with the correct key:
echo   START.bat YOUR_UNLOCK_KEY
pause
exit /b 1
