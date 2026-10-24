@echo off
setlocal
title Strata WebUI

set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"

if not exist "%ROOT%\config\resolve.bat" (
    echo [ERROR] config\resolve.bat not found. Is the repo complete?
    pause
    exit /b 1
)
call "%ROOT%\config\resolve.bat"

REM ---- log file (from LOG_DIR, see config\paths.bat) ----------
set "LOGFILE=%WEBUI_LOG%"
if not defined LOG_READY set "LOGFILE=%TEMP%\strata-webui.log"

call "%ROOT%\config\prune-logs.bat"

echo ==================================================
echo   Strata WebUI  -  live streaming chat + folder upload
echo ==================================================
echo.

if not exist "%ROOT%\webui\server.py" (
    echo   [ERROR] webui\server.py not found.
    pause
    exit /b 1
)

if not defined PYTHON_EXE (
    echo   [ERROR] Python not found.
    echo           Run setup.bat, or set PYTHON_EXE in config\paths.bat
    pause
    exit /b 1
)

echo ===== webui launcher start %DATE% %TIME% ===== > "%LOGFILE%" 2>&1
echo       python : %PYTHON_EXE%
echo       server : %ROOT%\webui\server.py
echo       port   : %WEB_PORT%
echo.

echo [1/3] Checking the Strata model service on port %STRATA_PORT% ...
call :probe_health
if errorlevel 1 goto strata_off
echo       Strata is online.
goto step2

:strata_off
echo.
echo   [WARN] Strata is NOT answering on port %STRATA_PORT%.
echo          Start it first with  launchers\Start-Strata.bat
echo          otherwise the chat page has nothing to talk to.
echo.
echo   Press any key to continue anyway ...
pause >nul
echo [WARN] strata offline >> "%LOGFILE%" 2>&1

:step2
echo.
echo [2/3] Starting the web server on port %WEB_PORT% ...
start "" cmd /c "timeout /t 4 /nobreak >nul & start http://127.0.0.1:%WEB_PORT%"
echo       the browser will open shortly.

echo.
echo [3/3] Web UI address:  http://127.0.0.1:%WEB_PORT%
echo.
echo   Keep this window open. Closing it stops the web server.
echo   Press Ctrl+C to stop.
echo.

set "STRATA_BASE_URL=http://127.0.0.1:%STRATA_PORT%/v1"
set "STRATA_WEB_HOST=127.0.0.1"
set "STRATA_WEB_PORT=%WEB_PORT%"

"%PYTHON_EXE%" "%ROOT%\webui\server.py"
set "RC=%ERRORLEVEL%"

echo.
echo Web server stopped with code %RC%.
echo   server exit code %RC% >> "%LOGFILE%" 2>&1
echo.
pause
exit /b 0

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
