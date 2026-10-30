@echo off
setlocal enabledelayedexpansion
title Strata + dsh Verification

set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"

set "PASS=0"
set "FAIL=0"
set "WARN=0"

echo ==================================================
echo   strata-dsh-workbench  -  environment verification
echo ==================================================
echo.

if not exist "%ROOT%\config\resolve.bat" (
    echo [ERROR] config\resolve.bat not found.
    pause
    exit /b 1
)
call "%ROOT%\config\resolve.bat"

REM ---- 1. resolved paths -------------------------------------
echo [1] Paths
call :chk_path "STRATA_HOME" "%STRATA_HOME%"
call :chk_file "Strata server.py" "%STRATA_SERVER%"
call :chk_file "Strata venv python" "%STRATA_VENV%"
call :chk_dir  "Strata data dir" "%STRATA_DATA%"
call :chk_file "dsh bin.js" "%DSH_BIN%"
call :chk_cmd  "Node.js" "%NODE_EXE% --version"
call :chk_cmd  "Python" "%PYTHON_EXE% --version"
echo.

REM ---- 2. model files ----------------------------------------
echo [2] Model files
call :chk_file "launcher config" "%STRATA_HOME%\strata-%STRATA_PROFILE%.json"
if exist "%STRATA_DATA%\models" (
    call :ok "model directory exists"
) else (
    call :bad "model directory missing: %STRATA_DATA%\models"
)
if exist "%STRATA_HOME%\engine\strata.exe" (
    call :ok "engine binary present"
) else (
    call :bad "engine binary missing: %STRATA_HOME%\engine\strata.exe"
)
echo.

REM ---- 3. live engine ----------------------------------------
echo [3] Live engine on port %STRATA_PORT%
call :probe_health
if errorlevel 1 (
    call :warn "Strata is not running (start it, then re-run this script)"
) else (
    call :ok "health endpoint answered"

    call :http "%STRATA_BASE_URL%/models" "models endpoint"
    call :http "%STRATA_BASE_URL%/chat/completions" "chat endpoint" POST
)
echo.

REM ---- 4. dsh integration ------------------------------------
echo [4] DeepSeek Harness integration
set "PROFILE_DIR=%USERPROFILE%\.dsh\profiles\web"
if exist "%PROFILE_DIR%\cordis.patch.yml" (
    call :ok "found %PROFILE_DIR%\cordis.patch.yml"
    findstr /c:"strata-local" "%PROFILE_DIR%\cordis.patch.yml" >nul 2>&1
    if errorlevel 1 (
        call :warn "provider 'strata-local' NOT present -- see docs\03-integrate-dsh.md"
    ) else (
        call :ok "provider 'strata-local' is registered"
    )
) else (
    call :warn "no dsh web profile found at %PROFILE_DIR%"
)

if exist "%USERPROFILE%\.dsh\.credentials.yaml" (
    findstr /c:"STRATA_API_KEY" "%USERPROFILE%\.dsh\.credentials.yaml" >nul 2>&1
    if errorlevel 1 (
        call :warn "STRATA_API_KEY missing from .credentials.yaml"
    ) else (
        call :ok "STRATA_API_KEY is present in .credentials.yaml"
    )
) else (
    call :warn "no .credentials.yaml found"
)
echo.

REM ---- 5. WebUI ----------------------------------------------
echo [5] WebUI
call :chk_file "webui/server.py" "%ROOT%\webui\server.py"
call :chk_file "webui/index.html" "%ROOT%\webui\index.html"
echo.

REM ---- 6. Logs -----------------------------------------------
echo [6] Log directory
call :chk_path "LOG_DIR" "%LOG_DIR%"
if defined LOG_READY (
    call :ok "log directory exists and is writable"
) else (
    call :warn "log directory could not be created -- launchers fall back to %TEMP%"
)
echo       workbench.log      -> %LAUNCH_LOG%
echo       webui.log          -> %WEBUI_LOG%
echo       install-strata.log -> %INSTALL_LOG%
echo       keep for           -> %LOG_KEEP_DAYS% day(s)
echo.

REM ---- 7. Engine log -----------------------------------------
echo [7] Engine log (set inside the Strata config JSON)
set "ENGINE_LOG="
if exist "%STRATA_HOME%\strata-%STRATA_PROFILE%.json" (
    for /f "usebackq tokens=2 delims=:" %%L in (`findstr /c:"\"log\":" "%STRATA_HOME%\strata-%STRATA_PROFILE%.json"`) do set "ENGINE_LOG=%%L"
)
if defined ENGINE_LOG (
    echo       %ENGINE_LOG%
) else (
    echo       not found
)
echo       move it with:  python tools\set-log-dir.py --apply
echo.

echo ==================================================
echo   RESULT:  %PASS% passed   %WARN% warnings   %FAIL% failed
echo ==================================================
if not "%FAIL%"=="0" (
    echo.
    echo   Something is broken. See docs\05-troubleshooting.md
)
echo.
pause
exit /b %FAIL%

REM ============================================================
REM  helpers
REM ============================================================
:ok
echo   [ OK ]  %~1
set /a PASS+=1
exit /b 0

:bad
echo   [FAIL]  %~1
set /a FAIL+=1
exit /b 0

:warn
echo   [WARN]  %~1
set /a WARN+=1
exit /b 0

:chk_path
if "%~2"=="" (
    call :bad "%~1 is not resolved"
) else (
    call :ok "%~1 = %~2"
)
exit /b 0

:chk_file
if exist "%~2" (
    call :ok "%~1"
) else (
    call :bad "%~1 missing: %~2"
)
exit /b 0

:chk_dir
if exist "%~2" (
    call :ok "%~1"
) else (
    call :bad "%~1 missing: %~2"
)
exit /b 0

:chk_cmd
%~2 >nul 2>&1
if errorlevel 1 (
    call :bad "%~1 not runnable"
) else (
    call :ok "%~1"
)
exit /b 0

:probe_health
if defined PROBE_IS_PS goto vp_ps
curl --version >nul 2>&1
if errorlevel 1 goto vp_setps
curl -s -m 4 --noproxy "*" "%STRATA_HEALTH%" >nul 2>&1
exit /b %ERRORLEVEL%
:vp_setps
set "PROBE_IS_PS=1"
:vp_ps
powershell -NoProfile -Command "try{ $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 4 '%STRATA_HEALTH%'; if($r.StatusCode -ne 200){exit 1} }catch{ exit 1 }" >nul 2>&1
exit /b %ERRORLEVEL%

REM  %1 = url, %2 = label, %3 = method (default GET)
:http
set "M=%~3"
if "%M%"=="" set "M=GET"
powershell -NoProfile -Command ^
  "$h=@{'Authorization'='Bearer %STRATA_API_KEY%'};" ^
  "try{" ^
  "  $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 -Method %M% -Headers $h -Uri '%1';" ^
  "  if($r.StatusCode -eq 200){ exit 0 } else { exit 1 }" ^
  "}catch{ exit 1 }" >nul 2>&1
if errorlevel 1 (
    call :warn "%~2 did not answer 200"
) else (
    call :ok "%~2 answered 200"
)
exit /b 0
