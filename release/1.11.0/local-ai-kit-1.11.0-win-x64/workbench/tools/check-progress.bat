@echo off
setlocal EnableDelayedExpansion
title Strata Install Progress Monitor

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
set "TOTAL_GB=68"

:refresh
cls
echo ============================================
echo   Strata Install Progress Monitor
echo   profile: %STRATA_PROFILE%   total: about %TOTAL_GB% GB
echo ============================================
echo.

if not exist "%LOG_FILE%" (
    echo [INFO] No install log yet at:
    echo        %LOG_FILE%
    echo.
    echo        Run  tools\install-strata.bat  first.
    echo.
    pause
    exit /b 0
)

echo [Log tail]
echo --------------------------------------------
powershell -NoProfile -Command "Get-Content '%LOG_FILE%' -Tail 20"
echo --------------------------------------------
echo.

echo [Model files in %STRATA_DATA%\models]
if exist "%STRATA_DATA%\models" (
    powershell -NoProfile -Command "$s=(Get-ChildItem '%STRATA_DATA%\models' -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum; $gb=$s/1GB; $p=[Math]::Min(100,[Math]::Round($gb/%TOTAL_GB%*100,1)); '{0:N2} GB downloaded  ({1}% of ~%TOTAL_GB% GB)' -f $gb,$p; $bar=[Math]::Floor($p/2); Write-Host ('#'*$bar) + ('.'*(50-$bar))"
) else (
    echo   model directory not created yet.
)

echo.
echo ============================================
echo   Press any key to refresh, or close to exit.
pause >nul
goto refresh
