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
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { makeLnk, verifyLnk } from './make-lnk.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

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
];

export function createShortcuts(root, desktop, logger) {
  const say = logger || ((s) => console.log(s));
  let n = 0;
  for (const [lnkName, cmd, icon, desc] of JOBS) {
    const target = path.join(root, cmd);
    const iconPath = path.join(root, 'icons', icon);
    if (!fs.existsSync(target) || !fs.existsSync(iconPath)) {
      say(`! 缺少 ${cmd} 或 ${icon}，跳过`);
      continue;
    }
    // .lnk 的目标路径必须是纯 ASCII（shell item 名字字段是 ANSI 编码）
    if (!/^[\x20-\x7e]*$/.test(target)) {
      say(`! 目标路径含非 ASCII 字符，跳过：${target}`);
      continue;
    }
    const lnk = path.join(desktop, lnkName);
    makeLnk({ lnkPath: lnk, target, workingDir: root, iconPath, description: desc });
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
