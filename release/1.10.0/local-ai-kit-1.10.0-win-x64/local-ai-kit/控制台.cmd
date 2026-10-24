@echo off
chcp 65001 >nul
set NODE_OPTIONS=
title Local AI Console
set "NODE_EXE=node"
if exist "%~dp0node\node.exe" set "NODE_EXE=%~dp0node\node.exe"
set "SCRIPT=%~dp0console.mjs"
if not exist "%SCRIPT%" set "SCRIPT=%~dp0scripts\console.mjs"
echo.
"%NODE_EXE%" "%SCRIPT%"
echo.
pause
