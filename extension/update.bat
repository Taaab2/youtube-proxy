@echo off
REM YouTube Proxy — updater entry point (double-click to update, or triggered by the
REM extension's "update now" button via native messaging). Keep this file to these two
REM lines and stable: the update copies a fresh copy over it, and a byte-identical
REM overwrite of a running .bat is the only safe kind. All real work is in boot.ps1,
REM which is run from %TEMP% so it can overwrite this whole folder safely.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$w=Join-Path $env:TEMP 'ytproxy-upd'; New-Item -ItemType Directory -Force -Path $w ^| Out-Null; Copy-Item -LiteralPath (Join-Path '%~dp0' 'boot.ps1') -Destination $w -Force; & (Join-Path $w 'boot.ps1') -ExtDir '%~dp0'"
