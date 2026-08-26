@echo off
REM Native messaging host launcher. Chrome's registered host "path" points here; it
REM hands the stdin/stdout pipes to nm-host.ps1, which speaks the protocol. Keep this to
REM these two lines and stable — an update overwrites it with a byte-identical copy.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0nm-host.ps1"
