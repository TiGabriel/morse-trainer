@echo off
REM Creates a timestamped backup copy of the classroom database.
REM
REM IMPORTANT: for a safe, consistent backup, stop the server first
REM (close the "START SERVER.bat" window, or run STOP SERVER.bat) --
REM this script warns you if it looks like the server is still running.

setlocal
cd /d "%~dp0..\server\data"

if not exist morse_trainer.db (
    echo No database file found at server\data\morse_trainer.db -- nothing to back up.
    pause
    exit /b 1
)

netstat -aon | findstr LISTENING | findstr :8080 >nul
if not errorlevel 1 (
    echo WARNING: The server still appears to be running on port 8080.
    echo Backing up while it's running can copy a database mid-write.
    echo For a safe backup, close "START SERVER.bat" first, then run this again.
    echo.
    set /p CONTINUE="Continue anyway? (y/N): "
    if /i not "%CONTINUE%"=="y" (
        echo Backup cancelled.
        pause
        exit /b 1
    )
)

if not exist backups mkdir backups

for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set STAMP=%%I
if "%STAMP%"=="" (
    echo ERROR: Could not determine a timestamp for the backup filename.
    pause
    exit /b 1
)

copy /y morse_trainer.db "backups\morse_trainer_%STAMP%.db" >nul
if errorlevel 1 (
    echo ERROR: Backup failed.
    pause
    exit /b 1
)

echo.
echo ========================================================
echo   BACKUP CREATED
echo ========================================================
echo   server\data\backups\morse_trainer_%STAMP%.db
echo.
echo Copy this file somewhere safe off this computer too
echo (a USB drive, network share, etc.) -- a backup that only
echo ever lives on the same machine isn't a real backup.
echo ========================================================
echo.
pause
endlocal
