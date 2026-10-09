@echo off
setlocal
set NODE_OPTIONS=
title Local AI Setup

rem ---- 1. locate Node.js (bundled node\ first, then PATH, then common install dirs) ----
set "FOUND="
if exist "%~dp0node\node.exe" (
    set "PATH=%~dp0node;%PATH%"
    set "FOUND=1"
)

if not defined FOUND (
    where node >nul 2>nul
    if not errorlevel 1 set "FOUND=1"
)

if not defined FOUND if exist "%ProgramFiles%\nodejs\node.exe" (
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
    set "FOUND=1"
)
if not defined FOUND if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" (
    set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
    set "FOUND=1"
)

if not defined FOUND goto :bootstrap

rem ---- 2. check major version (need >= 20) ----
set "MAJOR="
for /f "tokens=1 delims=." %%v in ('node -v 2^>nul') do set "MAJOR=%%v"
if not defined MAJOR goto :bootstrap
set "MAJOR=%MAJOR:v=%"
if %MAJOR% LSS 20 goto :bootstrap

rem ---- 3. normal path: launch the graphical installer ----
node "%~dp0scripts\installer.mjs"
goto :end

rem ---- Node.js missing or too old: hand over to the PowerShell helper ----
:bootstrap
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap.ps1" "%~dp0"
goto :end

:end
echo.
pause
