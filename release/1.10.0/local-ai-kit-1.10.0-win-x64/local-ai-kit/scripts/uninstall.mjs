/**
 * 本地 AI 卸载程序。
 *
 * 设计原则：这是**破坏性操作**，所以
 *   1. 先把「要删什么、不删什么」逐条列清楚，让用户按回车前就完全明白；
 *   2. 模型目录（可能十几 GB）单独问一次，并且只在路径确实是 ollama\models 结构时才允许删；
 *   3. 删除安装目录放在最后，用「延迟删除」绕开自己正被占用的限制。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.mjs';
import { findDesktop } from './make-shortcuts.mjs';
import { killOllama } from './ollama.mjs';
import { freeSpaceGB } from './detect.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig(ROOT) || {};

const log = (s = '') => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHORTCUTS = ['启动本地AI.lnk', '停止本地AI.lnk', '本地AI控制台.lnk', '本地AI卸载.lnk'];
const ENV_VARS = ['OLLAMA_MODELS', 'OLLAMA_CONTEXT_LENGTH', 'OLLAMA_FLASH_ATTENTION', 'OLLAMA_KV_CACHE_TYPE', 'OLLAMA_KEEP_ALIVE', 'OLLAMA_HOST'];

let rl = null;
const isTTY = process.stdin.isTTY;

async function ask(q) {
  if (!isTTY) return '';
  rl = rl || readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(q)).trim(); } catch { return ''; }
}

async function confirm(q) {
  const a = await ask(q);
  return /^(y|yes|是|确认)$/i.test(a);
}

function rmSafe(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); return true; } catch { return false; }
}

/* ------------------------------------------------------------ 各项清理 */

function stopService() {
  log('[1/6] 停止服务…');
  try {
    const out = execSync('netstat -ano -p TCP', { encoding: 'utf8' });
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+127\.0\.0\.1:3080\s+\S+\s+LISTENING\s+(\d+)/);
      if (m) {
        execSync(`taskkill /PID ${m[1]} /T /F`, { stdio: 'ignore' });
        log('      工作台已停止。');
      }
    }
  } catch { /* 没在跑 */ }
  killOllama();
  log('      Ollama 已停止。');
}

function removeShortcuts() {
  log('[2/6] 删除桌面快捷方式…');
  const desktop = findDesktop();
  let n = 0;
  for (const name of SHORTCUTS) {
    const p = path.join(desktop, name);
    if (fs.existsSync(p) && rmSafe(p)) { log(`      已删除 ${name}`); n++; }
  }
  if (!n) log('      没有找到需要删除的快捷方式。');
  return n;
}

async function removeModelDir() {
  const dir = cfg.modelDir;
  if (!dir) { log('      配置里没有模型目录，跳过。'); return 'skip'; }
  if (!fs.existsSync(dir)) { log(`      模型目录不存在（${dir}），跳过。`); return 'skip'; }

  // 安全阀：只删「看起来就是 ollama 的 models 目录」的路径。
  // 用户完全可能把模型目录填成别的什么重要文件夹，不能盲删。
  if (!/[\\/]ollama[\\/]models[\\/]?$/i.test(dir)) {
    log(`      ⚠ 模型目录不是标准的 ...\\ollama\\models 结构，为安全起见不自动删除。`);
    log(`        路径：${dir}`);
    log('        如果确实想删，请自己在资源管理器里处理。');
    return 'unsafe';
  }
  const free = freeSpaceGB(dir);
  log(`      模型目录：${dir}`);
  if (!isTTY) { log('      （非交互环境，跳过）'); return 'skip'; }
  const ok = await confirm(`      确定要连模型一起删掉吗？会释放十几 GB 空间。输入 yes 回车确认：`);
  if (!ok) { log('      已保留模型文件。'); return 'keep'; }
  const done = rmSafe(dir);
  log(done ? '      模型已删除，空间已释放。' : '      删除失败，可能被其它程序占用。');
  return done ? 'deleted' : 'failed';
}

