/**
 * Ollama 公共逻辑：查找程序、统一环境变量、判断运行中的服务用的是哪个模型目录、（重）启动。
 *
 * 安装向导、命令行安装、启动脚本都用这一份，避免各写各的导致参数不一致。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, execSync } from 'node:child_process';

export const OLLAMA_BASE = 'http://127.0.0.1:11434';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findOllama() {
  const probes = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'),
    'C:\\Program Files\\Ollama\\ollama.exe',
  ];
  for (const p of probes) if (p && fs.existsSync(p)) return p;
  try {
    const w = execSync('where ollama', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return w.split(/\r?\n/)[0].trim() || null;
  } catch { return null; }
}

/** 本部署包推荐的 Ollama 运行参数 */
export function ollamaVars({ modelDir, contextWindow } = {}) {
  const vars = {
    OLLAMA_FLASH_ATTENTION: '1',
    OLLAMA_KV_CACHE_TYPE: 'q8_0',
    OLLAMA_CONTEXT_LENGTH: String(contextWindow || 8192),
    OLLAMA_KEEP_ALIVE: '30m',
  };
  if (modelDir) vars.OLLAMA_MODELS = modelDir;
  return vars;
}

/** 启动 ollama serve / ollama pull 用的完整环境 */
export function ollamaEnv(cfg) {
  return { ...process.env, ...ollamaVars(cfg), OLLAMA_HOST: '127.0.0.1:11434' };
}

/**
 * 把参数写进用户环境变量（setx），这样 Ollama 托盘程序开机自启时也用同一个模型目录和参数。
 * 只影响当前用户，卸载说明里有清理方法。
 */
export function persistOllamaVars(cfg) {
  const failed = [];
  for (const [k, v] of Object.entries(ollamaVars(cfg))) {
    const r = spawnSync('setx', [k, v], { stdio: 'ignore', windowsHide: true });
    if (r.status !== 0) failed.push(k);
  }
  return failed;
}

export async function isUp(url = `${OLLAMA_BASE}/api/version`, timeout = 3000) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(timeout) });
    return true;
  } catch { return false; }
}

/** 运行中的服务能看到的模型名；服务没在跑返回 null */
export async function listServed() {
  try {
    const r = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    return (j.models || []).map((m) => m.name);
  } catch { return null; }
}

/** 某个模型目录里实际存在的官方库模型，形如 qwen3:14b */
export function listOnDisk(dir) {
  const lib = path.join(dir || '', 'manifests', 'registry.ollama.ai', 'library');
  const out = [];
  try {
    for (const name of fs.readdirSync(lib)) {
      for (const tag of fs.readdirSync(path.join(lib, name))) out.push(`${name}:${tag}`);
    }
  } catch { /* 目录不存在 */ }
  return out;
}

export function hasModel(dir, model) {
  if (!dir || !model) return false;
  const full = model.includes(':') ? model : `${model}:latest`;
  return listOnDisk(dir).includes(full);
}

/**
 * 运行中的 Ollama 是否正在使用 dir 作为模型目录。
 *
 * Ollama 不对外暴露模型目录，只能比对：服务看到的官方库模型 == 目录里的模型。
 * 目录为空时无法证明，按「不是」处理（调用方会用正确的目录重启服务）。
 */
export async function servesDir(dir) {
  const served = await listServed();
  if (!served) return false;
  const disk = listOnDisk(dir);
  if (!disk.length) return false;
  const lib = served.filter((n) => !n.includes('/'));
  return disk.length === lib.length && disk.every((m) => lib.includes(m));
}

/** 结束所有 Ollama 进程（含托盘程序和它拉起的子进程） */
export function killOllama() {
  for (const img of ['ollama app.exe', 'ollama.exe']) {
    try { execSync(`taskkill /IM "${img}" /F /T`, { stdio: 'ignore' }); } catch { /* 没在跑 */ }
  }
}

/** 等服务起来，最多 timeoutSec 秒 */
export async function waitUp(timeoutSec = 40) {
  for (let i = 0; i < timeoutSec; i++) {
    await sleep(1000);
    if (await isUp(undefined, 1500)) return true;
  }
  return false;
}

/** 用指定参数启动 ollama serve（detached：不随当前进程退出） */
export function spawnServe(exe, cfg, { detached = false } = {}) {
  const child = spawn(exe, ['serve'], {
    env: ollamaEnv(cfg),
    detached,
    stdio: detached ? 'ignore' : ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (detached) child.unref();
  return child;
}

/** 模型的能力列表（vision / tools / thinking ...），取不到返回 null */
export async function modelCapabilities(model) {
  try {
    const r = await fetch(`${OLLAMA_BASE}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j.capabilities) ? j.capabilities : null;
  } catch { return null; }
}

/** 模型名校验：只允许 Ollama 合法的名字，防止注入到命令行 / YAML 配置 */
export function isValidModelName(s) {
  return typeof s === 'string' && s.length <= 120 && /^[a-z0-9][a-z0-9._\-/]*(:[a-z0-9._\-]+)?$/i.test(s);
}
