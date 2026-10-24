@echo off
setlocal enabledelayedexpansion
title Stop Strata

set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"

if not exist "%ROOT%\config\resolve.bat" (
    echo [ERROR] config\resolve.bat not found.
    pause
    exit /b 1
)
call "%ROOT%\config\resolve.bat"

echo ==================================================
echo   Stop Strata
echo ==================================================
echo.

REM ---- 1. kill the engine window by its title ----------------
taskkill /f /fi "WINDOWTITLE eq Strata %STRATA_PROFILE%" >nul 2>&1
taskkill /f /fi "WINDOWTITLE eq Strata Engine" >nul 2>&1

REM ---- 2. kill whatever holds the engine port ----------------
call :kill_port %STRATA_PORT% "Strata engine"

REM ---- 3. kill whatever holds the web UI port ----------------
call :kill_port %WEB_PORT% "WebUI server"

echo.
echo   Done. Ports %STRATA_PORT% and %WEB_PORT% should be free now.
echo.
timeout /t 3 /nobreak >nul
exit /b 0

REM ============================================================
REM  %1 = port, %2 = label
REM  Kills only the exact PIDs listening on that port, so an
REM  unrelated python.exe is never touched.
REM ============================================================
:kill_port
set "FOUND="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:"LISTENING" ^| findstr /c:":%~1 "') do (
    if not "%%P"=="0" (
        set "FOUND=1"
        echo   Stopping %~2 - PID %%P
        taskkill /f /pid %%P >nul 2>&1
    )
)
if not defined FOUND echo   Nothing listening on port %~1.
exit /b 0
