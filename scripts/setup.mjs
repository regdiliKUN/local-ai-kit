/**
 * 本地 AI 部署包 —— 一键部署脚本
 *
 * 做四件事：
 *   1. 检查环境（Node / NVIDIA 显卡 / 磁盘空间）
 *   2. 准备 Ollama（检测或引导安装）+ 设置环境变量
 *   3. 拉取模型
 *   4. 安装 DeepSeek Harness 并写好配置，最后创建桌面快捷方式
 *
 * 幂等：已经装好的部分会自动跳过，可以反复运行。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { execSync, spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadConfig, saveConfig } from './config.mjs';
import { createShortcuts, findDesktop } from './make-shortcuts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.dirname(HERE);

/**
 * 候选模型。gb = 实测下载体积（来自 Ollama registry），
 * needGB = 运行所需显存（含 KV cache 与开销余量）。
 * 按体积从大到小排列 —— 推荐逻辑取「显存跑得动的第一个」。
 */
const MODEL_CHOICES = [
  { tag: 'qwen3.8:27b', label: 'Qwen3.8 27B',  note: '质量最强，长任务与工具调用最好', gb: 16.8, needGB: 21 },
  { tag: 'qwen3.6:27b', label: 'Qwen3.6 27B',  note: 'agentic 编码方向强化',             gb: 16.8, needGB: 21 },
  { tag: 'qwen3:14b',   label: 'Qwen3 14B',    note: '推理能力较强',                     gb: 9.3,  needGB: 13 },
  { tag: 'qwen2.5:14b', label: 'Qwen2.5 14B',  note: '成熟稳定，工具调用可靠',            gb: 9.0,  needGB: 13 },
  { tag: 'qwen3:8b',    label: 'Qwen3 8B',     note: '8GB 显存可跑',                     gb: 5.2,  needGB: 8 },
  { tag: 'qwen2.5:7b',  label: 'Qwen2.5 7B',   note: '轻量通用',                         gb: 4.7,  needGB: 7 },
  { tag: 'qwen2.5:3b',  label: 'Qwen2.5 3B',   note: '小显存 / 纯 CPU',                  gb: 1.9,  needGB: 4 },
  { tag: 'llama3.2:3b', label: 'Llama 3.2 3B', note: '很轻',                             gb: 2.0,  needGB: 4 },
];

const DEFAULT_MODEL = MODEL_CHOICES[0].tag;

/** 按「模型体积 + 剩余显存」估算能开多长的上下文 */
function pickContextWindow(vramGB, modelGB) {
  const spare = vramGB - modelGB;
  if (spare >= 7) return 32768;
  if (spare >= 3.5) return 16384;
  if (spare >= 1.5) return 8192;
  return 4096;
}
const OLLAMA_BASE = 'http://127.0.0.1:11434';

/** 安装目录里生成的 .cmd 入口（内容必须是纯 ASCII，避免编码问题） */
const CMD_ENTRIES = {
  'start-ai.cmd': `@echo off
chcp 65001 >nul
set NODE_OPTIONS=
title Local AI Workspace
echo.
node "%~dp0start-local-ai.mjs"
echo.
pause
`,
  'stop-ai.cmd': `@echo off
chcp 65001 >nul
title Stop Local AI
echo.
node "%~dp0stop-local-ai.mjs"
echo.
pause
`,
  '重建桌面图标.cmd': `@echo off
chcp 65001 >nul
set NODE_OPTIONS=
title Rebuild Desktop Shortcuts
echo.
node "%~dp0make-shortcuts.mjs"
echo.
pause
`,
};

