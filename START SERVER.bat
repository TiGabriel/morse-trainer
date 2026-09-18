@echo off
REM ============================================================
REM  Morse Trainer -- Teacher Startup
REM  Double-click this file to start the classroom server.
REM  Leave this window open while the class is using the app.
REM  Close this window (or press Ctrl+C) to stop the server.
REM ============================================================

setlocal

echo ========================================================
echo   MORSE TRAINER - STARTING SERVER
echo ========================================================
echo.

REM ---- 1. Confirm Node.js is installed -----------------------
where node >nul 2>nul
if errorlevel 1 (
    echo ERROR: Node.js was not found on this computer.
    echo.
    echo Morse Trainer requires Node.js version 18 or later.
    echo Download it from https://nodejs.org/ ^(choose the "LTS" version^),
    echo install it, then run this file again.
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node --version') do set NODE_VERSION=%%v
echo Found Node.js %NODE_VERSION%
echo.

cd /d "%~dp0server"

REM ---- 2. Install dependencies on first run only --------------
REM This is the ONLY step that needs an internet connection, and only
REM the very first time this app is set up on this computer. Once
REM "node_modules" exists, every future start is fully offline.
if not exist node_modules (
    echo Dependencies not installed yet. Running "npm install"...
    echo ^(This one-time step needs an internet connection.^)
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo ERROR: "npm install" failed. Check your internet connection
        echo for this one-time setup step, then run this file again.
        echo.
        pause
        exit /b 1
    )
    echo.
    echo Dependencies installed successfully.
    echo.
)

REM ---- 3. Configuration (optional) -----------------------------
if not exist .env (
    if exist .env.example (
        echo No .env file found -- using built-in defaults ^(port 8080,
        echo bound to all network interfaces^). Copy .env.example to .env
        echo if you need to change the port or other settings.
        echo.
    )
)

REM ---- 4. Start the server ---------------------------------------
REM The server itself applies the database schema, creates the initial
REM teacher account if needed, and binds to 0.0.0.0 so student PCs on
REM the same LAN can reach it -- all handled automatically below.
set NODE_ENV=production
echo Starting Morse Trainer server...
echo.
call npm start

echo.
echo ========================================================
echo   Server has stopped.
echo ========================================================
pause

endlocal
