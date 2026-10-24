@echo off
setlocal EnableExtensions
set NODE_OPTIONS=
title Local AI Setup

rem ===========================================================================
rem  This entry script is deliberately PURE ASCII with CRLF line endings.
rem  cmd.exe mis-parses UTF-8 / LF-only batch files (label and goto
rem  misalignment), so every Chinese message is printed by Node or by
rem  PowerShell instead. See scripts/installer.mjs and scripts/bootstrap.ps1.
rem
rem  Fixed 2026-10-15. What changed vs the old entry script:
rem   1) "node exists" is no longer trusted. We now require "node -v" to
rem      actually succeed before we believe Node.js is usable.
rem   2) Microsoft Store "app execution aliases" (0-byte stubs under
rem      %LOCALAPPDATA%\Microsoft\WindowsApps) are skipped. "where node"
rem      finds them, but running them prints
rem      "'node' is not recognized as an internal or external command".
rem   3) the "if not defined MAJOR" guard now runs BEFORE the "%MAJOR:v=%"
rem      substitution. The old order turned an empty version into the
rem      literal string "v=", which is NOT empty, so the guard was defeated
rem      and the script fell through to a bare "node ..." call and died.
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

rem ---- 1. find a Node.js that can actually RUN ----
set "NODE_EXE="

rem 1a) portable node shipped inside this folder
if exist "%~dp0node\node.exe" set "NODE_EXE=%~dp0node\node.exe"

rem 1b) the official installer locations
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

rem 1c) whatever "node" resolves to on PATH - but only if it really runs
if not defined NODE_EXE for /f "delims=" %%p in ('where node 2^>nul') do call :try_node "%%p"

rem 1d) read the major version; "no usable version" means "no usable Node.js"
set "MAJOR="
if defined NODE_EXE for %%d in ("%NODE_EXE%") do set "PATH=%%~dpd;%PATH%"
if defined NODE_EXE for /f "tokens=1 delims=." %%v in ('node -v 2^>nul') do set "MAJOR=%%v"
if not defined MAJOR goto :bootstrap
set "MAJOR=%MAJOR:v=%"
if not defined MAJOR goto :bootstrap
if %MAJOR% LSS 20 goto :bootstrap

rem ---- 2. normal path: launch the graphical installer ----
"%NODE_EXE%" "%~dp0scripts\installer.mjs"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" goto :failed
goto :end

rem ---- helpers ----
:try_node
if defined NODE_EXE exit /b 0
set "CAND=%~1"
if not exist "%CAND%" exit /b 0
for %%s in ("%CAND%") do if %%~zs EQU 0 exit /b 0
"%CAND%" -v >nul 2>nul || exit /b 0
set "NODE_EXE=%CAND%"
exit /b 0

rem ---- Node.js missing or too old: hand over to the PowerShell helper ----
rem      NOTE: pass "%~dp0." not "%~dp0" - the trailing backslash of %~dp0
rem      would escape the closing quote and the path would arrive with a
rem      stray quote, making bootstrap.ps1 unable to find its scripts.
:bootstrap
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap.ps1" "%~dp0."
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
