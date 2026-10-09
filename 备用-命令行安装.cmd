@echo off
chcp 65001 >nul
set NODE_OPTIONS=
title Local AI Setup (Console)
echo.
echo   命令行安装模式（没有图形界面，适合脚本/自动化）
echo.
node "%~dp0scripts\setup.mjs"
echo.
pause
