@echo off
setlocal
title Local AI Workbench

REM ============================================================
REM  menu.bat  --  the single entry point of the workbench
REM
REM  The desktop shortcut points here.
REM
REM  The actual interface lives in menu.ps1, because a .bat file
REM  cannot safely contain Chinese text: cmd parses it with the
REM  ANSI code page and mangles it into garbage commands.
REM  This file stays pure ASCII and only starts the script.
REM
REM  PowerShell ships with Windows -- nothing to install.
REM ============================================================

if not exist "%~dp0menu.ps1" (
    echo.
    echo    [ERROR] menu.ps1 not found next to this file.
    echo            Expected: %~dp0menu.ps1
    echo.
    pause
    exit /b 1
)

REM  -NoProfile               skip the user profile, starts faster
REM  -ExecutionPolicy Bypass  run even if scripts are restricted
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0menu.ps1"

set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
    echo.
    echo    The menu exited with code %RC%.
    echo.
    pause
)
exit /b %RC%
