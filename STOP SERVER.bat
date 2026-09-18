@echo off
REM Stops the Morse Trainer server if it's running in the background.
REM Normally you just close the "START SERVER.bat" window instead --
REM use this only if that window was closed/lost some other way.
setlocal
call "%~dp0scripts\stop.bat" %1
endlocal
