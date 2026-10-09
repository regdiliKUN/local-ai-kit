/**
 * 环境自动检测：把机器情况一次性摸清楚，交给界面展示。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

import { modelsForVram, recommendModel, pickContextWindow, modelInfo, DEFAULT_MODEL } from './models.mjs';

const OLLAMA_BASE = 'http://127.0.0.1:11434';

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
  if (!out) return { found: false, name: null, vramGB: 0, driver: null };
  const first = out.split(/\r?\n/)[0];
  const [name, mem, driver] = first.split(',').map((s) => s.trim());
  return {
    found: true,
    name,
    vramGB: Math.round(parseInt(mem, 10) / 1024),
    driver,
  };
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

export function findOllamaExe() {
  const probes = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'),
    'C:\\Program Files\\Ollama\\ollama.exe',
  ];
  for (const p of probes) if (p && fs.existsSync(p)) return p;
  const w = run('where ollama');
  return w ? w.split(/\r?\n/)[0].trim() : null;
}

export async function detectOllama() {
  const exe = findOllamaExe();
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

export function hasModel(dir, model) {
  if (!dir) return false;
  const [name, tag = 'latest'] = model.split(':');
  try {
    return fs.existsSync(path.join(dir, 'manifests', 'registry.ollama.ai', 'library', name, tag));
  } catch { return false; }
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

/* ------------------------------------------------------------------ 汇总 */

export async function detectAll() {
  const node = detectNode();
  const gpu = detectGpu();
  const disks = detectDisks();
  const ollama = await detectOllama();
  const elevated = isElevated();
  const root = pickInstallRoot();

  const cfgPath = root ? path.join(root, '配置.json') : null;
  let saved = null;
  try { saved = cfgPath && fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : null; } catch { /* ignore */ }

  const dshInstalled = !!(root && fs.existsSync(path.join(root, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')));

  // 已经装好的模型（用于默认选中 + 复用目录）
  const installedModel = ollama.models.find((m) => m === (saved?.model || '')) || ollama.models[0] || null;
  const installedDir = installedModel ? findModelDir(installedModel, disks) : null;

  const candidates = modelsForVram(gpu.vramGB);
  const recommended = recommendModel(gpu.vramGB);

  // 默认模型：已装 > 上次配置 > 推荐
  const preferred = installedModel || saved?.model || null;
  const defaultModel = candidates.some((m) => m.tag === preferred) ? preferred : recommended.tag;

  const issues = [];
  if (!node.ok) issues.push({ level: 'error', text: `Node.js 版本偏低（${node.version}），请升级到 20 以上` });
  if (!gpu.found) issues.push({ level: 'warn', text: '未检测到 NVIDIA 显卡 —— 只能用很小的模型，速度会很慢' });
  if (!ollama.installed) issues.push({ level: 'warn', text: '未检测到 Ollama，需要先安装（会请求管理员权限）' });
  if (!root) issues.push({ level: 'error', text: '找不到可写的安装目录（需要纯英文路径）' });
  if (!elevated) issues.push({ level: 'info', text: '当前非管理员权限 —— 安装到用户目录不需要管理员，安装 Ollama 时需要' });

  return {
    node,
    gpu,
    disks,
    ollama,
    elevated,
    install: {
      root,
      exists: !!(root && fs.existsSync(path.join(root, 'dsh-runtime'))),
      dshInstalled,
      saved,
    },
    models: candidates.map((m) => ({
      ...m,
      recommended: m.tag === recommended.tag,
      installed: ollama.models.includes(m.tag),
    })),
    suggested: {
      model: defaultModel,
      modelDir: installedDir || saved?.modelDir || suggestModelDir(disks),
      contextWindow: pickContextWindow(gpu.vramGB, (modelInfo(defaultModel) || {}).gb || 0),
    },
    defaultModel: DEFAULT_MODEL,
    issues,
    home: os.homedir(),
  };
}

/** 推荐一个模型存放盘：优先非系统盘、空间大的 */
function suggestModelDir(disks) {
  const pool = disks.filter((d) => d.freeGB >= 30);
  const nonSystem = pool.filter((d) => d.letter !== 'C');
  const best = (nonSystem.length ? nonSystem : pool).sort((a, b) => b.freeGB - a.freeGB)[0];
  return best ? path.join(best.root, 'ollama', 'models') : '';
}
