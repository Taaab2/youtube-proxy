@echo off
REM Run this ONCE, from inside the extension folder, to let the "update now" button in
REM the extension trigger update.bat. Re-run it if you ever move the extension folder.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause
