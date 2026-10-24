@echo off
REM ============================================================
REM  config\prune-logs.bat
REM
REM  Deletes *.log files in LOG_DIR that are older than
REM  LOG_KEEP_DAYS days. Launchers call this once per start so the
REM  log directory never grows without bound.
REM
REM  Both variables come from config\resolve.bat.
REM  Set LOG_KEEP_DAYS=0 in config\paths.bat to keep everything.
REM
REM  USAGE:
REM      call "%ROOT%\config\prune-logs.bat"
REM ============================================================

if not defined LOG_KEEP_DAYS exit /b 0
if "%LOG_KEEP_DAYS%"=="0" exit /b 0
if not defined LOG_DIR exit /b 0
if not exist "%LOG_DIR%" exit /b 0

REM forfiles is shipped with Windows 7 and later.
REM   /d -N  means "last modified N or more days ago"
forfiles /p "%LOG_DIR%" /m *.log /d -%LOG_KEEP_DAYS% /c "cmd /c del /q @path" >nul 2>&1

exit /b 0
