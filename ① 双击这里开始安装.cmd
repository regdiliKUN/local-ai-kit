@echo off
setlocal
set NODE_OPTIONS=
title Local AI Setup

rem ===========================================================================
rem  This entry script is deliberately PURE ASCII.
rem  cmd.exe has known bugs with UTF-8 batch files (label/goto misalignment),
rem  so all Chinese guidance is printed by Node / PowerShell instead.
rem  See scripts/installer.mjs (console banner) and scripts/bootstrap.ps1.
rem ===========================================================================

echo.
echo   ============================================================
echo             Local AI Setup is starting, please wait...
echo   ============================================================
echo.
echo   A browser page will open in a moment.
echo   Follow the on-screen steps there (instructions are in Chinese).
echo.
echo   Keep THIS black window open until the setup finishes.
echo.

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
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" goto :failed
goto :end

rem ---- Node.js missing or too old: hand over to the PowerShell helper ----
:bootstrap
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap.ps1" "%~dp0"
goto :end

:failed
echo.
echo   ------------------------------------------------------------
echo   [X] The setup program exited with code %RC%.
echo       See the messages printed above.
echo.
echo   [X] A log file was saved to:
echo       %TEMP%\localai-setup.log
echo       Send that file to whoever is helping you.
echo   ------------------------------------------------------------
goto :end

:end
echo.
echo   You can close this window now.
echo.
pause
