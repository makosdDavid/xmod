@echo off
rem X4 WebMap local server: named pipe x4webmap  -^>  http://127.0.0.1:8777
setlocal
cd /d "%~dp0"
if not defined UV_CACHE_DIR set "UV_CACHE_DIR=D:\X4-tools\uv-cache"
echo X4 WebMap szerver indul: http://127.0.0.1:8777  (leallitas: Ctrl+C)
uv run --locked python server.py %*
if errorlevel 1 pause
endlocal
