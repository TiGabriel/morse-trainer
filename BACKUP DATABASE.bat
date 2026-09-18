@echo off
REM Creates a timestamped backup of the classroom database.
REM Stop the server first (close the "START SERVER.bat" window) for a
REM safe, consistent backup.
setlocal
call "%~dp0scripts\backup.bat"
endlocal
