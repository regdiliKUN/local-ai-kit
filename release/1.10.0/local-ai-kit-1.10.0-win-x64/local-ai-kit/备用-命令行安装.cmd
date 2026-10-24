@echo off
setlocal EnableExtensions
chcp 65001 >nul
set NODE_OPTIONS=
title Local AI Setup (Console)

rem ===========================================================================
rem  Console install mode - same engine as the GUI wizard, no browser needed.
rem  Handy for scripts, automation and remote sessions.
rem
rem  This entry script is deliberately PURE ASCII with CRLF line endings.
rem  cmd.exe mis-parses UTF-8 / LF-only batch files (label and goto
rem  misalignment), so every Chinese message is printed by Node or by
rem  PowerShell instead.
rem
rem  Fixed in v1.3.3:
rem   1) node detection now requires "node -v" to really succeed, so a
rem      0-byte Microsoft Store app-execution alias (or any other bogus
rem      "node") can no longer fool us into calling a bare "node ...",
rem      which used to die with "'node' is not recognized".
rem   2) the kit folder is now passed as "%~dp0." - passing "%~dp0" lets the
rem      trailing backslash escape the closing quote, so bootstrap.ps1
rem      received a path with a stray quote and could not find its scripts.
rem ===========================================================================

echo.
echo   ============================================================
echo          Local AI Setup - console mode (no GUI)
echo   ============================================================
echo.
echo   Same engine as the graphical wizard, driven from this window.
echo   The prompts and messages below are in Chinese.
echo.
echo   For the graphical wizard instead, run the other entry script
echo   in this folder (the one starting with a circled digit 1).
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

rem ---- 2. normal path: run the console installer ----
"%NODE_EXE%" "%~dp0scripts\setup.mjs"
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
rem      It explains the situation in Chinese, downloads and installs Node.js,
rem      then continues with the console installer (scripts\setup.mjs).
rem      NOTE: pass "%~dp0." not "%~dp0" - see the note at the top of this file.
:bootstrap
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap.ps1" "%~dp0." "scripts\setup.mjs"

:end
echo.
pause
