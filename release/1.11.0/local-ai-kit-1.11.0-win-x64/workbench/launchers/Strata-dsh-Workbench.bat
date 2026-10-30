@echo off
setlocal enabledelayedexpansion
title Strata + DeepSeek Harness Workbench

set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"

REM ---- load configuration -------------------------------------
if not exist "%ROOT%\config\resolve.bat" (
    echo [ERROR] config\resolve.bat not found. Is the repo complete?
    pause
    exit /b 1
)
call "%ROOT%\config\resolve.bat"

REM ---- log file -----------------------------------------------
REM  The path comes from LOG_DIR (config\paths.bat), so a
REM  double-click never drops a log next to this script.
REM  Falls back to %TEMP% if the log directory could not be made.
set "LOGFILE=%LAUNCH_LOG%"
if not defined LOG_READY set "LOGFILE=%TEMP%\strata-workbench.log"

call "%ROOT%\config\prune-logs.bat"

echo ===== workbench launcher start %DATE% %TIME% ===== > "%LOGFILE%" 2>&1

echo ==================================================
echo   Strata + DeepSeek Harness   WORKBENCH
echo ==================================================
echo.
echo   Model layer : Strata  %STRATA_PROFILE%  -  local 125B MoE
echo   Agent layer : DeepSeek Harness  -  files / shell / subagents
echo.
echo   This launcher starts Strata ONLY, never Ollama.
echo   Ollama and Strata cannot hold the GPU at the same time.
echo.

echo [0/3] Preflight checks ...
set "FAILED="

if not exist "%STRATA_SERVER%" (
    echo   [ERROR] Strata engine not found.
    echo           expected: %STRATA_SERVER%
    set "FAILED=1"
)

if not exist "%DSH_BIN%" (
    echo   [ERROR] DeepSeek Harness not found.
    echo           expected: %DSH_BIN%
    set "FAILED=1"
)

if not defined PYTHON_EXE (
    echo   [ERROR] Python not found.
    set "FAILED=1"
)

if defined FAILED goto hint

"%NODE_EXE%" --version >nul 2>&1
if errorlevel 1 (
    echo   [ERROR] Node.js not runnable via "%NODE_EXE%".
    set "FAILED=1"
    goto hint
)

echo       Strata  : %STRATA_HOME%
echo       Data    : %STRATA_DATA%
echo       dsh     : %DSH_DIR%
echo       node    : %NODE_EXE%
echo       log     : %LOGFILE%
echo.
goto preflight_ok

:hint
echo.
echo   ------------------------------------------------------------
echo    Fix: run  setup.bat  in the repo root to auto-detect paths,
echo    or edit  config\paths.bat  by hand.
echo   ------------------------------------------------------------
echo [FATAL] preflight failed >> "%LOGFILE%" 2>&1
echo.
pause
exit /b 1

:preflight_ok
echo [1/3] Starting the Strata engine ...
echo [1/3] starting strata >> "%LOGFILE%" 2>&1
start "Strata Engine" "%ROOT%\tools\run-strata.bat"
echo       launched in a separate window.

echo.
echo [2/3] Waiting for Strata to become ready on port %STRATA_PORT% ...
echo       The first model load takes roughly 1-3 minutes.
echo [2/3] waiting >> "%LOGFILE%" 2>&1

set /a N=0
:waitloop
ping -n 6 127.0.0.1 >nul 2>&1
set /a N+=1
call :probe_health
if not errorlevel 1 goto ready
if !N! GEQ 60 goto timeout
echo       ... loading, about !N!0 seconds elapsed
goto waitloop

:timeout
echo.
echo   [WARN] Strata was not ready after 10 minutes.
echo          Look at the "Strata Engine" window for the real error.
echo          Starting dsh anyway.
echo [WARN] timeout >> "%LOGFILE%" 2>&1
echo.
goto startdsh

:ready
echo.
echo       Strata is READY.
echo [OK] strata ready >> "%LOGFILE%" 2>&1
echo.

:startdsh
echo [3/3] Starting the DeepSeek Harness web GUI ...
echo.
echo   ------------------------------------------------------------
echo    In the dsh UI open  Settings - Models  and select:
echo.
echo        Strata Local  (Qwen3.8-Flash-Next 125B MoE)
echo.
echo    Do NOT pick qwen3.8:27b -- that is the Ollama model and
echo    Ollama is not running. Symptom of getting this wrong:
echo    "socket stream idle timeout after 300000ms".
echo   ------------------------------------------------------------
echo.
echo   Keep this window open. Closing it stops dsh.
echo.
echo [3/3] starting dsh >> "%LOGFILE%" 2>&1

cd /d "%DSH_DIR%"
"%NODE_EXE%" "%DSH_BIN%" web
set "RC=%ERRORLEVEL%"

echo.
echo dsh exited with code %RC%.
echo   dsh exit code %RC% >> "%LOGFILE%" 2>&1
echo.
pause
exit /b 0

REM ============================================================
REM  Health probe. Uses curl when available, PowerShell otherwise.
REM  Returns 0 when Strata answers, 1 otherwise.
REM ============================================================
:probe_health
if defined PROBE_IS_PS goto probe_ps

curl --version >nul 2>&1
if errorlevel 1 goto set_ps

curl -s -m 3 --noproxy "*" "%STRATA_HEALTH%" >nul 2>&1
exit /b %ERRORLEVEL%

:set_ps
set "PROBE_IS_PS=1"

:probe_ps
powershell -NoProfile -Command "try{ $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 '%STRATA_HEALTH%'; if($r.StatusCode -eq 200){exit 0}else{exit 1} }catch{ exit 1 }" >nul 2>&1
exit /b %ERRORLEVEL%
