@echo off
chcp 65001 >nul
set NODE_OPTIONS=
title Rebuild Desktop Shortcuts
set "NODE_EXE=node"
if exist "%~dp0node\node.exe" set "NODE_EXE=%~dp0node\node.exe"
set "SCRIPT=%~dp0make-shortcuts.mjs"
if not exist "%SCRIPT%" set "SCRIPT=%~dp0scripts\make-shortcuts.mjs"
echo.
"%NODE_EXE%" "%SCRIPT%"
echo.
pause
