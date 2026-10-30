/**
 * 本地 AI 部署包 —— 命令行安装（没有图形界面，适合脚本 / 自动化）
 *
 * 和图形向导共用同一套检测（detect.mjs）与安装引擎（install.mjs），
 * 这里只负责在终端里问问题、把进度打印出来。
 *
 * 非交互环境（stdin 不是终端）会自动选推荐值，不会卡住。
 * 幂等：已经装好的部分会自动跳过，可以反复运行。
 */

import path from 'node:path';
import readline from 'node:readline/promises';

import { detectAll } from './detect.mjs';
import { runInstall } from './install.mjs';
import { pickContextWindow, modelInfo } from './models.mjs';
import { findOllama, isValidModelName } from './ollama.mjs';

const log = (s = '') => console.log(s);
const info = (s) => log(`      ${s}`);
const warn = (s) => log(`      ! ${s}`);

async function ask(q) {
  if (!process.stdin.isTTY) return '';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(q)).trim(); } catch { return ''; } finally { rl.close(); }
}

async function askModel(d) {
  const list = d.models;
  let defIdx = Math.max(0, list.findIndex((m) => m.tag === d.suggested.model));

  if (!process.stdin.isTTY) {
    info(`（非交互环境，自动选择：${list[defIdx].tag}）`);
    return list[defIdx].tag;
  }

  log('      请选择要部署的模型：');
  list.forEach((m, i) => {
    const mark = i === defIdx ? '   ← 推荐' : (m.installed ? '   （已安装）' : '');
    log(`        ${String(i + 1).padStart(2)}) ${m.name.padEnd(13)} 约 ${m.gb.toFixed(1)}GB  ${m.note}${mark}`);
  });
  log(`        ${String(list.length + 1).padStart(2)}) 手动输入其他模型名`);

  const ans = await ask(`      输入序号后回车（直接回车 = 选 ${defIdx + 1}）：`);
  const n = Number(ans);
  if (ans && n === list.length + 1) {
    const custom = await ask('      请输入模型名（例如 qwen2.5-coder:7b）：');
    if (isValidModelName(custom)) return custom;
    if (custom) warn('模型名不合法，改用推荐模型。');
  }
  return (list[n - 1] || list[defIdx]).tag;
}

