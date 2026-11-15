@echo off
rem x4span launcher - Windows PowerShell 5.1.
rem Peldak:  x4span.cmd -List   |   x4span.cmd K1 -WhatIf   |   x4span.cmd K2   |   x4span.cmd -Restore
rem Rovid nevek: K1=k1-uw-left  K2=k2-triple  K3=k3-triple-1080  K4=k4-surround  K6=k6-virtual  UW=single-uw
set "_X4SPAN_ARG1=%~1"
if not defined _X4SPAN_ARG1 goto run
if "%_X4SPAN_ARG1:~0,1%"=="-" goto run
set "_X4SPAN_ARG1="
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0x4span.ps1" -Preset %*
exit /b %ERRORLEVEL%
:run
set "_X4SPAN_ARG1="
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0x4span.ps1" %*
exit /b %ERRORLEVEL%
