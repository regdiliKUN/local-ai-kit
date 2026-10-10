/**
 * 环境自动检测：把机器情况一次性摸清楚，交给界面展示。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, spawnSync } from 'node:child_process';

import {
  modelsForVram, recommendModel, pickContextWindow, modelInfo, DEFAULT_MODEL,
  CONTEXT_OPTIONS, estimateVramGB,
} from './models.mjs';
import { OLLAMA_BASE, findOllama, hasModel, listOnDisk } from './ollama.mjs';

function run(cmd, timeout = 8000) {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout,
    }).trim();
  } catch {
    return null;
  }
}

async function fetchJson(url, timeout = 4000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    return await r.json();
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- 各项检测 */

export function detectNode() {
  const v = process.versions.node;
  return { version: v, ok: Number(v.split('.')[0]) >= 20, path: process.execPath };
}

export function detectGpu() {
  const out = run('nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader');
  if (out) {
    // 多卡时取显存最大的那张
    const gpus = out.split(/\r?\n/).filter(Boolean).map((line) => {
      const [name, mem, driver] = line.split(',').map((s) => s.trim());
      return { found: true, vendor: 'nvidia', name, vramGB: Math.round(parseInt(mem, 10) / 1024) || 0, driver };
    });
    gpus.sort((a, b) => b.vramGB - a.vramGB);
    if (gpus[0]) return gpus[0];
  }
  return detectOtherGpu() || { found: false, vendor: null, name: null, vramGB: 0, driver: null };
}

/**
 * 非 NVIDIA 显卡：从显卡驱动的注册表项读显存（WMI 的 AdapterRAM 最多只能报 4GB，不可靠）。
 * Ollama 只支持部分 AMD 显卡加速，不支持时会退回 CPU。
 */
export function detectOtherGpu() {
  const ps = [
    "$k='HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*'",
    'Get-ItemProperty $k -ErrorAction SilentlyContinue | ForEach-Object {',
    "  $m=$_.'HardwareInformation.qwMemorySize'",
    "  if(-not $m){$m=$_.'HardwareInformation.MemorySize'; if($m -is [byte[]]){$m=[BitConverter]::ToUInt32($m,0)}}",
    "  '{0}|{1}' -f $_.DriverDesc,[uint64]$m }",
  ].join('\n');
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (r.status !== 0 || !r.stdout) return null;
  const gpus = r.stdout.split(/\r?\n/).map((line) => {
    const [name, bytes] = line.split('|');
    return { name: (name || '').trim(), vramGB: Math.round(Number(bytes || 0) / 1024 ** 3) };
  }).filter((g) => g.name && !/Microsoft|Basic|Virtual|Remote|Parsec|Meta/i.test(g.name));
  if (!gpus.length) return null;
  gpus.sort((a, b) => b.vramGB - a.vramGB);
  const g = gpus[0];
  const vendor = /AMD|Radeon/i.test(g.name) ? 'amd' : /Intel/i.test(g.name) ? 'intel' : 'other';
  // 集成显卡 / 识别不出显存时按无独显处理
  if (vendor === 'intel' || g.vramGB < 2) return { found: false, vendor, name: g.name, vramGB: 0, driver: null };
  return { found: true, vendor, name: g.name, vramGB: g.vramGB, driver: null };
}

/**
 * NVIDIA 驱动版本检查。
 *
 * Ollama 在 Windows 上跑 GPU 需要足够新的驱动；太旧会静默退回 CPU（慢到不可用），
 * 而它给出的报错对用户毫无意义。所以提前查、提前说。
 * 这里的阈值是**保守下限**，不是官方承诺的精确值。
 */
const DRIVER_MIN = [452, 39];   // 低于这个基本不用想
const DRIVER_GOOD = [527, 0];   // 想稳定启用 GPU 加速，建议至少这个

function cmpVer(a, b) {
  if (a[0] !== b[0]) return a[0] - b[0];
  return (a[1] || 0) - (b[1] || 0);
}

export function driverAdvice(driver) {
  if (!driver) return null;
  const parts = String(driver).split('.').map((n) => parseInt(n, 10)).filter((n) => !Number.isNaN(n));
  if (!parts.length) return null;
  const v = [parts[0], parts[1] || 0];
  if (cmpVer(v, DRIVER_MIN) < 0) {
    return {
      level: 'error',
      text: `显卡驱动太旧（${driver}），Ollama 没法用它做 GPU 加速`,
      hint: '请先到 https://www.nvidia.cn/geforce/drivers/ 下载安装最新驱动，重启后点「重新检测」。',
      driver,
    };
  }
  if (cmpVer(v, DRIVER_GOOD) < 0) {
    return {
      level: 'warn',
      text: `显卡驱动偏旧（${driver}），可能无法完整启用 GPU 加速`,
      hint: '建议升级到 527 以上：到 https://www.nvidia.cn/geforce/drivers/ 下载安装后重启，再点「重新检测」。也可以先继续安装。',
      driver,
    };
  }
  return { level: 'ok', text: `显卡驱动 ${driver}`, hint: '', driver };
}