function removeEnvVars() {
  log('[4/6] 清理环境变量…');
  let n = 0;
  for (const v of ENV_VARS) {
    try {
      execSync(`reg delete "HKCU\\Environment" /v ${v} /f`, { stdio: 'ignore' });
      log(`      已删除 ${v}`);
      n++;
    } catch { /* 本来就没有 */ }
  }
  if (!n) log('      没有需要清理的环境变量。');
}

async function offerOptionalUninstall() {
  log('[5/6] Ollama 和 Node.js…');
  if (!isTTY) { log('      （非交互环境，跳过）'); return; }
  log('      这两个是通用软件，可能还有别的东西在用，默认**不动**。');
  const ok = await confirm('      要顺便把 Ollama 和 Node.js 也卸载掉吗？（一般不需要）输入 yes 回车：');
  if (!ok) { log('      已保留 Ollama 和 Node.js。'); return; }
  const ollamaUn = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'unins000.exe');
  if (fs.existsSync(ollamaUn)) {
    log('      正在启动 Ollama 卸载程序（会弹出确认窗口）…');
    try {
      spawn(ollamaUn, ['/SILENT'], { detached: true, stdio: 'ignore' }).unref();
    } catch { log('      Ollama 卸载程序启动失败，请到「设置 → 应用」里手动卸载。'); }
  } else {
    log('      没找到 Ollama 的卸载程序，请到「设置 → 应用」里手动卸载。');
  }
  log('      Node.js 请到「设置 → 应用」里搜索 Node.js 卸载。');
}

/* ------------------------------------------------------------ 延迟删目录 */

function scheduleRemoveRoot() {
  // 自己正跑在这个目录里，不能立刻删 —— 交给一个延迟执行的独立 cmd
  const cmdline = `timeout /t 3 /nobreak >nul & rmdir /s /q "${ROOT}"`;
  try {
    spawn('cmd.exe', ['/c', cmdline], {
      detached: true,
      stdio: 'ignore',
      cwd: os.tmpdir(),
      windowsVerbatimArguments: true,
    }).unref();
    return true;
  } catch { return false; }
}

/* ------------------------------------------------------------------ 主流程 */

(async () => {
  log('');
  log('==================================================');
  log('        本地 AI 卸载程序');
  log('==================================================');
  log('');
  log('  将要删除：');
  log('    · 桌面快捷方式（启动 / 停止 / 控制台）');
  log(`    · 安装目录  ${ROOT}`);
  log('    · 安装时写入的 OLLAMA_* 用户环境变量');
  log('');
  log('  不会自动删除（下面会单独问你）：');
  log(`    · 模型文件  ${cfg.modelDir || '（未配置）'}`);
  log('    · Ollama 和 Node.js 本体');
  log('');
  log('  停止服务后，桌面上的图标和黑窗口都会消失。');
  log('');

  if (isTTY) {
    const ok = await confirm('  确认开始卸载吗？输入 yes 回车：');
    if (!ok) { log('\n  已取消，什么都没删。'); process.exitCode = 0; return; }
  } else {
    log('  （非交互环境：只做安全的部分，不会删任何东西）');
    process.exitCode = 0;
    return;
  }
  log('');

  stopService();
  removeShortcuts();

  log('[3/6] 模型文件…');
  const modelResult = await removeModelDir();

  removeEnvVars();
  await offerOptionalUninstall();

  log('[6/6] 删除安装目录…');
  const scheduled = scheduleRemoveRoot();
  if (scheduled) {
    log('      已安排在几秒后删除（因为程序自己正跑在里面）。');
    log(`      位置：${ROOT}`);
  } else {
    log(`      自动删除失败，请手动删除：${ROOT}`);
  }

  log('');
  log('==================================================');
  log('        卸载完成');
  log('==================================================');
  log('');
  log('  模型文件：' + ({
    deleted: '已删除', keep: '已按你的选择保留', unsafe: '路径非标准，未自动删除（需手动处理）',
    skip: '未处理', failed: '删除失败，请手动处理',
  }[modelResult] || '未处理'));
  log('  桌面图标已经清掉了，这个窗口可以直接关闭。');
  log('');

  if (rl) rl.close();
  // 给延迟删除留出时间再退出
  await sleep(500);
})();