const log = (s = '') => console.log(s);
const step = (n, t) => log(`\n[${n}] ${t}`);
const ok = (s) => log(`      ✓ ${s}`);
const info = (s) => log(`      ${s}`);
const warn = (s) => log(`      ! ${s}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAscii = (s) => /^[\x20-\x7e]*$/.test(s);

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim();
  } catch {
    return null;
  }
}

async function http(url, opts = {}) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(opts.timeout ?? 5000), ...opts });
    return r;
  } catch {
    return null;
  }
}

async function isUp(url) {
  const r = await http(url, { timeout: 3000 });
  return !!r;
}

/* ---------------------------------------------------------------- 环境检查 */

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) {
    warn(`Node.js 版本偏低（${process.versions.node}），建议 20 以上。`);
    return false;
  }
  ok(`Node.js ${process.versions.node}`);
  return true;
}

function checkGpu() {
  const out = run('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader');
  if (!out) {
    warn('没检测到 NVIDIA 显卡。CPU 也能跑，但会非常慢。');
    return null;
  }
  const [name, mem] = out.split(',').map((s) => s.trim());
  const gb = Math.round(parseInt(mem, 10) / 1024);
  ok(`${name}  ${gb} GB 显存`);
  return { name, vramGB: gb };
}

function listDrives() {
  const out = [];
  for (let c = 67; c <= 90; c++) {
    const letter = String.fromCharCode(c);
    const root = `${letter}:\\`;
    try {
      const st = fs.statfsSync(root);
      out.push({ letter, root, freeGB: Math.round((st.bsize * st.bavail) / 1e9) });
    } catch { /* 盘不存在 */ }
  }
  return out;
}

/* ------------------------------------------------------------ 安装根目录 */

/** 选一个纯 ASCII 的安装目录（.lnk 的目标路径必须是 ASCII）。 */
function pickInstallRoot() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidates = [
    path.join(local, 'Programs', 'LocalAI'),
    path.join(local, 'LocalAI'),
    'C:\\LocalAI',
  ];
  for (const d of ['D', 'E', 'F', 'I', 'J']) candidates.push(`${d}:\\LocalAI`);

  for (const c of candidates) {
    if (!isAscii(c)) continue;          // 中文用户名等情况直接跳过
    try {
      fs.mkdirSync(c, { recursive: true });
      return c;
    } catch { /* 没权限，换下一个 */ }
  }
  return null;
}

/* ------------------------------------------------------------ 模型目录 */

/** 某个模型目录里是否已经存在指定模型 */
function hasModel(dir, model) {
  if (!dir) return false;
  const [name, tag = 'latest'] = model.split(':');
  const manifest = path.join(dir, 'manifests', 'registry.ollama.ai', 'library', name, tag);
  try { return fs.existsSync(manifest); } catch { return false; }
}

/** 在常见位置找已经装好该模型的目录，找到就复用（避免重复下载十几 GB） */
function findExistingModelDir(model, drives) {
  const cands = [];
  if (process.env.OLLAMA_MODELS) cands.push(process.env.OLLAMA_MODELS);
  for (const d of drives) cands.push(path.join(d.root, 'ollama', 'models'));
  for (const c of cands) {
    if (hasModel(c, model)) return c;
  }
  return null;
}

/** 让用户选模型存放盘（自动挑最大空闲盘可能选到叠瓦盘 SMR，不可靠） */
async function askModelDir(drives, suggested) {
  const usable = drives.filter((d) => d.freeGB >= 30).sort((a, b) => b.freeGB - a.freeGB);
  if (!usable.length) return null;

  log('      模型约需 20GB 空间，请选择存放位置：');
  usable.forEach((d, i) => {
    const rec = path.join(d.root, 'ollama', 'models') === suggested ? '   ← 推荐' : '';
    log(`        ${String(i + 1).padStart(2)}) ${d.letter}:   空闲 ${d.freeGB} GB${rec}`);
  });
  log('      提示：如果有叠瓦盘（SMR），建议避开，选机械硬盘里较新的那块或 SSD。');

  const defIdx = Math.max(0, usable.findIndex((d) => path.join(d.root, 'ollama', 'models') === suggested));

  if (!process.stdin.isTTY) {
    info(`（非交互环境，自动选择 ${usable[defIdx].letter}:）`);
    return path.join(usable[defIdx].root, 'ollama', 'models');
  }

  let ans = '';
  try {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    ans = (await rl.question(`      输入序号后回车（直接回车 = 选 ${defIdx + 1}）：`)).trim();
    rl.close();
  } catch { /* 非交互环境，用默认值 */ }

  const idx = ans ? Number(ans) - 1 : defIdx;
  const chosen = usable[idx] || usable[defIdx];
  return path.join(chosen.root, 'ollama', 'models');
}

/** 看看候选模型里有没有已经装好的（用于给出默认值和复用目录） */
function findInstalledChoice(drives) {
  for (const m of MODEL_CHOICES) {
    const d = findExistingModelDir(m.tag, drives);
    if (d) return { tag: m.tag, gb: m.gb, dir: d };
  }
  return null;
}

/** 让用户选模型：按显存推荐，也支持手动输入任意 Ollama 模型名 */
async function askModel(gpu, installedTag, currentTag) {
  const vram = gpu ? gpu.vramGB : 0;
  log('');
  if (gpu) info(`显卡：${gpu.name}  ${vram} GB 显存`);
  else warn('未检测到 NVIDIA 显卡 —— 只能跑很小的模型，或纯 CPU（会非常慢）');

  const fits = MODEL_CHOICES.filter((m) => (vram ? m.needGB <= vram : m.needGB <= 4));
  const list = fits.length ? fits : [MODEL_CHOICES[MODEL_CHOICES.length - 1]];

  let defIdx = 0;
  const prefer = installedTag || currentTag;
  if (prefer) {
    const i = list.findIndex((m) => m.tag === prefer);
    if (i >= 0) defIdx = i;
  }

  const ask = async (q) => {
    if (!process.stdin.isTTY) return '';      // 非交互环境直接取默认值，避免卡住
    try {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const a = (await rl.question(q)).trim();
      rl.close();
      return a;
    } catch { return ''; }
  };

  if (!process.stdin.isTTY) {
    const auto = list[defIdx];
    info(`（非交互环境，自动选择：${auto.tag}）`);
    return { tag: auto.tag, gb: auto.gb };
  }

  log('      请选择要部署的模型：');
  list.forEach((m, i) => {
    const rec = i === defIdx ? '   ← 推荐' : '';
    log(`        ${String(i + 1).padStart(2)}) ${m.label.padEnd(13)} 约 ${m.gb.toFixed(1)}GB  ${m.note}${rec}`);
  });
  log(`        ${String(list.length + 1).padStart(2)}) 手动输入其他模型名`);

  const ans = await ask(`      输入序号后回车（直接回车 = 选 ${defIdx + 1}）：`);
  const n = Number(ans);

  if (ans && n === list.length + 1) {
    const custom = await ask('      请输入模型名（例如 qwen2.5:14b）：');
    if (custom) {
      const known = MODEL_CHOICES.find((m) => m.tag === custom);
      return { tag: custom, gb: known ? known.gb : 0 };
    }
  }
  const chosen = list[n - 1] || list[defIdx];
  return { tag: chosen.tag, gb: chosen.gb };
}

/* ---------------------------------------------------------------- Ollama */

function findOllama() {
  const probes = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'),
    'C:\\Program Files\\Ollama\\ollama.exe',
  ];
  for (const p of probes) {
    if (p && fs.existsSync(p)) return p;
  }
  const where = run('where ollama');
  if (where) return where.split(/\r?\n/)[0].trim();
  return null;
}

function killOllama() {
  for (const img of ['ollama app.exe', 'ollama.exe']) {
    try { execSync(`taskkill /IM "${img}" /F`, { stdio: 'ignore' }); } catch { /* 没在跑 */ }
  }
}

/**
 * 确保 Ollama 以「配置的模型目录」在运行。
 *
 * 关键：Ollama 的模型目录是启动时读环境变量决定的，`ollama pull` 又是通过
 * 运行中的服务写入的 —— 如果服务用了别的目录，模型就会下到错误的位置。
 * 所以这里必须带上 OLLAMA_MODELS 启动；若发现服务用错了目录就重启它。
 */
async function ensureOllama(exe, modelDir, model) {
  const env = {
    ...process.env,
    OLLAMA_HOST: '127.0.0.1:11434',
    OLLAMA_MODELS: modelDir,
    OLLAMA_FLASH_ATTENTION: '1',
    OLLAMA_KV_CACHE_TYPE: 'q8_0',
    OLLAMA_CONTEXT_LENGTH: '32768',
    OLLAMA_KEEP_ALIVE: '30m',
  };

  const running = await isUp(`${OLLAMA_BASE}/api/version`);

  if (running) {
    // 判断运行中的服务用的是不是我们期望的目录：
    // 目标目录里已有模型、但服务却看不到它 → 服务用的是别的目录。
    const tags = await fetch(`${OLLAMA_BASE}/api/tags`).then((r) => r.json()).catch(() => null);
    const visible = (tags?.models || []).some((m) => m.name === model);
    if (visible || !hasModel(modelDir, model)) {
      ok('Ollama 服务已在运行');
      return true;
    }
    info('运行中的 Ollama 使用了别的模型目录，正在重启...');
    killOllama();
    await sleep(2500);
  } else {
    info('Ollama 未运行，正在以配置的模型目录启动...');
  }

  const child = spawn(exe, ['serve'], { detached: true, stdio: 'ignore', env });
  child.unref();

  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    if (await isUp(`${OLLAMA_BASE}/api/version`, 1500)) {
      ok(`Ollama 已启动（模型目录：${modelDir}）`);
      return true;
    }
  }
  warn('启动超时，稍后可用「启动本地AI」再试。');
  return false;
}

/* ------------------------------------------------------------ 环境变量 */

function setUserEnv(vars) {
  for (const [k, v] of Object.entries(vars)) {
    run(`setx ${k} "${v}"`);
  }
}

/* ---------------------------------------------------------------- dsh */

function installDsh(root) {
  const dshDir = path.join(root, 'dsh-runtime');
  fs.mkdirSync(dshDir, { recursive: true });

  const bin = path.join(dshDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (fs.existsSync(bin)) {
    ok('DeepSeek Harness 已安装');
    return dshDir;
  }

  info('正在安装 DeepSeek Harness（约 1–3 分钟）...');
  fs.writeFileSync(path.join(dshDir, 'package.json'),
    JSON.stringify({ name: 'local-ai-runtime', private: true }, null, 2));

  // 关键：必须 --ignore-scripts。koffi 的 postinstall 在缺 CMake 时会失败，
  // 并让 npm 回滚整个安装，导致缺少原生二进制（Agent 无法执行命令）。
  const r = spawnSync('npm',
    ['install', '@deepseek-ai/dsh', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: dshDir, stdio: 'inherit', shell: true });

  if (!fs.existsSync(bin)) {
    warn('安装失败。请确认已安装 Node.js，且网络能访问 npm。');
    return null;
  }
  ok('DeepSeek Harness 安装完成');
  return dshDir;
}

/** 写 dsh 的模型提供方配置（web 与 headless 两个 profile）。 */
function writeDshProfiles(dshDir, cfg) {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const patch = (profile) => `# 由本地 AI 部署包生成
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      ollama-local:
        displayName: Ollama 本地 (${cfg.model})
        apiKeyEnv: OLLAMA_API_KEY
        api: openai-completions
        baseURL: ${OLLAMA_BASE}/v1
        models:
          - id: ${cfg.model}
            name: ${cfg.model} 本地
            contextWindow: ${cfg.contextWindow}
            maxTokens: 8192
            input: [text, image]
${profile === 'headless' ? `- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: ollama-local
    model: ${cfg.model}
` : ''}`;

  for (const p of ['web', 'headless']) {
    const dir = path.join(home, 'profiles', p);
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'cordis.patch.yml');
    fs.writeFileSync(f, patch(p), 'utf8');
  }
  ok(`已写入 dsh 配置（${path.join(home, 'profiles')}）`);

  // 凭据：本地端点也需要一个非空 API key
  const cred = path.join(home, '.credentials.yaml');
  let text = fs.existsSync(cred) ? fs.readFileSync(cred, 'utf8') : 'version: 1\nrecords: {}\nrefs:\n';
  if (!/OLLAMA_API_KEY/.test(text)) {
    if (!/^refs:/m.test(text)) text += '\nrefs:\n';
    text = text.replace(/^refs:\s*$/m, 'refs:\n  OLLAMA_API_KEY: ollama');
    fs.writeFileSync(cred, text, 'utf8');
  }
  ok('已写入本地模型凭据');
}

/* ------------------------------------------------------------------ 主流程 */

(async () => {
  log('==================================================');
  log('        本地 AI 部署包   一键部署');
  log('==================================================');

  step('1/7', '检查环境');
  checkNode();
  const gpu = checkGpu();

  const drives = listDrives();
  if (drives.length) {
    info('可用磁盘：' + drives.map((d) => `${d.letter}: ${d.freeGB}GB`).join('  '));
  }

  const root = pickInstallRoot();
  if (!root) {
    warn('找不到可写的 ASCII 安装目录，部署中止。');
    process.exit(1);
  }
  ok(`安装目录：${root}`);

  // 把脚本、界面和图标复制到安装目录
  for (const f of fs.readdirSync(HERE)) {
    if (f.endsWith('.mjs')) fs.copyFileSync(path.join(HERE, f), path.join(root, f));
  }
  fs.mkdirSync(path.join(root, 'icons'), { recursive: true });
  for (const f of fs.readdirSync(path.join(KIT, 'icons'))) {
    fs.copyFileSync(path.join(KIT, 'icons', f), path.join(root, 'icons', f));
  }
  const uiSrc = path.join(KIT, 'ui');
  if (fs.existsSync(uiSrc)) {
    fs.mkdirSync(path.join(root, 'ui'), { recursive: true });
    for (const f of fs.readdirSync(uiSrc)) {
      fs.copyFileSync(path.join(uiSrc, f), path.join(root, 'ui', f));
    }
  }
  for (const [f, body] of Object.entries(CMD_ENTRIES)) {
    fs.writeFileSync(path.join(root, f), body, 'ascii');
  }

  const cfg = loadConfig(root) || { model: '', modelDir: '', contextWindow: 0 };
  const installed = findInstalledChoice(drives);

  step('2/7', '选择模型');
  if (installed) info(`检测到已安装：${installed.tag}（默认选它）`);
  const picked = await askModel(gpu, installed?.tag, cfg.model);
  cfg.model = picked.tag;
  cfg.contextWindow = pickContextWindow(gpu ? gpu.vramGB : 0, picked.gb);
  ok(`模型：${cfg.model}`);
  info(`上下文长度：${cfg.contextWindow}`);

  step('3/7', '设置模型存放位置');
  const existingDir = findExistingModelDir(cfg.model, drives);
  if (existingDir) {
    cfg.modelDir = existingDir;
    ok(`发现已有模型，直接复用（无需重新下载）：${existingDir}`);
  } else if (cfg.modelDir && fs.existsSync(cfg.modelDir)) {
    ok(`沿用上次配置：${cfg.modelDir}`);
  } else {
    const preferred = drives
      .filter((d) => d.letter !== 'C' && d.freeGB >= 30)
      .sort((a, b) => b.freeGB - a.freeGB)[0];
    const suggested = preferred ? path.join(preferred.root, 'ollama', 'models') : '';
    const chosen = await askModelDir(drives, suggested);
    if (!chosen) { warn('没有找到可用磁盘'); process.exitCode = 1; return; }
    cfg.modelDir = chosen;
    ok(`模型目录：${cfg.modelDir}`);
  }
  fs.mkdirSync(cfg.modelDir, { recursive: true });

  setUserEnv({
    OLLAMA_MODELS: cfg.modelDir,
    OLLAMA_FLASH_ATTENTION: '1',
    OLLAMA_KV_CACHE_TYPE: 'q8_0',
    OLLAMA_CONTEXT_LENGTH: String(cfg.contextWindow),
    OLLAMA_KEEP_ALIVE: '30m',
  });
  saveConfig(root, cfg);

  step('4/7', '准备 Ollama');
  const ollamaExe = findOllama();
  if (!ollamaExe) {
    warn('没有检测到 Ollama。');
    info('请到 https://ollama.com/download 下载并安装，然后重新运行本脚本。');
    info('（安装时保持默认选项即可）');
    process.exitCode = 1;
    return;
  }
  ok(`已找到 ${ollamaExe}`);
  // 必须带着正确的模型目录启动服务，否则 ollama pull 会下到默认目录（C 盘）
  if (!(await ensureOllama(ollamaExe, cfg.modelDir, cfg.model))) {
    process.exitCode = 1;
    return;
  }

  step('5/7', `拉取模型 ${cfg.model}`);
  info('首次需要下载十几 GB，请耐心等待（可中断，下次会接着下）...');
  const pull = spawnSync(ollamaExe, ['pull', cfg.model], {
    stdio: 'inherit',
    env: { ...process.env, OLLAMA_MODELS: cfg.modelDir },
    shell: false,
  });
  if (pull.status === 0) ok('模型已就绪');
  else warn('模型下载未完成，可重新运行本脚本继续。');

  step('6/7', '安装 DeepSeek Harness');
  const dshDir = installDsh(root);
  if (dshDir) writeDshProfiles(dshDir, cfg);

  step('7/7', '创建桌面快捷方式');
  const desktop = findDesktop();
  info(`桌面位置：${desktop}`);
  const created = createShortcuts(root, desktop);
  if (created) ok(`已创建 ${created} 个快捷方式`);

  log('\n==================================================');
  log('   部署完成');
  log('==================================================');
  log(`\n  安装目录：${root}`);
  log(`  模型目录：${cfg.modelDir}`);
  log(`  模型：    ${cfg.model}\n`);
  log('  以后：双击桌面「启动本地AI」即可使用。');
  log('        用完双击「停止本地AI」释放显存。\n');
})();
