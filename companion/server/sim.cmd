@echo off
rem Jatek nelkuli proba: a szimulator ugyanazt kuldi, amit a mod (300 hajo, gyorsgombok)
setlocal
cd /d "%~dp0"
if not defined UV_CACHE_DIR set "UV_CACHE_DIR=D:\X4-tools\uv-cache"
uv run --locked python sim.py --hotkeys %*
endlocal
