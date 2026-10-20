/**
 * 机器状态采集。
 *
 * 控制台的「系统概览」页靠它出数据：显卡显存占用、CPU / 内存 / 磁盘用量、
 * Ollama 里正在跑哪些模型、各占多少显存。
 *
 * 设计原则：
 *   - 任何一步失败都只是「拿不到这一项」，不能把整页搞崩
 *   - 解析逻辑单独写成纯函数，方便写单元测试
 *   - 全部走系统自带命令 / Node API，零第三方依赖
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { OLLAMA_BASE } from './ollama.mjs';

/* --------------------------------------------------------------- 命令执行 */

function run(cmd, args, timeout = 6000) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout,
      windowsHide: true,
    }).trim();
  } catch { return null; }
}

/* ------------------------------------------------------------------- 显卡 */

/**
 * 解析 `nvidia-smi --query-gpu=... --format=csv,noheader,nounits` 的输出。
 *
 * 纯函数：输入多行文本，输出显卡数组。写测试时直接喂字符串即可。
 */
export function parseNvidiaSmi(text) {
  if (!text) return [];
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split(',').map((s) => s.trim());
    if (parts.length < 4) continue;
    const num = (v) => {
      const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
      return Number.isFinite(n) ? n : null;
    };
    out.push({
      vendor: 'nvidia',
      name: parts[0] || 'NVIDIA GPU',
      driver: parts[1] || null,
      memoryTotalMB: num(parts[2]),
      memoryUsedMB: num(parts[3]),
      utilization: num(parts[4]),
      temperature: num(parts[5]),
      powerWatts: num(parts[6]),
    });
  }
  return out;
}

/** 解析 rocm-smi 的 json 输出（AMD 显卡的兜底） */
export function parseRocmSmi(text) {
  if (!text) return [];
  let json;
  try { json = JSON.parse(text); } catch { return []; }
  const cards = json.card0 ? Object.keys(json).filter((k) => /^card\d+$/.test(k)) : [];
  const out = [];
  for (const key of cards) {
    const card = json[key] || {};
    const vram = card['VRAM Total Memory (B)'];
    const used = card['VRAM Total Used Memory (B)'];
    if (vram == null) continue;
    out.push({
      vendor: 'amd',
      name: card['Card series'] || card['Card model'] || 'AMD GPU',
      driver: card['Card driver'] || null,
      memoryTotalMB: Math.round(Number(vram) / 1048576) || null,
      memoryUsedMB: used == null ? null : Math.round(Number(used) / 1048576),
      utilization: card['GPU use (%)'] == null ? null : Number(card['GPU use (%)']),
      temperature: card['Temperature (Sensor edge) (C)'] == null
        ? null : Number(card['Temperature (Sensor edge) (C)']),
      powerWatts: null,
    });
  }
  return out;
}

export function detectGpuLive() {
  const nv = parseNvidiaSmi(run('nvidia-smi', [
    '--query-gpu=name,driver_version,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw',
    '--format=csv,noheader,nounits',
  ]));
  if (nv.length) return nv;

  const amd = parseRocmSmi(run('rocm-smi', ['--showmeminfo', 'vram', '--showuse', '--showtemp', '--json']));
  if (amd.length) return amd;

  return [];
}

/* ------------------------------------------------------------------- CPU */

export function detectCpu() {
  const list = os.cpus() || [];
  const cores = list.length;
  const speedMHz = Math.round((list[0]?.speed || 0) / 1000);
  // 采样两次 os.loadavg 是拿不到「瞬时占用」的，Windows 上 loadavg 恒为 0，
  // 所以用两次 idle 差值算占用（需要等一个采样间隔，由调用方决定是否等待）。
  const idle0 = sumIdle(list);
  return {
    model: (list[0]?.model || 'CPU').trim(),
    cores,
    threads: cores,
    speedMHz: speedMHz || null,
    loadavg: os.loadavg ? os.loadavg() : [0, 0, 0],
    idleSnapshot: idle0,
    totalMemoryGB: round1(os.totalmem() / 1073741824),
    freeMemoryGB: round1(os.freemem() / 1073741824),
    usedMemoryGB: round1((os.totalmem() - os.freemem()) / 1073741824),
    memoryPercent: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100),
  };
}

