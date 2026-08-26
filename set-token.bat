@echo off
REM Double-click this to paste the GitHub token into the extension and rebuild the zip.
cd /d "%~dp0"
python tools\embed_token.py
pause
