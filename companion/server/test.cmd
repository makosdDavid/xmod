@echo off
rem Automata tesztek (Lua hid LuaJIT alatt + szerver/szimulator vegponttol vegpontig)
setlocal
cd /d "%~dp0"
if not defined UV_CACHE_DIR set "UV_CACHE_DIR=D:\X4-tools\uv-cache"
uv run --locked --group test python tests\test_e2e.py
pause
endlocal
