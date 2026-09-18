@echo off
REM Adds a Windows Firewall rule allowing inbound connections to the Morse
REM Trainer server's port, on PRIVATE networks only. Does NOT disable the
REM firewall or touch Public/Domain network rules.
REM
REM Must be run as Administrator (right-click this file -> "Run as
REM administrator"). Safe to run more than once.

setlocal
set PORT=%1
if "%PORT%"=="" set PORT=8080

net session >nul 2>&1
if not %errorlevel%==0 (
    echo ERROR: This must be run as Administrator.
    echo Right-click this file and choose "Run as administrator", then try again.
    pause
    exit /b 1
)

echo Adding a Windows Firewall rule: allow inbound TCP port %PORT%, PRIVATE networks only...
netsh advfirewall firewall add rule name="Morse Trainer (port %PORT%)" dir=in action=allow protocol=TCP localport=%PORT% profile=private

if errorlevel 1 (
    echo.
    echo ERROR: Could not add the firewall rule. See the message above.
    pause
    exit /b 1
)

echo.
echo ========================================================
echo   FIREWALL RULE ADDED
echo ========================================================
echo   Rule name:  Morse Trainer (port %PORT%)
echo   Allows:     inbound TCP %PORT%, PRIVATE networks only
echo   Public/Domain network rules were NOT changed.
echo   The Windows Firewall itself is still fully enabled.
echo ========================================================
echo.
echo Student computers on the same LAN should now be able to reach
echo this server. If your classroom network is set to "Public" in
echo Windows network settings, change it to "Private" first (Settings
echo -^> Network ^& Internet -^> your network -^> Network profile type).
echo.
pause
endlocal
