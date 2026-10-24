@echo off
setlocal enabledelayedexpansion
title Start Strata

set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"

if not exist "%ROOT%\config\resolve.bat" (
    echo [ERROR] config\resolve.bat not found.
    pause
    exit /b 1
)
call "%ROOT%\config\resolve.bat"

echo ==================================================
echo   Start the Strata engine
echo ==================================================
echo.
echo   profile : %STRATA_PROFILE%
echo   port    : %STRATA_PORT%
echo   home    : %STRATA_HOME%
echo.

if not exist "%STRATA_SERVER%" (
    echo   [ERROR] Strata not found. Run setup.bat first.
    pause
    exit /b 1
)

echo   Checking whether the port is already in use ...
call :port_busy
if not errorlevel 1 (
    echo   [WARN] Something is already listening on port %STRATA_PORT%.
    echo          If that is Strata, just open:
    echo              http://127.0.0.1:%STRATA_PORT%
    echo          To restart it, run  launchers\Stop-Strata.bat  first.
    echo.
    pause
    exit /b 0
)

echo   Starting Strata in a new window ...
start "Strata Engine" "%ROOT%\tools\run-strata.bat" --open

echo.
echo   Strata is loading. The browser opens as soon as it is ready.
echo   Health check: http://127.0.0.1:%STRATA_PORT%/health
echo.
timeout /t 5 /nobreak >nul
exit /b 0

REM ============================================================
:port_busy
netstat -ano | findstr /r /c:"LISTENING" | findstr /c:":%STRATA_PORT% " >nul 2>&1
exit /b %ERRORLEVEL%
