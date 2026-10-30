/**
 * 安装目录里那几个 .cmd 入口的内容模板。
 *
 * 单独抽出来的原因：`install.mjs` 和 `make-shortcuts.mjs` 都要用，
 * 而前者又会 import 后者 —— 放在这里可以躲开循环依赖。
 *
 * 内容必须是纯 ASCII + CRLF（.cmd 是批处理，中文文件名和 UTF-8 都会出事）。
 */

/**
 * 通用入口：优先用安装目录里自带的 node（便携 Node 安装时会复制一份过来），
 * 否则用 PATH 里的 node。
 *
 * 脚本位置要自动探测，因为存在两种布局：
 *   - 安装目录：.mjs 是平铺在根目录的（copyRuntime 复制过去的）
 *   - 源码目录：.mjs 都在 scripts\\ 子目录里
 * 直接对着仓库跑（或快捷方式指过来）时，只认一种就会「找不到文件」。
 */
export const cmdEntry = (title, script) => `@echo off
chcp 65001 >nul
set NODE_OPTIONS=
title ${title}
set "NODE_EXE=node"
if exist "%~dp0node\\node.exe" set "NODE_EXE=%~dp0node\\node.exe"
set "SCRIPT=%~dp0${script}"
if not exist "%SCRIPT%" set "SCRIPT=%~dp0scripts\\${script}"
echo.
"%NODE_EXE%" "%SCRIPT%"
echo.
pause
`.replace(/\n/g, '\r\n');

/**
 * 卸载入口必须**先切到临时目录**再跑 node：
 * 卸载的最后一步要删掉安装目录本身，如果当前目录还在里面，Windows 会拒绝删除。
 */
export const uninstallEntry = `@echo off
set NODE_OPTIONS=
title Uninstall Local AI
cd /d "%TEMP%"
set "NODE_EXE=node"
if exist "%~dp0node\\node.exe" set "NODE_EXE=%~dp0node\\node.exe"
set "SCRIPT=%~dp0uninstall.mjs"
if not exist "%SCRIPT%" set "SCRIPT=%~dp0scripts\\uninstall.mjs"
"%NODE_EXE%" "%SCRIPT%"
echo.
pause
`.replace(/\n/g, '\r\n');

export const CMD_ENTRIES = {
  'start-ai.cmd': cmdEntry('Local AI Workspace', 'start-local-ai.mjs'),
  'stop-ai.cmd': cmdEntry('Stop Local AI', 'stop-local-ai.mjs'),
  '控制台.cmd': cmdEntry('Local AI Console', 'console.mjs'),
  '卸载.cmd': uninstallEntry,
  '重建桌面图标.cmd': cmdEntry('Rebuild Desktop Shortcuts', 'make-shortcuts.mjs'),
};

/** 桌面快捷方式依赖的那几个 .cmd（缺了就没得指） */
export const SHORTCUT_CMDS = ['start-ai.cmd', 'stop-ai.cmd', '控制台.cmd'];

/**
 * 对着源码目录直接跑时还要补上「重建桌面图标.cmd」，
 * 这样用户不用先走一遍安装，双击它就能把桌面图标建回来。
 * （卸载.cmd 不在这里 —— 对着仓库目录放个卸载入口没意义）
 */
export const LOCAL_CMDS = [...SHORTCUT_CMDS, '重建桌面图标.cmd'];