function sumIdle(list) {
  let idle = 0;
  for (const cpu of list) idle += cpu.times.idle;
  return idle;
}

/**
 * 采两次 CPU 时间，算出这一瞬间的占用率（%）。
 *
 * Windows 没有 top / /proc，只能靠 os.cpus() 累计时间的差值。
 * 间隔太短噪声大，200ms 是「看起来准」和「不卡界面」之间比较合适的折中。
 */
export async function sampleCpuUsage(intervalMs = 200) {
  const a = os.cpus();
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, intervalMs));
  const b = os.cpus();
  const t1 = Date.now();

  let idle = 0;
  let total = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i].times;
    const y = b[i]?.times || x;
    const dIdle = y.idle - x.idle;
    const dTotal = (y.user - x.user) + (y.nice - x.nice) + (y.sys - x.sys)
      + (y.irq - x.irq) + (y.idle - x.idle);
    idle += dIdle;
    total += dTotal;
  }
  const usage = total > 0 ? Math.round((1 - idle / total) * 100) : 0;
  return { usage: Math.max(0, Math.min(100, usage)), sampleMs: t1 - t0 };
}

/* ------------------------------------------------------------------ 磁盘 */

/** 某个路径所在磁盘的容量；取不到返回 null */
export function diskUsage(p) {
  try {
    const root = path.parse(path.resolve(p)).root;
    const st = fs.statfsSync(root);
    const totalGB = round1((st.bsize * st.blocks) / 1073741824);
    const freeGB = round1((st.bsize * st.bavail) / 1073741824);
    return {
      path: root,
      totalGB,
      freeGB,
      usedGB: round1(totalGB - freeGB),
      usedPercent: totalGB > 0 ? Math.round(((totalGB - freeGB) / totalGB) * 100) : 0,
    };
  } catch { return null; }
}

/* ---------------------------------------------------------------- Ollama */

export async function ollamaRuntime() {
  try {
    const r = await fetch(`${OLLAMA_BASE}/api/ps`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return { up: false, models: [] };
    const j = await r.json();
    const models = (j.models || []).map((m) => ({
      name: m.name,
      sizeGB: round1((m.size || 0) / 1073741824),
      sizeVramGB: m.size_vram == null ? null : round1(m.size_vram / 1073741824),
      processor: m.processor || null,
      expiresAt: m.expires_at || null,
      contextLength: m.context_length || null,
    }));
    let version = null;
    try {
      const vr = await fetch(`${OLLAMA_BASE}/api/version`, { signal: AbortSignal.timeout(2000) });
      if (vr.ok) version = (await vr.json()).version || null;
    } catch { /* ignore */ }
    return { up: true, version, models };
  } catch { return { up: false, version: null, models: [] }; }
}

/* ------------------------------------------------------------------ 汇总 */

function round1(n) {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

/**
 * 一次采齐所有指标。
 *
 * CPU 占用率要等一个采样间隔（约 200ms），其余都是瞬时的。
 */
export async function collectMetrics({ modelDir = '', sampleMs = 200 } = {}) {
  const [cpu, runtime] = await Promise.all([
    sampleCpuUsage(sampleMs).catch(() => ({ usage: null })),
    ollamaRuntime(),
  ]);

  const gpus = detectGpuLive();
  const mem = detectCpu();

  return {
    at: Date.now(),
    cpu: {
      model: mem.model,
      cores: mem.cores,
      speedMHz: mem.speedMHz,
      usage: cpu.usage,
      loadavg: mem.loadavg,
    },
    memory: {
      totalGB: mem.totalMemoryGB,
      freeGB: mem.freeMemoryGB,
      usedGB: mem.usedMemoryGB,
      percent: mem.memoryPercent,
    },
    gpu: gpus.map((g) => ({
      ...g,
      memoryPercent: g.memoryTotalMB && g.memoryUsedMB != null
        ? Math.round((g.memoryUsedMB / g.memoryTotalMB) * 100) : null,
    })),
    disk: modelDir ? diskUsage(modelDir) : diskUsage(os.homedir()),
    ollama: runtime,
    node: { version: process.versions.node, execPath: process.execPath, platform: `${os.platform()} ${os.release()}` },
  };
}
