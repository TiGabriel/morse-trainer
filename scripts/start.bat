@echo off
REM Starts the Morse Trainer server (production mode).
REM Double-click this file, or run it from a Command Prompt.

setlocal
cd /d "%~dp0..\server"

if not exist node_modules (
    echo Dependencies not installed yet. Running "npm install" first...
    call npm install
    if errorlevel 1 (
        echo.
        echo Failed to install dependencies. Check your internet connection
        echo for this one-time setup step, then try again.
        pause
        exit /b 1
    )
)

set NODE_ENV=production
echo Starting Morse Trainer server...
call npm start

endlocal
