@echo off
setlocal enabledelayedexpansion

REM ============================================================
REM  tools\run-strata.bat
REM  Launches the Strata inference engine with the profile picked
REM  in config\paths.bat (STRATA_PROFILE).
REM
REM  This is the actual engine process. Launchers start it with
REM  a window title of "Strata Engine"; this script then renames
REM  the window to "Strata <profile>" so Stop-Strata.bat and the
REM  taskkill window-title filter can find it.
REM ============================================================

set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"

if not exist "%ROOT%\config\resolve.bat" (
    echo [ERROR] config\resolve.bat not found.
    pause
    exit /b 1
)
call "%ROOT%\config\resolve.bat"

set "OPEN_BROWSER=%1"

if not exist "%STRATA_SERVER%" (
    echo [ERROR] Strata engine not found at:
    echo         %STRATA_SERVER%
    echo         Run setup.bat or edit config\paths.bat
    pause
    exit /b 1
)

if not exist "%STRATA_VENV%" (
    echo [ERROR] Strata virtual environment not found:
    echo         %STRATA_VENV%
    echo         Run  tools\install-strata.bat  first.
    pause
    exit /b 1
)

set "CFG=%STRATA_HOME%\strata-%STRATA_PROFILE%.json"
if not exist "%CFG%" (
    echo [ERROR] Profile config not found:
    echo         %CFG%
    echo.
    echo         Available profiles in %STRATA_HOME%:
    dir /b "%STRATA_HOME%\strata-*.json" 2>nul
    echo.
    echo         Set STRATA_PROFILE in config\paths.bat to one of the above.
    pause
    exit /b 1
)

title Strata %STRATA_PROFILE%

echo ==================================================
echo   Strata engine
echo --------------------------------------------------
echo   profile : %STRATA_PROFILE%
echo   config  : %CFG%
echo   port    : %STRATA_PORT%
echo   data    : %STRATA_DATA%
echo ==================================================
echo.

REM ---- VRAM preflight ----------------------------------------
REM  Why this exists: Strata's default --vram-reserve-mib is 700.
REM  On a card that also drives the desktop that is far too little.
REM  WDDM does not fail on an over-committed allocation -- it pages
REM  VRAM to system RAM, so the start looks normal and only the
REM  speed collapses. Requests then never finish and the process
REM  can be killed. See docs\05-troubleshooting.md.
call :check_vram
if defined VRAM_LOW goto vram_warn
goto vram_ok

:vram_warn
echo.
echo   [FATAL] Only %VRAM_FREE% MiB of VRAM is free right now.
echo           Strata needs 3000+ MiB free AFTER loading, otherwise WDDM
echo           silently pages VRAM to system RAM: startup looks normal and
echo           only the speed collapses (requests never finish).
echo.
echo   Fix:  ollama stop ^<model^>      (Ollama + Strata cannot share the card)
echo         close browsers / wallpaper engine / recording tools
echo         or raise the reserve:  python tools\fix-vram-reserve.py --apply
echo.
echo   Refusing to start. This is deliberate: a warning was ignored before
echo   and the engine ran at 1/3 speed for hours.
echo.
pause
exit /b 1

:vram_ok
echo   Loading the model. First token can take 1-3 minutes.
echo   Watch this window for errors. Ctrl+C to stop.
echo.

cd /d "%STRATA_HOME%"

if /i "%OPEN_BROWSER%"=="--open" goto with_open

"%STRATA_VENV%" "%STRATA_HOME%\serve\server.py" --engine strata --config "%CFG%" --port %STRATA_PORT%
goto done

:with_open
"%STRATA_VENV%" "%STRATA_HOME%\serve\server.py" --engine strata --config "%CFG%" --port %STRATA_PORT% --open
goto done

:done
set "RC=%ERRORLEVEL%"
echo.
echo Strata exited with code %RC%.
if not "%RC%"=="0" (
    echo.
    echo   Common causes:
    echo     - Out of VRAM: another engine such as Ollama still holds the GPU.
    echo       Stop it with  ollama stop  or the Ollama tray icon.
    echo     - The desktop filled the card: raise the reserve with
    echo           python tools\fix-vram-reserve.py --apply
    echo     - Wrong profile: check STRATA_PROFILE in config\paths.bat
    echo     - Missing pack:   check STRATA_DATA in config\paths.bat
    echo   Full log: %STRATA_HOME%\strata-%STRATA_PROFILE%.log
)
echo.
pause
exit /b %RC%

REM ============================================================
REM  Reads free VRAM via nvidia-smi.
REM  Sets VRAM_FREE (MiB) and VRAM_LOW=1 when below the safe floor.
REM  Silently does nothing when nvidia-smi is unavailable.
REM ============================================================
:check_vram
set "VRAM_FREE="
set "VRAM_LOW="
for /f "tokens=*" %%A in ('nvidia-smi "--query-gpu=memory.free" "--format=csv,noheader,nounits" 2^>nul') do set "VRAM_FREE=%%A"
if not defined VRAM_FREE exit /b 0
set /a VRAM_N=0
for /f "delims=" %%A in ("%VRAM_FREE%") do set /a VRAM_N=%%A 2>nul
if %VRAM_N% LSS 3000 set "VRAM_LOW=1"
exit /b 0
