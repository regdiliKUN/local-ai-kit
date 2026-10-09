@echo off
chcp 65001 >nul
setlocal
set NODE_OPTIONS=
title Local AI Setup (Console)
echo.
echo   命令行安装模式（没有图形界面，适合脚本/自动化）
echo.

rem 优先用部署包自带的便携 Node，其次用系统里装的
if exist "%~dp0node\node.exe" set "PATH=%~dp0node;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
    echo   没有找到 Node.js。
    echo   请先双击「① 双击这里开始安装.cmd」，它会自动帮你装好 Node.js；
    echo   或者到 https://nodejs.org 下载 LTS 版本安装后再运行本文件。
    echo.
    pause
    exit /b 1
)

node "%~dp0scripts\setup.mjs"
echo.
pause
