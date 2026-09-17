@echo off
REM Stops the Morse Trainer server by finding the process listening on its
REM port and terminating it. Usage:
REM   stop.bat            (uses default port 8080)
REM   stop.bat 9090       (uses a custom port, if you changed PORT in .env)

setlocal
set PORT=%1
if "%PORT%"=="" set PORT=8080

echo Looking for a process listening on port %PORT%...

set FOUND=0
for /f "tokens=5" %%P in ('netstat -aon ^| findstr LISTENING ^| findstr :%PORT%') do (
    set FOUND=1
    echo Stopping process ID %%P on port %PORT%...
    taskkill /PID %%P /F
)

if "%FOUND%"=="0" (
    echo No process found listening on port %PORT%. Server may already be stopped.
)

endlocal