export function detectDisks() {
  const out = [];
  for (let c = 67; c <= 90; c++) {
    const letter = String.fromCharCode(c);
    const root = `${letter}:\\`;
    try {
      const st = fs.statfsSync(root);
      const totalGB = Math.round((st.bsize * st.blocks) / 1e9);
      const freeGB = Math.round((st.bsize * st.bavail) / 1e9);
      if (totalGB > 0) out.push({ letter, root, freeGB, totalGB });
    } catch { /* 盘不存在 */ }
  }
  return out;
}

/** 某个路径所在磁盘的剩余空间（GB）；取不到返回 null */
export function freeSpaceGB(p) {
  try {
    const st = fs.statfsSync(path.parse(path.resolve(p)).root);
    return Math.round((st.bsize * st.bavail) / 1e9);
  } catch {
    return null;
  }
}

export async function detectOllama() {
  const exe = findOllama();
  const ver = await fetchJson(`${OLLAMA_BASE}/api/version`);
  const tags = ver ? await fetchJson(`${OLLAMA_BASE}/api/tags`) : null;
  return {
    installed: !!exe,
    exe,
    running: !!ver,
    version: ver?.version || null,
    models: (tags?.models || []).map((m) => m.name),
  };
}

export function isElevated() {
  const out = run('whoami /groups');
  if (!out) return false;
  // 管理员组 SID，且状态为 Enabled
  return /S-1-5-32-544/.test(out) && /Enabled group|已启用组|Enabled by default|默认启用/.test(out);
}

/** 在常见位置找已经装好的模型目录 */
export function findModelDir(model, disks) {
  const cands = [];
  if (process.env.OLLAMA_MODELS) cands.push(process.env.OLLAMA_MODELS);
  for (const d of disks) cands.push(path.join(d.root, 'ollama', 'models'));
  for (const c of cands) {
    if (hasModel(c, model)) return c;
  }
  return null;
}

/**
 * 扫一遍本机可能存放模型的位置，列出每个目录里都有哪些模型。
 * 用途：换机器 / 重装时直接复用已经下好的模型，不用再拉十几 GB。
 */
export function scanModelDirs(disks, extra = []) {
  const seen = new Set();
  const cands = [];
  if (process.env.OLLAMA_MODELS) cands.push(process.env.OLLAMA_MODELS);
  for (const d of disks) cands.push(path.join(d.root, 'ollama', 'models'));
  for (const e of extra) if (e) cands.push(e);

  const out = [];
  for (const c of cands) {
    const key = String(c).toLowerCase().replace(/[\\/]+$/, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const models = listOnDisk(c);
    if (!models.length) continue;
    out.push({ dir: c, models, freeGB: freeSpaceGB(c) });
  }
  out.sort((a, b) => b.models.length - a.models.length);
  return out;
}

export function pickInstallRoot() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const isAscii = (s) => /^[\x20-\x7e]*$/.test(s);
  const cands = [
    path.join(local, 'Programs', 'LocalAI'),
    path.join(local, 'LocalAI'),
    'C:\\LocalAI',
  ];
  for (const d of ['D', 'E', 'F', 'I', 'J']) cands.push(`${d}:\\LocalAI`);

  for (const c of cands) {
    if (!isAscii(c)) continue;              // .lnk 目标必须是 ASCII
    try {
      fs.mkdirSync(c, { recursive: true });
      fs.accessSync(c, fs.constants.W_OK);
      return c;
    } catch { /* 没权限，换下一个 */ }
  }
  return null;
}

/* ------------------------------------------------------- 开机自启 / 共享等 */