async function askModelDir(d) {
  const suggested = d.suggested.modelDir;
  const usable = d.disks.filter((x) => x.freeGB >= 20).sort((a, b) => b.freeGB - a.freeGB);
  if (!process.stdin.isTTY || (!usable.length && suggested)) {
    info(`（非交互环境，自动选择 ${suggested}）`);
    return suggested;
  }

  log('      请选择模型存放位置：');
  usable.forEach((x, i) => {
    const rec = path.join(x.root, 'ollama', 'models') === suggested ? '   ← 推荐' : '';
    log(`        ${String(i + 1).padStart(2)}) ${x.letter}:   空闲 ${x.freeGB} GB${rec}`);
  });
  log(`        ${String(usable.length + 1).padStart(2)}) 自己输入完整路径`);
  log('      提示：如果有叠瓦盘（SMR），建议避开，选 SSD 或较新的机械硬盘。');

  const defIdx = Math.max(0, usable.findIndex((x) => path.join(x.root, 'ollama', 'models') === suggested));
  const ans = await ask(`      输入序号后回车（直接回车 = 选 ${defIdx + 1}）：`);
  const n = Number(ans);
  if (ans && n === usable.length + 1) {
    const custom = (await ask('      请输入完整路径（例如 D:\\AI\\models）：')).replace(/\//g, '\\');
    if (/^[A-Za-z]:\\/.test(custom)) return custom;
    warn('路径不合法，改用推荐位置。');
  }
  const chosen = usable[n - 1] || usable[defIdx];
  return chosen ? path.join(chosen.root, 'ollama', 'models') : suggested;
}

/** 把安装引擎的事件打印成终端输出 */
function printer() {
  let lastPct = -1;
  return (ev) => {
    if (ev.type === 'step') {
      if (ev.status === 'running') log(`\n[*] ${ev.text}`);
      else if (ev.status === 'done' || ev.status === 'skipped') info(`✓ ${ev.text}`);
      else if (ev.status === 'error') warn(ev.text);
    } else if (ev.type === 'log') {
      info(ev.text);
    } else if (ev.type === 'progress') {
      // 每 5% 打一行，避免刷屏
      if (ev.percent >= lastPct + 5 || ev.percent === 100) {
        lastPct = ev.percent;
        info(`${String(ev.percent).padStart(3)}%  ${ev.text || ''}`);
      }
    } else if (ev.type === 'needs-elevation') {
      warn(ev.reason);
      if (ev.action === 'install-ollama') {
        info('请到 https://ollama.com/download 下载并安装（保持默认选项），然后重新运行本脚本。');
        info('或者双击「① 双击这里开始安装.cmd」，图形向导可以自动安装并接着往下装。');
      } else if (ev.hint) {
        info(ev.hint);
      }
    } else if (ev.type === 'paused') {
      log('');
      log('  安装暂停了 —— 需要你先完成上面那一步，然后重新运行本脚本。');
      log('  已完成的步骤会自动跳过。');
      process.exitCode = 1;
    } else if (ev.type === 'error') {
      log(`\n安装未完成：${ev.text}`);
      if (ev.stage) log(`停在了：${ev.stage}`);
      if (Array.isArray(ev.remedy) && ev.remedy.length) {
        log('\n你可以这样做：');
        ev.remedy.forEach((s, i) => log(`  ${i + 1}. ${s}`));
      }
      log('\n修正问题后重新运行本脚本即可，已完成的部分会自动跳过。');
      log('图形向导有更详细的排障界面：双击「① 双击这里开始安装.cmd」。');
      process.exitCode = 1;
    } else if (ev.type === 'done') {
      const s = ev.summary;
      log('\n==================================================');
      log('   部署完成');
      log('==================================================');
      log(`\n  安装目录：${s.root}`);
      log(`  模型目录：${s.modelDir}`);
      log(`  模型：    ${s.model}（上下文 ${s.contextWindow}）\n`);
      log('  以后：双击桌面「启动本地AI」即可使用。');
      log('        用完双击「停止本地AI」释放显存。\n');
    }
  };
}

(async () => {
  log('==================================================');
  log('        本地 AI 部署包   命令行安装');
  log('==================================================');

  log('\n[1/3] 检查环境');
  const d = await detectAll();
  info(`Node.js ${d.node.version}`);
  info(d.gpu.found ? `显卡：${d.gpu.name}  ${d.gpu.vramGB} GB 显存` : '显卡：未检测到可用的独立显卡');
  info(`Ollama：${d.ollama.installed ? (d.ollama.version ? `已安装 ${d.ollama.version}` : '已安装') : '未安装'}`);
  for (const i of d.issues) (i.level === 'info' ? info : warn)(i.text);
  if (d.issues.some((i) => i.level === 'error')) { process.exitCode = 1; return; }
  if (!d.install.root) { warn('找不到可写的安装目录。'); process.exitCode = 1; return; }
  info(`安装目录：${d.install.root}`);

  log('\n[2/3] 选择模型');
  const model = await askModel(d);
  const gb = (modelInfo(model) || {}).gb;
  const contextWindow = gb ? pickContextWindow(d.gpu.vramGB, gb) : 8192;
  info(`✓ 模型：${model}，上下文长度：${contextWindow}`);

  log('\n[3/3] 设置模型存放位置');
  const modelDir = await askModelDir(d);
  if (!modelDir) { warn('没有找到可用磁盘（需要至少 20GB 空闲）。'); process.exitCode = 1; return; }
  info(`✓ 模型目录：${modelDir}`);

  await runInstall({
    root: d.install.root,
    model,
    modelDir,
    contextWindow,
    ollamaExe: findOllama(),
  }, printer());
})();

