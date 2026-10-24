@echo off
REM ============================================================
REM  config\resolve.bat
REM  Loads config\paths.bat, then auto-detects anything missing.
REM
REM  USAGE (from any launcher):
REM      call "%~dp0..\config\resolve.bat"
REM      if errorlevel 1 goto fatal
REM
REM  NOTE: deliberately does NOT call setlocal, so the variables
REM  it resolves stay visible to the caller.
REM ============================================================

set "WORKBENCH_ROOT=%~dp0.."
for %%I in ("%WORKBENCH_ROOT%") do set "WORKBENCH_ROOT=%%~fI"

REM ---- 1. load user config (optional) -------------------------
if exist "%~dp0paths.bat" call "%~dp0paths.bat"

REM ---- 2. defaults for anything still unset -------------------
if not defined STRATA_PORT  set "STRATA_PORT=8080"
if not defined WEB_PORT     set "WEB_PORT=8090"
if not defined STRATA_API_KEY set "STRATA_API_KEY=sk-local-qwen"
if not defined STRATA_PROFILE set "STRATA_PROFILE=iq2_xs"
if not defined NODE_EXE     set "NODE_EXE=node"

REM ============================================================
REM  AUTO-DETECT: Strata engine
REM ============================================================
call :check_strata "%STRATA_HOME%"
if not errorlevel 1 goto strata_done

for %%D in (
    "%WORKBENCH_ROOT%\..\Strata"
    "F:\Strata"
    "E:\Strata"
    "D:\Strata"
    "C:\Strata"
    "%USERPROFILE%\Strata"
    "%USERPROFILE%\Downloads\Strata"
    "D:\AI\Strata"
    "E:\AI\Strata"
    "F:\AI\Strata"
) do (
    call :check_strata "%%~D"
    if not errorlevel 1 goto strata_done
)

:strata_done

REM ============================================================
REM  AUTO-DETECT: Strata data
REM ============================================================
call :check_data "%STRATA_DATA%"
if not errorlevel 1 goto data_done

for %%D in (
    "F:\Strata-data"
    "E:\Strata-data"
    "D:\Strata-data"
    "C:\Strata-data"
    "%USERPROFILE%\Strata-data"
) do (
    call :check_data "%%~D"
    if not errorlevel 1 goto data_done
)

:data_done

REM ============================================================
REM  AUTO-DETECT: Node.js
REM ============================================================
"%NODE_EXE%" --version >nul 2>&1
if not errorlevel 1 goto node_done

if exist "%ProgramFiles%\nodejs\node.exe"                set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if exist "%ProgramFiles(x86)%\nodejs\node.exe"           set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe"       set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if exist "%APPDATA%\nvm\current\node.exe"                set "NODE_EXE=%APPDATA%\nvm\current\node.exe"

:node_done

REM ============================================================
REM  AUTO-DETECT: DeepSeek Harness
REM  ----------------------------------------------------------
REM  DSH_DIR is the INSTALL directory (where bin.js lives).
REM  It is deliberately NOT called DSH_HOME: dsh itself reads the
REM  environment variable DSH_HOME to locate its state directory
REM  (profiles, credentials, sessions). Exporting an install path
REM  as DSH_HOME makes dsh create a second, empty home there and
REM  silently ignore the user's real configuration.
REM ============================================================
call :check_dsh "%DSH_DIR%"
if not errorlevel 1 goto dsh_done

REM Backward compatibility with old config\paths.bat files that
REM used DSH_HOME for the install path.
call :check_dsh "%DSH_HOME%"
if not errorlevel 1 goto dsh_done

for %%D in (
    "%USERPROFILE%\dsh-runtime"
    "%LOCALAPPDATA%\dsh-runtime"
    "C:\dsh-runtime"
    "D:\dsh-runtime"
    "%APPDATA%\npm"
    "%ProgramFiles%\dsh-runtime"
) do (
    call :check_dsh "%%~D"
    if not errorlevel 1 goto dsh_done
)

:dsh_done

REM dsh's own state directory. Point it at the real home so the
REM profiles and credentials the user configured are the ones used.
REM An old paths.bat that used DSH_HOME for the install path is
REM detected and discarded here.
if defined DSH_DIR if /i "%DSH_HOME%"=="%DSH_DIR%" set "DSH_HOME="
if not defined DSH_HOME set "DSH_HOME=%USERPROFILE%\.dsh"

