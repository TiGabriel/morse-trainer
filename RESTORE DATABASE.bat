@echo off
REM Restores the classroom database from a backup file created by
REM "BACKUP DATABASE.bat". The server must be stopped first.
REM Usage: drag a backup .db file onto this icon, or run from a Command
REM Prompt: "RESTORE DATABASE.bat" server\data\backups\morse_trainer_....db
setlocal
call "%~dp0scripts\restore.bat" %1
endlocal