export function startupDir() {
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

export function readSettings() {
  const dir = startupDir();
  let autostart = false;
  try { autostart = fs.existsSync(path.join(dir, '启动本地AI.lnk')); } catch { /* ignore */ }
  const host = String(process.env.OLLAMA_HOST || '');
  return {
    autostart,
    startupDir: dir,
    lanShare: host.startsWith('0.0.0.0'),
    ollamaHost: host || '127.0.0.1:11434',
  };
}

/* ------------------------------------------------------------------ 汇总 */

export async function detectAll() {
  const node = detectNode();
  const gpu = detectGpu();
  const disks = detectDisks();
  const ollama = await detectOllama();
  const elevated = isElevated();
  const root = pickInstallRoot();
  const driver = gpu.vendor === 'nvidia' ? driverAdvice(gpu.driver) : null;

  const cfgPath = root ? path.join(root, '配置.json') : null;
  let saved = null;
  try { saved = cfgPath && fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : null; } catch { /* ignore */ }

  const dshInstalled = !!(root && fs.existsSync(path.join(root, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')));

  // 已经装好的模型（用于默认选中 + 复用目录）
  const installedModel = ollama.models.find((m) => m === (saved?.model || '')) || ollama.models[0] || null;
  const existingDirs = scanModelDirs(disks, [saved?.modelDir]);
  const installedDir = installedModel ? findModelDir(installedModel, disks) : null;

  const candidates = modelsForVram(gpu.vramGB);
  const recommended = recommendModel(gpu.vramGB);

  // 默认模型：已装 > 上次配置 > 推荐
  const preferred = installedModel || saved?.model || null;
  const defaultModel = candidates.some((m) => m.tag === preferred) ? preferred : recommended.tag;

  const issues = [];
  if (!node.ok) issues.push({
    level: 'error',
    text: `Node.js 版本偏低（${node.version}），请升级到 20 以上`,
    hint: '关掉本向导，重新双击「① 双击这里开始安装.cmd」，它会自动帮你装好新版 Node.js。',
  });
  if (driver && driver.level !== 'ok') issues.push({ level: driver.level, text: driver.text, hint: driver.hint });
  if (!gpu.found) issues.push({
    level: 'warn',
    text: '未检测到可用的独立显卡 —— 只能用很小的模型，速度会很慢',
    hint: '可以继续安装，向导会自动只列出小模型。想跑大模型需要一块 NVIDIA 独立显卡。',
  });
  else if (gpu.vendor === 'amd') issues.push({
    level: 'warn',
    text: 'AMD 显卡：Ollama 只支持部分型号加速，不支持时会退回 CPU 运行（很慢）',
    hint: '可以继续安装，但速度可能不理想。',
  });
  if (!ollama.installed) issues.push({
    level: 'warn',
    text: '未检测到 Ollama，需要先安装（会请求管理员权限）',
    hint: '不用你操心：点「继续」走到安装那一步，向导会弹窗帮你自动下载安装。',
  });
  if (!root) issues.push({
    level: 'error',
    text: '找不到可写的安装目录（需要纯英文路径）',
    hint: '安装目录默认在 C:\\Users\\你的用户名\\AppData\\Local\\Programs\\LocalAI，必须能写入且路径不含中文。请检查该位置是否被安全软件锁住。',
  });
  if (!elevated) issues.push({
    level: 'info',
    text: '当前非管理员权限 —— 安装到用户目录不需要管理员，安装 Ollama 时需要',
    hint: '装 Ollama 时向导会弹窗，点「自动以管理员身份继续」即可。',
  });

  return {
    node,
    gpu,
    driver,
    disks,
    ollama,
    elevated,
    install: {
      root,
      exists: !!(root && fs.existsSync(path.join(root, 'dsh-runtime'))),
      dshInstalled,
      saved,
      freeGB: root ? freeSpaceGB(root) : null,
    },
    existingDirs,
    settings: readSettings(),
    contextOptions: CONTEXT_OPTIONS.map((cw) => ({ value: cw, label: `${Math.round(cw / 1024)}K` })),
    models: candidates.map((m) => ({
      ...m,
      recommended: m.tag === recommended.tag,
      installed: ollama.models.includes(m.tag),
      // 每个上下文档位对应的估算显存占用（服务端算好，前端直接用，避免两套公式）
      vramEstimate: Object.fromEntries(
        CONTEXT_OPTIONS.map((cw) => [cw, Number(estimateVramGB(m.tag, cw).toFixed(1))]),
      ),
      // 本机某个目录里已经下好了这个模型？（可以复用，不用重下）
      localDir: (existingDirs.find((d) => d.models.includes(m.tag)) || {}).dir || null,
      contextWindow: pickContextWindow(gpu.vramGB, m.gb),
    })),
    suggested: {
      model: defaultModel,
      modelDir: installedDir || saved?.modelDir || suggestModelDir(disks, existingDirs),
      contextWindow: pickContextWindow(gpu.vramGB, (modelInfo(defaultModel) || {}).gb || 0),
    },
    defaultModel: DEFAULT_MODEL,
    issues,
    home: os.homedir(),
  };
}

/** 推荐一个模型存放盘：已经存过模型的目录优先，其次非系统盘里空间最大的 */
function suggestModelDir(disks, existingDirs = []) {
  const withModels = (existingDirs || []).filter((d) => d.models.length);
  if (withModels.length) return withModels[0].dir;

  const pool = disks.filter((d) => d.freeGB >= 30);
  const nonSystem = pool.filter((d) => d.letter !== 'C');
  const best = (nonSystem.length ? nonSystem : pool).sort((a, b) => b.freeGB - a.freeGB)[0];
  return best ? path.join(best.root, 'ollama', 'models') : '';
}
