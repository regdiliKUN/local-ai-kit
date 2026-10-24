/**
 * 重新创建桌面快捷方式。
 *
 * 什么时候用：
 *   - 快捷方式被误删
 *   - 安装目录被移动过
 *   - 桌面路径变了
 *
 * 用法：双击安装目录里的「重建桌面图标.cmd」，或直接 node 运行本文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { makeLnk, verifyLnk } from './make-lnk.mjs';
import { CMD_ENTRIES, SHORTCUT_CMDS, LOCAL_CMDS } from './cmd-entries.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** .cmd 和 icons 都在项目根，不是 scripts 里 —— 这里必须往上一层 */
const ROOT = path.dirname(HERE);

/** 桌面经常被重定向到别的盘，不能假设是 %USERPROFILE%\Desktop */
export function findDesktop() {
  // 手动覆盖：设置 LOCALAI_DESKTOP 环境变量可跳过自动检测
  if (process.env.LOCALAI_DESKTOP && fs.existsSync(process.env.LOCALAI_DESKTOP)) {
    return process.env.LOCALAI_DESKTOP;
  }

  const expand = (s) => s.replace(/%([^%]+)%/g, (_, n) => process.env[n] ?? `%${n}%`);
  const probes = [
    () => {
      const out = execSync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders" /v Desktop',
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      const m = out.match(/REG_(?:EXPAND_)?SZ\s+(\S.*)/);
      return m ? expand(m[1].trim()) : null;
    },
    // 注册表查询被安全策略拦掉时（有些环境禁了 reg.exe），
    // 问一次 PowerShell —— 它拿到的同样是重定向之后的真实桌面
    () => {
      const out = execFileSync(
        'powershell',
        ['-NoProfile', '-Command', '[Environment]::GetFolderPath("Desktop")'],
        { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      return out || null;
    },
    () => path.join(os.homedir(), 'OneDrive', 'Desktop'),
    () => path.join(os.homedir(), 'OneDrive - Personal', 'Desktop'),
    () => path.join(os.homedir(), 'Desktop'),
  ];
  for (const p of probes) {
    try { const r = p(); if (r && fs.existsSync(r)) return r; } catch { /* 试下一个 */ }
  }
  return path.join(os.homedir(), 'Desktop');
}

const JOBS = [
  ['启动本地AI.lnk', 'start-ai.cmd', 'icon-start.ico', '启动本地 AI 工作台'],
  ['停止本地AI.lnk', 'stop-ai.cmd', 'icon-stop.ico', '停止本地 AI 工作台并释放显存'],
  ['本地AI控制台.lnk', '控制台.cmd', 'icon-console.ico', '管理模型、开关开机自启与局域网共享'],
];

/**
 * 快捷方式指向的那几个 .cmd，正常是安装时生成的。
 * 但直接对着源码目录跑（或者 .cmd 被误删）时它们并不存在，
 * 这时补上，不然三个快捷方式会全部跳过。
 */
function ensureEntries(root, say) {
  for (const name of LOCAL_CMDS) {
    const p = path.join(root, name);
    const want = CMD_ENTRIES[name];
    let cur = null;
    try { cur = fs.readFileSync(p, 'utf8'); } catch { /* 还不存在 */ }
    if (cur === want) continue;
    try {
      fs.writeFileSync(p, want, 'utf8');
      say(cur === null ? `+ 已补上 ${name}` : `~ 已更新 ${name}`);
    } catch (e) {
      if (cur === null) say(`! 写不了 ${name}：${e.message}`);
    }
  }
}

/**
 * 决定 .lnk 指向什么。
 *
 * 路径是纯 ASCII 时直接指向 .cmd —— 最标准的写法。
 *
 * 路径含中文时不行：.lnk 里用来定位目标的 IDList 是 ANSI 编码的，
 * 中文存进去会变成乱码，Windows 照着它去找文件就会报
 * 「系统找不到指定的文件」。LinkInfo 里的 Unicode 路径救不了这个
 * （实测 Windows 优先认 IDList）。而 8.3 短名在很多机器上根本没生成，
 * 指望不上。
 *
 * 所以换成：让 cmd.exe（永远在 ASCII 路径里）去执行那个 .cmd，
 * 中文路径放在 arguments 里 —— 这个字段本来就是 UTF-16 的，存得下。
 */
function shortcutTarget(root, cmd) {
  const direct = path.join(root, cmd);
  if (/^[\x20-\x7e]*$/.test(direct)) return { target: direct };

  const sysroot = process.env.SystemRoot || 'C:\\Windows';
  const shell = path.join(sysroot, 'System32', 'cmd.exe');
  if (!fs.existsSync(shell)) return { target: direct };   // 没有 cmd.exe 就只能硬指
  return { target: shell, arguments: `/c "${direct}"` };
}

export function createShortcuts(root, desktop, logger) {
  const say = logger || ((s) => console.log(s));
  ensureEntries(root, say);
  let n = 0;
  for (const [lnkName, cmd, icon, desc] of JOBS) {
    const target = path.join(root, cmd);
    const iconPath = path.join(root, 'icons', icon);
    if (!fs.existsSync(target)) {
      say(`! 缺少 ${cmd}，跳过`);
      continue;
    }
    if (!fs.existsSync(iconPath)) {
      say(`! 缺少 ${icon}，跳过`);
      continue;
    }
    const { target: lnkTarget, arguments: lnkArgs } = shortcutTarget(root, cmd);
    const lnk = path.join(desktop, lnkName);
    makeLnk({
      lnkPath: lnk,
      target: lnkTarget,
      arguments: lnkArgs,
      workingDir: root,
      iconPath,
      description: desc,
    });
    say(`✓ ${lnk}  (${verifyLnk(lnk).size} bytes)`);
    n++;
  }
  return n;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // 支持 --desktop <路径> 手动指定桌面（自动检测不准时用）
  const i = process.argv.indexOf('--desktop');
  const desktop = i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : findDesktop();
  console.log(`安装目录：${ROOT}`);
  console.log(`桌面：    ${desktop}`);
  const n = createShortcuts(ROOT, desktop);
  console.log(n ? `\n完成，已创建 ${n} 个快捷方式。` : '\n没有创建任何快捷方式。');
}
