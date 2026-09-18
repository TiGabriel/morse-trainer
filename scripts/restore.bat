@echo off
REM Restores the classroom database from a backup created by backup.bat.
REM The server MUST be stopped before running this.

setlocal
cd /d "%~dp0..\server\data"

if "%~1"=="" (
    echo Usage: restore.bat ^<path-to-backup-file.db^>
    echo Example: restore.bat backups\morse_trainer_20260101_120000.db
    echo.
    if exist backups (
        echo Available backups in server\data\backups:
        dir /b backups\*.db 2>nul
    )
    pause
    exit /b 1
)

if not exist "%~1" (
    echo ERROR: Backup file "%~1" not found.
    pause
    exit /b 1
)

netstat -aon | findstr LISTENING | findstr :8080 >nul
if not errorlevel 1 (
    echo ERROR: The server is still running on port 8080.
    echo Close "START SERVER.bat" ^(or run STOP SERVER.bat^) first, then run this again.
    pause
    exit /b 1
)

if exist morse_trainer.db (
    echo Saving the CURRENT database as a safety copy before restoring...
    copy /y morse_trainer.db morse_trainer.db.before-restore >nul
)

echo Restoring "%~1"...
copy /y "%~1" morse_trainer.db >nul
if errorlevel 1 (
    echo ERROR: Restore failed. Your original database is untouched
    echo ^(and also saved as morse_trainer.db.before-restore^).
    pause
    exit /b 1
)

REM Remove any leftover WAL/SHM files from before the restore -- they
REM belong to the OLD database and must never be reused with the
REM restored file.
if exist morse_trainer.db-wal del /f morse_trainer.db-wal
if exist morse_trainer.db-shm del /f morse_trainer.db-shm

echo.
echo ========================================================
echo   RESTORE COMPLETE
echo ========================================================
echo   Restored from: %~1
echo   Previous database saved as: morse_trainer.db.before-restore
echo   (delete that file once you've confirmed the restore worked)
echo.
echo   Start the server normally now (START SERVER.bat).
echo ========================================================
echo.
pause
endlocal
