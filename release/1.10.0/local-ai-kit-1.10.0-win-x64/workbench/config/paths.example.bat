@echo off
REM ============================================================
REM  strata-dsh-workbench  --  PATH CONFIGURATION
REM ============================================================
REM
REM  This is the ONLY file you normally need to edit.
REM
REM  Easiest way:  double-click  setup.bat  in the repo root.
REM  It will auto-detect everything it can and write config\paths.bat
REM  for you. Only edit by hand if auto-detection fails.
REM
REM  RULES
REM    * Keep this file pure ASCII (no Chinese characters).
REM    * Use double quotes around paths.
REM    * No trailing backslash.
REM
REM  IMPORTANT: this file is git-ignored. Your local paths never
REM  leave your machine.
REM ============================================================


REM ------------------------------------------------------------
REM  1. Strata engine  --  the folder where you cloned / extracted
REM     https://github.com/Niko1221/Strata
REM     Must contain  serve\server.py  and  engine\strata.exe
REM ------------------------------------------------------------
set "STRATA_HOME=F:\Strata"


REM ------------------------------------------------------------
REM  2. Strata data  --  downloaded model packs, gguf, mtp
REM     Must contain  packs\<profile>  and  models\<PROFILE>
REM ------------------------------------------------------------
set "STRATA_DATA=F:\Strata-data"


REM ------------------------------------------------------------
REM  3. Model profile to launch.
REM     Allowed:  iq2_xs | iq3_s | iq3_xxs | q2_0
REM     Must match the folder name under STRATA_DATA\models
REM ------------------------------------------------------------
set "STRATA_PROFILE=iq2_xs"


REM ------------------------------------------------------------
REM  4. DeepSeek Harness runtime  --  the folder that contains
REM     node_modules\@deepseek-ai\dsh\lib\bin.js
REM     Usually  %USERPROFILE%\dsh-runtime
REM
REM     NOTE: this is the INSTALL directory, so it is called
REM     DSH_DIR. Do not use DSH_HOME here: dsh itself reads
REM     DSH_HOME to find its state (profiles, credentials), and
REM     pointing it at the install directory makes dsh start with
REM     an empty configuration and no local models.
REM ------------------------------------------------------------
set "DSH_DIR=C:\Users\YOURNAME\dsh-runtime"


REM ------------------------------------------------------------
REM  5. Node.js executable.
REM     Leave as "node" to use PATH, or give a full path.
REM ------------------------------------------------------------
set "NODE_EXE=node"


REM ------------------------------------------------------------
REM  6. Python used by the WebUI and the folder agent.
REM     Leave EMPTY to auto-detect (Strata venv -> py launcher -> PATH).
REM ------------------------------------------------------------
set "PYTHON_EXE="


REM ------------------------------------------------------------
REM  7. Ports
REM ------------------------------------------------------------
set "STRATA_PORT=8080"
set "WEB_PORT=8090"


REM ------------------------------------------------------------
REM  8. Shared local API key.
REM     Strata enforces this key, and dsh must send the same value.
REM     It is a LOCAL key only -- it never talks to the internet.
REM ------------------------------------------------------------
set "STRATA_API_KEY=sk-local-qwen"


REM ------------------------------------------------------------
REM  9. Where the launcher logs go.
REM
REM     Leave EMPTY to use the default:
REM         %LOCALAPPDATA%\strata-dsh-workbench\logs
REM
REM     Put logs anywhere you like. Examples:
REM         set "LOG_DIR=D:\logs\strata"
REM         set "LOG_DIR=%USERPROFILE%\strata-logs"
REM         set "LOG_DIR=%WORKBENCH_ROOT%\logs"
REM
REM     The directory is created automatically if it does not exist.
REM     Three files land here:
REM         workbench.log      the engine + dsh launcher
REM         webui.log          the WebUI launcher
REM         install-strata.log the installer
REM
REM     The ENGINE's own log (strata-<profile>.log) is NOT set here --
REM     its path lives in the Strata config JSON. Move it with:
REM         python tools\set-log-dir.py --apply
REM ------------------------------------------------------------
set "LOG_DIR="


REM ------------------------------------------------------------
REM  10. How many days of logs to keep. 0 = never delete.
REM      Applied by launchers on start: files older than this in
REM      LOG_DIR are removed. Set to 0 to keep everything.
REM ------------------------------------------------------------
set "LOG_KEEP_DAYS=14"
