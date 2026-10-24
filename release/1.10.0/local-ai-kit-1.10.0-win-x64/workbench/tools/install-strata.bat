@echo off
setlocal EnableDelayedExpansion

REM ============================================================
REM  tools\install-strata.bat
REM  Windows installer for the Strata engine + Qwen3.8 model pack.
REM
REM  WHY THIS SCRIPT EXISTS
REM  ----------------------
REM  The upstream installer calls the *system* Python. If your system
REM  Python lives somewhere read-only (for example C:\Python314) the
REM  install dies with:
REM
REM      PermissionError: [Errno 13] Permission denied:
REM      'C:\Python314\.strata-pip.json'
REM
REM  This wrapper creates a virtual environment inside STRATA_HOME and
REM  runs everything with that interpreter, which avoids the problem.
REM ============================================================

set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"

if not exist "%ROOT%\config\resolve.bat" (
    echo [ERROR] config\resolve.bat not found.
    pause
    exit /b 1
)
call "%ROOT%\config\resolve.bat"

set "LOG_FILE=%INSTALL_LOG%"
if not defined LOG_READY set "LOG_FILE=%STRATA_HOME%\install-strata.log"
set "VENV_PYTHON=%STRATA_HOME%\.venv\Scripts\python.exe"

call "%ROOT%\config\prune-logs.bat"

REM Use the HuggingFace mirror by default -- much faster from mainland China.
REM Comment the next line out if you are outside China.
set "HF_ENDPOINT=https://hf-mirror.com"

REM Make sure an inherited proxy does not hijack localhost traffic.
set "HTTPS_PROXY="
set "HTTP_PROXY="

echo.
echo ============================================
echo   Strata Installer
echo   profile : %STRATA_PROFILE%
echo   engine  : %STRATA_HOME%
echo   data    : %STRATA_DATA%
echo   mirror  : %HF_ENDPOINT%
echo ============================================
echo.

if not exist "%STRATA_HOME%\setup.py" (
    echo [ERROR] Strata source tree not found.
    echo         expected: %STRATA_HOME%\setup.py
    echo.
    echo         Clone it first:
    echo             git clone https://github.com/Niko1221/Strata "%STRATA_HOME%"
    echo         Then set STRATA_HOME in config\paths.bat.
    pause
    exit /b 1
)

cd /d "%STRATA_HOME%"

REM ---- 1. find a bootstrap Python ------------------------------
echo [1/6] Looking for a Python 3.10+ interpreter ...
set "BOOTPY="
py -3 --version >nul 2>&1
if not errorlevel 1 set "BOOTPY=py -3"
if not defined BOOTPY (
    python --version >nul 2>&1
    if not errorlevel 1 set "BOOTPY=python"
)
if not defined BOOTPY (
    echo [ERROR] No Python found. Install Python 3.10+ and retry.
    echo         https://www.python.org/downloads/windows/
    pause
    exit /b 1
)

%BOOTPY% -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python is older than 3.10.
    pause
    exit /b 1
)
echo [OK] bootstrap python: %BOOTPY%

REM ---- 2. virtual environment ---------------------------------
echo.
echo [2/6] Preparing the virtual environment ...
if not exist "%VENV_PYTHON%" (
    echo       creating %STRATA_HOME%\.venv ...
    %BOOTPY% -m venv ".venv"
    if not exist "%VENV_PYTHON%" (
        echo [ERROR] Failed to create the virtual environment.
        pause
        exit /b 1
    )
)
echo [OK] %VENV_PYTHON%

REM ---- 3. install ----------------------------------------------
echo.
echo [3/6] Installing Strata + downloading the model pack ...
echo       Model pack is roughly 68 GB for IQ2_XS. Be patient.
echo       Log: %LOG_FILE%
echo       DO NOT close this window.
echo.

"%VENV_PYTHON%" setup.py --yes ^
    --family qwen ^
    --model %STRATA_PROFILE% ^
    --context 131072 ^
    --vision gpu ^
    --data-dir "%STRATA_DATA%" ^
    --api-key "%STRATA_API_KEY%" ^
    --no-start > "%LOG_FILE%" 2>&1

if errorlevel 1 (
    echo.
    echo ============================================
    echo   [ERROR] Installation failed.
    echo   Last 20 log lines:
    echo ============================================
    powershell -NoProfile -Command "if(Test-Path '%LOG_FILE%'){Get-Content '%LOG_FILE%' -Tail 20}"
    echo.
    echo   See docs\05-troubleshooting.md for known causes.
    pause
    exit /b 1
)

REM ---- 4. verify the launcher config was generated -------------
echo.
echo [4/6] Checking the generated launcher config ...
set "CFG=%STRATA_HOME%\strata-%STRATA_PROFILE%.json"
if exist "%CFG%" (
    echo [OK] %CFG%
) else (
    echo [WARN] %CFG% was not generated.
    echo        run-strata.bat will not work until it exists.
)

REM ---- 5. done -------------------------------------------------
echo.
echo ============================================
echo   [DONE] Strata installed.
echo ============================================
echo.
echo Next steps:
echo   1. Start the engine : launchers\Start-Strata.bat
echo   2. Verify it       : tools\verify.bat
echo   3. Wire up dsh     : docs\03-integrate-dsh.md
echo.
echo [5/6] verifying model files ...
if exist "%STRATA_DATA%\models" (
    powershell -NoProfile -Command "$s=(Get-ChildItem '%STRATA_DATA%\models' -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum; '{0:N1} GB in {1}' -f ($s/1GB), '%STRATA_DATA%\models'"
) else (
    echo [WARN] %STRATA_DATA%\models does not exist.
)

echo.
echo [6/6] all set.
pause
exit /b 0
