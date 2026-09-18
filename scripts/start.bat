@echo off
REM Kept for backwards compatibility / scripted use. Teachers should
REM normally use "START SERVER.bat" in the project's root folder instead --
REM this just delegates to it.
setlocal
call "%~dp0..\START SERVER.bat"
endlocal
