@echo off
chcp 65001 >nul
set NODE_OPTIONS=
title Stop Local AI
set "NODE_EXE=node"
if exist "%~dp0node\node.exe" set "NODE_EXE=%~dp0node\node.exe"
set "SCRIPT=%~dp0stop-local-ai.mjs"
if not exist "%SCRIPT%" set "SCRIPT=%~dp0scripts\stop-local-ai.mjs"
echo.
"%NODE_EXE%" "%SCRIPT%"
echo.
pause
