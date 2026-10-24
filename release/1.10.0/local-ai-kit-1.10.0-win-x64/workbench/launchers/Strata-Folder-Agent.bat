@echo off
setlocal enabledelayedexpansion
title Strata Folder Agent

set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"

if not exist "%ROOT%\config\resolve.bat" (
    echo [ERROR] config\resolve.bat not found.
    pause
    exit /b 1
)
call "%ROOT%\config\resolve.bat"

echo ==================================================
echo   Strata Folder Agent
echo   Let the local model read (and optionally edit) a folder
echo ==================================================
echo.
echo   Zero dependencies. Talks to Strata over plain HTTP.
echo.
echo   Before you start: the engine must be running.
echo       launchers\Start-Strata.bat
echo.
echo   Tip: you can DRAG a folder from Explorer into this window
echo        instead of typing the path.
echo.

set "TARGET=%~1"
if "%TARGET%"=="" (
    set /p TARGET=Folder path: 
)
set "TARGET=%TARGET:"=%"

if "%TARGET%"=="" (
    echo.
    echo [ERROR] No folder given.
    pause
    exit /b 1
)

if not exist "%TARGET%" (
    echo.
    echo [ERROR] Folder not found: %TARGET%
    pause
    exit /b 1
)

if not defined PYTHON_EXE (
    echo [ERROR] Python not found. Run setup.bat first.
    pause
    exit /b 1
)

set "STRATA_BASE_URL=http://127.0.0.1:%STRATA_PORT%/v1"
set "STRATA_API_KEY=%STRATA_API_KEY%"
set "STRATA_MODEL=qwen3.8-flash-next-%STRATA_PROFILE%"

echo.
echo   folder : %TARGET%
echo   engine : %STRATA_BASE_URL%
echo.

"%PYTHON_EXE%" "%ROOT%\tools\strata-folder-agent.py" "%TARGET%"

echo.
pause
exit /b 0
