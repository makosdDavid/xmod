@echo off
rem X4 Companion szerver: named pipe x4companion  -^>  http://127.0.0.1:8788
setlocal
cd /d "%~dp0"
if not defined UV_CACHE_DIR set "UV_CACHE_DIR=D:\X4-tools\uv-cache"
echo X4 Companion szerver indul: http://127.0.0.1:8788  (leallitas: Ctrl+C)
uv run --locked python server.py %*
if errorlevel 1 pause
endlocal
