@echo off
setlocal
cd /d "%~dp0"
echo ===================================================
echo   MediaSniff Companion App Uninstaller
echo ===================================================
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall_coapp.ps1"
echo.
echo Press any key to exit...
pause > nul
