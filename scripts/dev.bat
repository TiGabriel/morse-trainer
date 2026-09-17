@echo off
REM Starts the Morse Trainer server in DEVELOPMENT mode.
REM The server automatically restarts when a source file changes.

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

set NODE_ENV=development
echo Starting Morse Trainer server in DEVELOPMENT mode...
call npm run dev

endlocal