REM ============================================================
REM  AUTO-DETECT: Python
REM ============================================================
call :check_py "%PYTHON_EXE%"
if not errorlevel 1 goto py_done

call :check_py "%STRATA_HOME%\.venv\Scripts\python.exe"
if not errorlevel 1 goto py_done

REM WorkBuddy managed Python runtimes, when available. These are isolated
REM from the system Python and are preferred as a safe fallback for WebUI.
call :check_py "%USERPROFILE%\.workbuddy-ai\binaries\python\versions\3.13.12\python.exe"
if not errorlevel 1 goto py_done
call :check_py "%USERPROFILE%\.workbuddy-ai\binaries\python\versions\3.14.7\python.exe"
if not errorlevel 1 goto py_done

for %%D in (
    "%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
    "C:\Python313\python.exe"
    "C:\Python312\python.exe"
    "C:\Python311\python.exe"
    "%ProgramFiles%\Python313\python.exe"
    "%ProgramFiles%\Python312\python.exe"
) do (
    call :check_py "%%~D"
    if not errorlevel 1 goto py_done
)

py -3 --version >nul 2>&1
if not errorlevel 1 set "PYTHON_EXE=py -3"

:py_done

REM ============================================================
REM  Derived paths
REM ============================================================
if defined STRATA_HOME set "STRATA_SERVER=%STRATA_HOME%\serve\server.py"
if defined STRATA_HOME set "STRATA_VENV=%STRATA_HOME%\.venv\Scripts\python.exe"
if defined DSH_DIR     set "DSH_BIN=%DSH_DIR%\node_modules\@deepseek-ai\dsh\lib\bin.js"
set "WEBUI_DIR=%WORKBENCH_ROOT%\webui"
set "STRATA_BASE_URL=http://127.0.0.1:%STRATA_PORT%/v1"
set "STRATA_HEALTH=http://127.0.0.1:%STRATA_PORT%/health"

REM ============================================================
REM  Log directory
REM  ----------------------------------------------------------
REM  All launcher logs go here instead of next to the .bat files,
REM  so a double-click never leaves clutter behind.
REM
REM  Override it by setting LOG_DIR in config\paths.bat.
REM  Leave LOG_DIR empty there to get the default below.
REM ============================================================
if not defined LOG_DIR set "LOG_DIR=%LOCALAPPDATA%\strata-dsh-workbench\logs"
if not defined LOG_KEEP_DAYS set "LOG_KEEP_DAYS=14"

REM strip a trailing backslash so "%LOG_DIR%\x" never becomes "dir\\x"
if defined LOG_DIR if "%LOG_DIR:~-1%"=="\" set "LOG_DIR=%LOG_DIR:~0,-1%"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1

set "LAUNCH_LOG=%LOG_DIR%\workbench.log"
set "WEBUI_LOG=%LOG_DIR%\webui.log"
set "INSTALL_LOG=%LOG_DIR%\install-strata.log"
set "LOG_READY="
if exist "%LOG_DIR%" set "LOG_READY=1"

REM ============================================================
REM  Report
REM ============================================================
set "MISSING="
if not exist "%STRATA_SERVER%" set "MISSING=%MISSING% STRATA_HOME"
if not exist "%DSH_BIN%"       set "MISSING=%MISSING% DSH_DIR"
if not defined PYTHON_EXE      set "MISSING=%MISSING% PYTHON"

exit /b 0


REM ============================================================
REM  Subroutines
REM ============================================================
:check_strata
if "%~1"=="" exit /b 1
if not exist "%~1\serve\server.py" exit /b 1
set "STRATA_HOME=%~1"
exit /b 0

:check_data
if "%~1"=="" exit /b 1
if not exist "%~1\models" exit /b 1
set "STRATA_DATA=%~1"
exit /b 0

:check_dsh
if "%~1"=="" exit /b 1
if not exist "%~1\node_modules\@deepseek-ai\dsh\lib\bin.js" exit /b 1
set "DSH_DIR=%~1"
exit /b 0

:check_py
if "%~1"=="" exit /b 1
if not exist "%~1" exit /b 1
set "PYTHON_EXE=%~1"
exit /b 0
