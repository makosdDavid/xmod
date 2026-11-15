@echo off
rem A jatek terkepikonjainak exportja a sajat telepitesbol (data\icons, git-ignored). ~4 mp.
setlocal
cd /d "%~dp0"
if not defined UV_CACHE_DIR set "UV_CACHE_DIR=D:\X4-tools\uv-cache"
uv run --locked --with pillow==11.3.0 python export_icons.py %*
pause
endlocal
