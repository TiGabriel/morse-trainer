@echo off
REM Right-click this file and choose "Run as administrator".
REM Opens the classroom server's port (8080 by default) through Windows
REM Firewall for PRIVATE networks only -- see scripts\open-firewall-port.bat
REM for exactly what this does. It does not disable the firewall.
setlocal
call "%~dp0scripts\open-firewall-port.bat" %1
endlocal
