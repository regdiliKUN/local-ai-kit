/**
 * 本地 AI 控制台。
 *
 * 装完之后用来管理已经装好的这套东西：
 *   - 模型管理：列出已下载的模型、看体积、一键删除、一键加装（带下载进度）
 *   - 服务设置：开机自启开关、局域网共享开关、启动/停止服务
 *   - 快捷入口：打开安装目录 / 模型目录
 *
 * 和安装向导一样：只监听 127.0.0.1，POST 必须带页面里注入的随机令牌。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createSafeServer, readBody, pipeFile,
  createOriginGuard, createRateLimiter, jsonResponse, applySecurityHeaders, resolveStaticPath,
  openEventStream,
} from './local-http.mjs';
import crypto from 'node:crypto';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadConfig, saveConfig, sanitizeConfig, listBackups, backupConfig } from './config.mjs';
import { strataState, runStrataAction, handleStrata } from './strata.mjs';
import { OLLAMA_BASE, findOllama, isUp, isValidModelName, killOllama, spawnServe, waitUp, ollamaEnv, resolveModelDir } from './ollama.mjs';
import { readSettings, startupDir, freeSpaceGB, detectDisks, detectSystem, pidOnPort } from './detect.mjs';
import { makeLnk } from './make-lnk.mjs';
import { KIT_VERSION, patchProfileText, readPresetStandard, resolveBudgets } from './install.mjs';
import { makeZip } from './zip.mjs';
import { recordUse, usageReport, forgetModel } from './usage.mjs';
import { collectMetrics } from './metrics.mjs';
import { createHistory } from './history.mjs';
import { analyzeModelDir, scanAllModelDirs } from './space.mjs';
import { createPullQueue } from './pull-queue.mjs';
import { streamChat, sanitizeMessages, streamCompare } from './chat.mjs';
import { runBenchmark } from './bench.mjs';
import { exportBundle, importBundle } from './backup.mjs';
import { diagnose, repair } from './repair.mjs';
import { compareVersions } from './version.mjs';
import { appendItem, readList, writeList, clearList, storePath } from './store.mjs';
import { searchLibrary } from './library.mjs';
import { checkNetwork } from './netcheck.mjs';
import { findOrphanBlobs, cleanupOrphanBlobs } from './space.mjs';
import { buildReport, strataReport } from './report.mjs';

/**
 * 安装目录里脚本是**平铺**的（<root>\console.mjs + <root>\ui\），
 * 但仓库里它在 scripts\ 下面。两种布局都支持，省得开发时跑不起来。
 */
function resolveRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  if (fs.existsSync(path.join(here, 'ui', 'console.html'))) return here;
  const up = path.dirname(here);
  if (fs.existsSync(path.join(up, 'ui', 'console.html'))) return up;
  return here;
}

const ROOT = resolveRoot();
const UI = path.join(ROOT, 'ui');
const AUTOSTART_LNK = '启动本地AI.lnk';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

const TOKEN = crypto.randomBytes(24).toString('hex');
let PORT = 0;

const clients = new Set();
let busy = null;            // 当前在忙什么（'pull:模型名' 之类），避免并发操作
// Strata 启停单独一把锁：它跑的是外部进程，和上面 busy 管的模型操作互不相干，
// 但同样不能被双击穿透（strata.mjs 里那个互斥只存在于 handleStrata，线上不走那条路）
let strataBusy = null;
let eventLog = [];

/** 限流器：GET 宽松（页面要轮询），POST 收紧（会改东西） */
const rateLimit = createRateLimiter({ getLimit: 600, postLimit: 60 });

/**
 * 下载队列。
 *
 * 队列状态通过 SSE 推给页面；页面也可以随时 GET /api/queue 取一次快照
 * （比如刚打开页面时）。
 */
const pullQueue = createPullQueue({
  emit: (ev) => broadcast(ev),
});

/** 指标历史：概览页的曲线靠它 */
const metricHistory = createHistory(120);
/** 上一次采到的完整指标（缓存用，别把历史点当完整数据返回） */
let lastMetrics = null;
/** 上一次采指标的时间，用来限流（不需要 1 秒采一次） */
let metricsAt = 0;

const cfg = loadConfig(ROOT) || {};

/** 最近一次的测速结果（SSE 断了也能通过 /api/state 拿到） */
let lastBench = null;
/** 最近一次的体检结果（同上） */
let lastHealth = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- 基础 */

let guard = null;
/** 端口要等 listen 之后才知道，所以守卫延迟创建 */
function originGuard() {
  if (!guard) guard = createOriginGuard({ port: PORT, token: TOKEN });
  return guard;
}

function hostOk(req) {
  return originGuard().hostOk(req);
}

function postOk(req) {
  return originGuard().postOk(req);
}

function json(res, code, body) {
  jsonResponse(res, code, body);
}


function broadcast(ev) {
  eventLog.push(ev);
  if (eventLog.length > 400) eventLog.shift();
  for (const stream of clients) {
    try { stream.send(ev); } catch { /* 客户端已断开 */ }
  }
}

/* ------------------------------------------------------- Ollama 运行状态 */

async function ollamaVersion() {
  try {
    const r = await fetch(`${OLLAMA_BASE}/api/version`, { signal: AbortSignal.timeout(2500) });
    const j = await r.json();
    return j.version || null;
  } catch { return null; }
}

/** 控制台要做管理动作，得先保证 Ollama 在跑 */
async function ensureOllama() {
  if (await isUp(`${OLLAMA_BASE}/api/version`, 1500)) return true;
  const exe = findOllama();
  if (!exe) return false;
  spawnServe(exe, cfg, { detached: true });
  return waitUp(30);
}

/** 模型能力缓存：/api/show 不算慢，但模型多了没必要每次都问一遍 */
const capsCache = new Map();
const CAPS_TTL = 5 * 60 * 1000;
/** 模型列表缓存：页面每 5 秒轮询一次状态，没必要每次都去问 Ollama */
let modelsCache = { at: 0, items: null };

async function listModels() {
  const now = Date.now();
  if (modelsCache.items && now - modelsCache.at < 2500) return modelsCache.items;
  try {
    const r = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    const models = (j.models || []).map((m) => ({
      name: m.name,
      sizeGB: Number(((m.size || 0) / 1e9).toFixed(2)),
      modified: m.modified_at || null,
      params: (m.details && m.details.parameter_size) || '',
      quant: (m.details && m.details.quantization_level) || '',
      family: (m.details && m.details.family) || '',
      digest: m.digest || '',
    }));
    modelsCache = { at: now, items: models };
    return models;
  } catch {
    // 拿不到就沿用上一次的结果，别让列表闪空
    return modelsCache.items || null;
  }
}

/** 单独取某个模型的能力（界面上的标签靠它） */
async function modelCaps(name) {
  const cached = capsCache.get(name);
  if (cached && Date.now() - cached.at < CAPS_TTL) return cached.caps;
  const caps = await capsFor(name);
  capsCache.set(name, { at: Date.now(), caps });
  return caps;
}

/* --------------------------------------------------------- 开机自启开关 */

function setAutostart(on) {
  const dir = startupDir();
  const lnk = path.join(dir, AUTOSTART_LNK);
  if (!on) {
    try { fs.rmSync(lnk, { force: true }); } catch { /* ignore */ }
    return { ok: true, autostart: false };
  }
  const target = path.join(ROOT, 'start-ai.cmd');
  const icon = path.join(ROOT, 'icons', 'icon-start.ico');
  if (!/^[\x20-\x7e]*$/.test(target)) {
    return { ok: false, error: `安装目录含非 ASCII 字符，无法创建自启项：${target}` };
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    makeLnk({
      lnkPath: lnk,
      target,
      workingDir: ROOT,
      iconPath: fs.existsSync(icon) ? icon : target,
      description: '开机自动启动本地 AI 工作台',
    });
    return { ok: true, autostart: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/* --------------------------------------------------------- 局域网共享开关 */

/**
 * 局域网共享 = 把 Ollama 的 API 暴露到 0.0.0.0:11434，让同网段的手机 / 其它电脑能调用。
 * 这会让同一个 WiFi 下的任何人（以及某些公共网络里的其他人）都能访问你的模型，
 * 所以默认关闭，打开时界面必须给出明确警告。
 */
function setLanShare(on) {
  const val = on ? '0.0.0.0:11434' : null;
  let r;
  if (on) {
    r = spawnSync('setx', ['OLLAMA_HOST', val], { stdio: 'ignore', windowsHide: true });
    if (r.status !== 0) return { ok: false, error: '写入环境变量失败' };
  } else {
    r = spawnSync('reg', ['delete', 'HKCU\\Environment', '/v', 'OLLAMA_HOST', '/f'], { stdio: 'ignore', windowsHide: true });
    // 删一个不存在的值会返回非 0，属于正常
  }
  // setx 只对新进程生效，当前进程的 process.env 不会变。
  // 不同步的话，界面上的开关会一直显示「关闭」，自愈拉起也会用旧值。
  if (on) process.env.OLLAMA_HOST = val;
  else delete process.env.OLLAMA_HOST;
  // 让改动生效：重启 Ollama
  killOllama();
  return { ok: true, lanShare: on };
}

/* ------------------------------------------------------------- 服务控制 */

function stopService() {
  const dshPid = pidOnPort(3080);
  if (dshPid) { try { execSync(`taskkill /PID ${dshPid} /T /F`, { stdio: 'ignore' }); } catch { /* ignore */ } }
  killOllama();
  return { ok: true, dshStopped: !!dshPid };
}

function startWorkbench() {
  const cmd = path.join(ROOT, 'start-ai.cmd');
  if (!fs.existsSync(cmd)) return { ok: false, error: `找不到启动脚本：${cmd}` };
  spawn('cmd.exe', ['/c', 'start', '', cmd], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true };
}

function openFolder(p) {
  try {
    spawn('explorer.exe', [p], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

/** 在新窗口里打开卸载程序（它自己会一步步问用户，这里不代替它做决定） */
function launchUninstall() {
  const cmd = path.join(ROOT, '卸载.cmd');
  if (!fs.existsSync(cmd)) return { ok: false, error: `找不到卸载程序：${cmd}` };
  spawn('cmd.exe', ['/c', 'start', '', cmd], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true };
}

/* --------------------------------------------------------------- 拉模型 */

function createTracker(emit) {
  const parts = new Map();
  let lastFlush = 0;
  let lastAt = 0;
  let lastGot = 0;
  let speed = 0;
  return {
    layer(id, got, total) {
      if (!id) return;
      const cur = parts.get(id) || { got: 0, total: 0 };
      if (total > 0) cur.total = total;
      cur.got = Math.max(cur.got, Math.min(got, cur.total || got));
      parts.set(id, cur);
    },
    flush(force) {
      const now = Date.now();
      if (!force && now - lastFlush < 300) return;
      lastFlush = now;
      let got = 0; let total = 0;
      for (const p of parts.values()) { got += p.got; total += p.total; }
      if (lastAt) {
        const dt = (now - lastAt) / 1000;
        if (dt > 0.3 && got >= lastGot) {
          const inst = (got - lastGot) / dt;
          speed = speed ? speed * 0.6 + inst * 0.4 : inst;
        }
      }
      lastAt = now; lastGot = got;
      const pct = total > 0 ? Math.min(99, Math.floor((got / total) * 100)) : 0;
      emit({ type: 'progress', percent: pct, got, total, speed, eta: speed > 0 && total > got ? (total - got) / speed : 0 });
    },
  };
}

async function doPull(model, emit) {
  emit({ type: 'log', text: `开始下载 ${model} ...` });
  const tracker = createTracker(emit);
  const r = await fetch(`${OLLAMA_BASE}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: true }),
  });
  if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);

  const dec = new TextDecoder();
  let buf = '';
  const handle = (line) => {
    const s = line.trim();
    if (!s) return;
    let j;
    try { j = JSON.parse(s); } catch { return; }
    if (j.error) throw new Error(j.error);
    if (j.total) {
      tracker.layer(j.digest || j.status, j.completed || 0, j.total);
      tracker.flush();
    } else if (j.status && j.status !== 'success') {
      emit({ type: 'log', text: j.status });
    }
  };
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
  }
  if (buf.trim()) handle(buf);
  emit({ type: 'progress', percent: 100 });
  emit({ type: 'log', text: `${model} 下载完成。` });
}

async function doDelete(model, emit) {
  emit({ type: 'log', text: `正在删除 ${model} ...` });
  const r = await fetch(`${OLLAMA_BASE}/api/delete`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status} ${t}`.trim());
  }
  emit({ type: 'log', text: `${model} 已删除，磁盘空间已释放。` });
}

/* ------------------------------------------------------- 上下文与模型配置 */

const CTX_MIN = 2048;
const CTX_MAX = 262144;
const CTX_PRESETS = [4096, 8192, 16384, 32768, 65536, 131072];

/** 覆盖前先留一份，路径带时间戳，出错能拿回来 */
function backupFile(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const dst = `${file}.bak-${Date.now()}`;
    fs.copyFileSync(file, dst);
    return dst;
  } catch { return null; }
}

/** 模型是否支持视觉：决定写 [text] 还是 [text, image]。
 *  拿不到就沿用安装时的保守做法（按支持视觉处理）。 */
async function capsFor(model) {
  try {
    const r = await fetch(`${OLLAMA_BASE}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    return (await r.json()).capabilities || null;
  } catch { return null; }
}

function readContextState() {
  const cur = loadConfig(ROOT) || {};
  const b = resolveBudgets(cur);
  return {
    model: cur.model || '',
    modelDir: cur.modelDir || '',
    contextWindow: b.contextWindow,
    maxTokens: b.maxTokens,
    headroomTokens: b.headroomTokens,
    thresholdRatio: b.thresholdRatio,
    retainRatio: b.retainRatio,
    budget: b.budget,
    auto: b.auto,
    overridden: b.overridden,
  };
}

/**
 * 写入 配置.json 并重写两个 profile。
 *
 * 与安装向导走的是同一套函数（patchProfileText / applyCompactionBudget），
 * 所以控制台改出来的结果和重跑安装向导完全一致，不会出现两套逻辑各写各的。
 */
async function applyConfig(body) {
  const cur = loadConfig(ROOT) || {};
  if (!cur.model && !body.model) throw new Error('还没有配置过模型，请先运行安装向导。');

  const next = { ...cur };
  if (typeof body.model === 'string' && body.model.trim()) next.model = body.model.trim();

  if (body.contextWindow !== undefined && body.contextWindow !== null && body.contextWindow !== '') {
    const n = Number(body.contextWindow);
    if (!Number.isFinite(n)) throw new Error('上下文长度必须是数字');
    next.contextWindow = Math.min(CTX_MAX, Math.max(CTX_MIN, Math.round(n)));
  }

  // 留空 = 交回自动推导；填了就用填的（越界会被 resolveBudgets 夹住）
  for (const k of ['maxTokens', 'headroomTokens', 'thresholdRatio', 'retainRatio']) {
    if (!(k in body)) continue;
    const v = body[k];
    if (v === null || v === '') delete next[k];
    else if (Number.isFinite(Number(v)) && Number(v) > 0) next[k] = Number(v);
  }

  const b = resolveBudgets(next);
  if (b.budget <= 0) {
    throw new Error(
      `压力预算 = 窗口 ${b.contextWindow} − 输出 ${b.maxTokens} − 余量 ${b.headroomTokens} ` +
      `= ${b.budget}，必须大于 0。把「输出上限」或「压缩余量」调小一点。`);
  }

  const caps = await capsFor(next.model);
  const input = caps && !caps.includes('vision') ? '[text]' : '[text, image]';

  const backups = [];
  backups.push(backupFile(path.join(ROOT, '配置.json')));
  saveConfig(ROOT, next);

  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const presetText = readPresetStandard(ROOT);
  const notes = [];
  for (const profile of ['web', 'headless']) {
    const dir = path.join(home, 'profiles', profile);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'cordis.patch.yml');
    const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const { text, notes: n } = patchProfileText(prev, {
      profile, model: next.model, contextWindow: b.contextWindow, input, presetText, budgets: b,
    });
    if (prev !== text) {
      backups.push(backupFile(file));
      fs.writeFileSync(file, text, 'utf8');
      notes.push(`${profile} 档：${n.join('、')}`);
    } else {
      notes.push(`${profile} 档：已是最新，未改动`);
    }
  }

  for (const key of Object.keys(cfg)) delete cfg[key];
  Object.assign(cfg, next);
  return { config: next, budgets: b, notes, backups: backups.filter(Boolean) };
}

/* ------------------------------------------------------------------ 体检 */

/**
 * 跑 healthcheck/quick.mjs，把每一行 JSON 转成 SSE 事件。
 *
 * 用 process.execPath 而不是 'node'：控制台本身就是 node 起的，
 * 直接复用同一个可执行文件，避免用户 PATH 里没有 node 的情况。
 */
function runHealth(quick) {
  const script = path.join(ROOT, 'healthcheck', 'quick.mjs');
  if (!fs.existsSync(script)) {
    busy = null;
    broadcast({ type: 'health-error', text: '找不到 healthcheck/quick.mjs' });
    return;
  }
  const args = [script, '--json'];
  if (quick) args.push('--quick');

  // 逐题记录：用来画「各分类通过率」
  const byCategory = new Map();
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, LOCAL_AI_MODEL: cfg.model || '', LOCAL_AI_BASE_URL: `${OLLAMA_BASE}/v1` },
    windowsHide: true,
  });

  let buf = '';
  const onLine = (line) => {
    const t = line.trim();
    if (!t) return;
    let ev;
    try { ev = JSON.parse(t); } catch {
      broadcast({ type: 'health-log', text: t });
      return;
    }
    if (ev.type === 'log') broadcast({ type: 'health-log', text: ev.text });
    else if (ev.type === 'item') {
      const cat = ev.cat || '其它';
      const row = byCategory.get(cat) || { cat, total: 0, passed: 0 };
      row.total += 1;
      if (ev.ok) row.passed += 1;
      byCategory.set(cat, row);
      broadcast({ type: 'health-item', id: ev.id, ok: ev.ok, cat: ev.cat });
    } else if (ev.type === 'done') {
      lastHealth = {
        ...ev.summary,
        quick: !!quick,
        at: Date.now(),
        categories: [...byCategory.values()].map((r) => ({
          cat: r.cat, total: r.total, passed: r.passed, rate: r.total ? r.passed / r.total : 0,
        })),
      };
      // 存一份历史，用来画「这段时间体检成绩的变化」
      try {
        appendItem('health', {
          at: lastHealth.at,
          model: lastHealth.model || cfg.model || '',
          ok: (lastHealth.verdicts || []).every((v) => v.ok),
          rate: lastHealth.eval ? lastHealth.eval.rate : null,
          passed: lastHealth.eval ? lastHealth.eval.passed : null,
          total: lastHealth.eval ? lastHealth.eval.total : null,
          share: lastHealth.stability ? lastHealth.stability.share : null,
          elapsed: lastHealth.elapsed_s || null,
        });
      } catch { /* 存历史失败不影响体检结果 */ }
      broadcast({ type: 'health-done', ok: ev.ok, summary: lastHealth });
    } else if (ev.type === 'error') broadcast({ type: 'health-error', text: ev.text });
  };

  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    const parts = buf.split(/\r?\n/);
    buf = parts.pop() || '';
    for (const p of parts) onLine(p);
  });
  child.stderr.on('data', (d) => broadcast({ type: 'health-log', text: d.toString('utf8').trim() }));

  child.on('error', (e) => {
    busy = null;
    broadcast({ type: 'health-error', text: `启动体检失败：${e.message}` });
  });
  child.on('exit', (code) => {
    if (buf.trim()) onLine(buf);
    busy = null;
    if (code !== 0 && code !== 2) {
      broadcast({ type: 'health-error', text: `体检进程退出（code=${code}）` });
    }
    broadcast({ type: 'idle' });
  });
}

/* ------------------------------------------------------------------ 日志 */

/**
 * 控制台自己的日志文件。
 *
 * 用户报问题时最需要的就是这个：把 %TEMP%\localai-console.log 发过来就行。
 * 超过 2MB 就轮转一份（只留最新 + 上一份），免得日志无限涨。
 */
const LOG_FILE = path.join(os.tmpdir(), 'localai-console.log');
const LOG_MAX_BYTES = 2 * 1024 * 1024;
let logStream = null;
function initLog() {
  try {
    // 轮转：太大就把旧的挪成 .1
    try {
      if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) {
        fs.rmSync(`${LOG_FILE}.1`, { force: true });
        fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
      }
    } catch { /* ignore */ }
    logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    logStream.write(`\n===== 本地 AI 控制台 ${new Date().toLocaleString()} =====\n`);
  } catch { logStream = null; }
}
function logLine(text) {
  if (!logStream) return;
  try { logStream.write(`[${new Date().toLocaleTimeString()}] ${text}\n`); } catch { /* ignore */ }
}

/** 读日志最后 n 行 */
function tailLog(lines = 200) {
  try {
    const text = fs.readFileSync(LOG_FILE, 'utf8');
    const all = text.split(/\r?\n/);
    return all.slice(Math.max(0, all.length - lines)).join('\n');
  } catch { return '（还没有日志）'; }
}

/** 组装 /api/metrics 的内容（首屏注入和接口共用同一份逻辑与形状） */
async function buildMetrics({ fast = false } = {}) {
  const now = Date.now();
  // 1 秒内重复请求直接用缓存，省掉一次 nvidia-smi 调用
  let current = null;
  if (now - metricsAt < 1000 && lastMetrics) {
    current = lastMetrics;
  } else {
    // 首屏要快：采样 0ms，数字粗糙一点没关系，反正 2 秒后就有准的了
    current = await collectMetrics({ modelDir: resolveModelDir(cfg.modelDir), sampleMs: fast ? 0 : 200 });
    lastMetrics = current;
    metricHistory.push({
      at: current.at,
      cpu: current.cpu.usage,
      memory: current.memory.percent,
      gpu: current.gpu[0] ? current.gpu[0].utilization : null,
      vram: current.gpu[0] ? current.gpu[0].memoryPercent : null,
      disk: current.disk ? current.disk.usedPercent : null,
    });
    metricsAt = now;
  }
  return {
    current,
    history: {
      cpu: metricHistory.series('cpu'),
      memory: metricHistory.series('memory'),
      gpu: metricHistory.series('gpu'),
      vram: metricHistory.series('vram'),
      disk: metricHistory.series('disk'),
      at: metricHistory.series('at'),
    },
  };
}

/** 组装 /api/config（GET）的内容（首屏注入和接口复用同一份逻辑） */
async function buildConfigPayload() {
  const cs = readContextState();
  const running = !!(await ollamaVersion());
  const models = running ? await listModels() : [];
  return {
    ...cs,
    models: (models || []).map((m) => m.name),
    limits: { min: CTX_MIN, max: CTX_MAX },
    presets: CTX_PRESETS,
    kitVersion: KIT_VERSION,
    dshHome: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  };
}

/** 组装 /api/state 的内容（首屏注入和接口复用同一份逻辑） */
async function buildState() {
  const running = !!(await ollamaVersion());
  const models = running ? await listModels() : [];
  const settings = readSettings();
  const disks = detectDisks();
  // 模型目录以「Ollama 实际在用的那个」为准 —— 配置里的 modelDir 可能是别的部署留下的
  const modelDir = resolveModelDir(cfg.modelDir);
  return {
    root: ROOT,
    backend: cfg.backend || 'ollama',
    model: cfg.model || '',
    modelDir,
    configModelDir: cfg.modelDir || '',
    contextWindow: cfg.contextWindow || 8192,
    running,
    models: models || [],
    settings,
    disks: disks.map((d) => ({ letter: d.letter, freeGB: d.freeGB, totalGB: d.totalGB })),
    modelDirFreeGB: modelDir ? freeSpaceGB(modelDir) : null,
    busy,
    queue: pullQueue.snapshot(),
    bench: lastBench,
    health: lastHealth,
    logPath: path.join(os.tmpdir(), 'localai-console.log'),
    selfHeal: healStore.enabled,
    // Strata 部署时把三个服务的信息一并带出来（并入同一个界面）
    strata: cfg.backend === 'strata' ? await strataState(cfg) : null,
  };
}

/* ------------------------------------------------------------ 服务自愈 */

/**
 * 看门狗：Ollama 意外退出时自动把它拉起来。
 *
 * 常见场景：显卡驱动更新后进程崩了、用户误关了托盘程序、系统休眠后没恢复。
 * 这时候工作台会一直报「连不上」，用户往往不知道该做什么。
 *
 * 默认关闭 —— 擅自拉起服务可能不是用户想要的（比如他就是想省显存）。
 */
const healStore = { enabled: false };
let healTimer = null;
let lastOllamaUp = null;

function loadHealSetting() {
  try {
    const list = readList('notes');
    const item = list.find((n) => n && n.kind === 'selfheal');
    if (item) healStore.enabled = !!item.enabled;
  } catch { /* ignore */ }
}

function saveHealSetting(enabled) {
  healStore.enabled = !!enabled;
  try {
    const list = readList('notes').filter((n) => !(n && n.kind === 'selfheal'));
    list.push({ kind: 'selfheal', enabled: healStore.enabled, at: Date.now() });
    writeList('notes', list);
  } catch { /* ignore */ }
}

async function healTick() {
  const up = await isUp(`${OLLAMA_BASE}/api/version`, 1500);
  if (lastOllamaUp === null) lastOllamaUp = up;
  if (lastOllamaUp && !up) {
    // 之前是活的，现在没了 —— 尝试拉起来
    logLine('[自愈] 检测到 Ollama 掉了，正在重启');
    const ok = await ensureOllama();
    logLine(ok ? '[自愈] Ollama 已重启' : '[自愈] 重启失败');
    if (ok) broadcast({ type: 'notice', text: 'Ollama 意外退出，已自动重启', tone: 'warn' });
    else broadcast({ type: 'notice', text: 'Ollama 意外退出，自动重启没成功 —— 去「修复中心」看看', tone: 'error' });
  }
  lastOllamaUp = up;
}

function startHealWatchdog() {
  if (healTimer) clearInterval(healTimer);
  healTimer = null;
  if (!healStore.enabled) return;
  lastOllamaUp = null;
  healTimer = setInterval(() => { healTick().catch(() => {}); }, 15000);
  if (typeof healTimer.unref === 'function') healTimer.unref();
}

/* ------------------------------------------------------------------ 路由 */

const server = createSafeServer(async (req, res) => {
  if (!hostOk(req)) {
    applySecurityHeaders(res);
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('forbidden');
  }
  if (req.method !== 'GET' && !postOk(req)) return json(res, 403, { error: '请求来源不可信' });

  // 限流：正常页面轮询远低于额度，超了说明有别的东西在猛打这个服务
  const limit = rateLimit(req);
  if (!limit.ok) return json(res, 429, { error: '请求太频繁，请稍候再试' });

  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  /* ---------------------------------------------------------- 系统概览 */
  // 只读接口，放在 Strata 适配器之前 —— 两种部署模式都要能看机器状态。
  if (p === '/api/metrics') {
    return json(res, 200, await buildMetrics());
  }

  /* ---------------------------------------------------------------- 日志 */
  // 只读接口，放在 Strata 适配器之前 —— 两种部署模式都要能看到自己的日志。
  if (p === '/api/logs' && req.method === 'GET') {
    const n = Math.max(10, Math.min(5000, Number(url.searchParams.get('lines')) || 200));
    return json(res, 200, { path: LOG_FILE, text: tailLog(n) });
  }

  if (p === '/api/logs/download' && req.method === 'GET') {
    applySecurityHeaders(res);
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="localai-console.log"',
      'Cache-Control': 'no-store',
    });
    return res.end(tailLog(5000));
  }

  /* -------------------------------------------------------- 诊断报告 */
  if (p === '/api/diagnose/bundle' && req.method === 'GET') {
    // 找人帮忙时最省事的东西：一个 zip，里面有报告、脱敏配置、日志、系统信息
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const files = [];
    const safe = async (name, fn) => {
      try { files.push({ name, data: await fn() }); }
      catch (e) { files.push({ name, data: `生成失败：${(e && e.message) || e}` }); }
    };
    await safe('报告.txt', () => (cfg.backend === 'strata'
      ? strataReport({ root: ROOT, cfg, kitDir: ROOT, logText: tailLog(300) })
      : buildReport({ root: ROOT, cfg, kitDir: ROOT, logText: tailLog(300) })));
    // 配置必须脱敏：里面可能有局域网共享开关和自定义路径
    await safe('配置.json', () => JSON.stringify(sanitizeConfig(cfg), null, 2));
    await safe('日志.txt', () => tailLog(3000));
    // 用 detectSystem：console.mjs 里没有 detectCached（那是 installer 的）
    await safe('系统信息.json', async () => JSON.stringify(await detectSystem(), null, 2));
    await safe('版本.json', () => JSON.stringify({
      kit: KIT_VERSION, node: process.version, platform: process.platform,
      arch: process.arch, backend: cfg.backend, at: new Date().toISOString(),
    }, null, 2));
    await safe('怎么用.txt', () => [
      '这是本地 AI 控制台导出的诊断包。',
      '',
      '· 报告.txt       —— 给人看的现状说明',
      '· 配置.json      —— 脱敏后的配置（不含任何密钥）',
      '· 日志.txt       —— 最近的运行日志',
      '· 系统信息.json  —— 显卡 / 内存 / 磁盘 / 已装组件',
      '· 版本.json      —— 工具版本与运行环境',
      '',
      '遇到问题把这个 zip 整个发出去就行，不用再一条条截图。',
    ].join('\n'));

    const zip = makeZip(files);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': zip.length,
      // HTTP 头只能是 ASCII：中文文件名必须走 RFC 5987 的 filename*，
      // 直接塞进 filename="..." 会让 Node 抛 ERR_INVALID_CHAR，整个响应 500
      'Content-Disposition': `attachment; filename="local-ai-diagnose-${stamp}.zip"; `
        + `filename*=UTF-8''${encodeURIComponent(`local-ai-诊断包-${stamp}.zip`)}`,
      'Cache-Control': 'no-store',
    });
    return res.end(zip);
  }

  if (p === '/api/report' && req.method === 'GET') {
    // 两种部署模式都能出报告 —— 换机器 / 找人帮忙时最需要的就是这个
    const text = cfg.backend === 'strata'
      ? await strataReport({ root: ROOT, cfg, kitDir: ROOT, logText: tailLog(300) })
      : buildReport({
        root: ROOT,
        cfg,
        metrics: await collectMetrics({ modelDir: resolveModelDir(cfg.modelDir) }),
        diagnose: await diagnose({ root: ROOT, cfg, kitDir: ROOT }),
        health: lastHealth,
        bench: lastBench,
        logText: tailLog(300),
      });
    const name = `localai-diagnostic-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.txt`;
    applySecurityHeaders(res);
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    });
    return res.end(text);
  }

  /* ------------------------------------------------- Strata 服务（并存模式） */
  // Strata 部署不再「接管」控制台，而是把它的三个服务并进来一起看。
  if (cfg.backend === 'strata') {
    if (p === '/api/strata/state' && req.method === 'GET') {
      return json(res, 200, await strataState(cfg));
    }
    if (p === '/api/strata/service' && req.method === 'POST') {
      // 必须自己加锁：strata.mjs 里那个 operation 互斥只存在于 handleStrata，
      // 线上走的是这里，双击按钮会真的同时跑两个外部进程去 Launch 引擎。
      if (strataBusy) return json(res, 409, { error: `正在${strataBusy}，请稍候` });
      const action = String((await readBody(req)).action || '').trim();
      if (!['engine', 'webui', 'workbench', 'stop'].includes(action)) {
        return json(res, 400, { error: '未知操作' });
      }
      strataBusy = action === 'stop' ? '停止服务' : '启动服务';
      try {
        const result = await runStrataAction(cfg, action);
        return json(res, result.ok ? 200 : 409, result);
      } catch (e) {
        return json(res, 400, { error: String(e.message || e) });
      } finally { strataBusy = null; }
    }
    // 这两件事在 Strata 部署下会写坏东西，直接挡住并说清楚原因
    if (p === '/api/config' && req.method === 'POST') {
      return json(res, 409, { error: '当前是 Strata 部署，工作台配置由 Strata 自己管理，不能在这里改。' });
    }
    if (p === '/api/service' && req.method === 'POST') {
      return json(res, 409, { error: '当前是 Strata 部署，服务启停请用「服务」页。' });
    }
  }

  /* ---------------------------------------------------------- 空间分析 */
  if (p === '/api/space') {
    const dir = resolveModelDir(cfg.modelDir);
    const primary = analyzeModelDir(dir);
    // 全盘扫一遍：模型可能装在别的盘上（比如换过机器、或 Ollama 装在 C 盘）
    const others = scanAllModelDirs(detectDisks(), [dir]).filter((d) => d.dir !== primary.dir);
    return json(res, 200, { primary, others });
  }

  /* ------------------------------------------------------ 模型能力标签 */
  // 视觉 / 工具调用能力，界面上用小标签显示
  if (p === '/api/model-caps') {
    const models = (await listModels()) || [];
    const out = {};
    for (const m of models) out[m.name] = await modelCaps(m.name);
    return json(res, 200, out);
  }

  if (p === '/api/state') {
    return json(res, 200, await buildState());
  }

  if (p === '/api/config' && req.method === 'GET') {
    return json(res, 200, await buildConfigPayload());
  }

  if (p === '/api/config' && req.method === 'POST') {
    if (busy) return json(res, 409, { error: `正在忙：${busy}` });
    if (pullQueue.isBusy()) return json(res, 409, { error: '正在下载模型，等下载完再改配置' });
    busy = 'config';
    try {
      const body = await readBody(req);
      const out = await applyConfig(body);
      return json(res, 200, { ok: true, ...out });
    } catch (e) {
      return json(res, e.statusCode || 400, { error: String((e && e.message) || e) });
    } finally { busy = null; }
  }

  if (p === '/api/health' && req.method === 'POST') {
    if (busy) return json(res, 409, { error: `正在忙：${busy}` });
    // 先占位再 await：readBody 期间第二个请求会从上面那行检查溜过去
    busy = 'health';
    const body = await readBody(req);
    runHealth(!!(body && body.quick));
    return json(res, 202, { started: true });
  }

  if (p === '/api/events') {
    let stream = null;
    stream = openEventStream(res, { onDead: () => { if (stream) clients.delete(stream); } });
    for (const e of eventLog) stream.send(e);
    clients.add(stream);
    req.on('close', () => clients.delete(stream));
    return;
  }

  /* ------------------------------------------------------------ 模型对比 */
  if (p === '/api/compare' && req.method === 'POST') {
    const body = await readBody(req);
    const models = (Array.isArray(body.models) ? body.models : [])
      .map((m) => String(m || '').trim())
      .filter((m) => isValidModelName(m))
      .slice(0, 4);
    if (!models.length) return json(res, 400, { error: '至少选一个模型' });
    const messages = sanitizeMessages(body.messages);
    if (!messages.length) return json(res, 400, { error: '至少要有一条消息' });
    if (!(await ensureOllama())) return json(res, 400, { error: 'Ollama 没在运行' });
    await streamCompare(res, { models, messages, options: body.options || {} });
    return;
  }

  /* ------------------------------------------------------------ 试用模型 */
  if (p === '/api/chat' && req.method === 'POST') {
    const body = await readBody(req);
    const model = String(body.model || cfg.model || '').trim();
    if (!isValidModelName(model)) return json(res, 400, { error: '模型名不合法' });
    const messages = sanitizeMessages(body.messages);
    if (!messages.length) return json(res, 400, { error: '至少要有一条消息' });
    if (!(await ensureOllama())) return json(res, 400, { error: 'Ollama 没在运行' });
    // 记一笔使用：以后能回答「哪些模型装完就没碰过」
    try { recordUse(ROOT, model, 'chat'); } catch { /* 记录失败不该影响对话 */ }
    await streamChat(res, { model, messages, options: body.options || {} });
    return;
  }

  /* ------------------------------------------------------------ 版本检查 */
  if (p === '/api/version-check' && req.method === 'GET') {
    // 离线也能用：拿不到就只报本地版本
    let latest = null;
    let note = '';
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch('https://api.github.com/repos/regdiliKUN/local-ai-kit/releases/latest', {
        headers: { 'User-Agent': 'local-ai-kit' },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (r.ok) {
        const j = await r.json();
        latest = String(j.tag_name || j.name || '').replace(/^v/, '') || null;
      } else note = `GitHub 返回 ${r.status}`;
    } catch (e) { note = '连不上 GitHub（离线？）'; }
    // 注意：GitHub 上最新的 Release 可能比本地还旧（本地是开发版），
    // 所以要真的比大小，不能只比「不一样」。
    const newer = latest && compareVersions(latest, KIT_VERSION) > 0;
    return json(res, 200, { current: KIT_VERSION, latest, note, update: !!newer });
  }

  /* ---------------------------------------------------------- 网络诊断 */
  if (p === '/api/netcheck' && req.method === 'GET') {
    return json(res, 200, await checkNetwork());
  }

  /* ---------------------------------------------------------- 清理残留 */
  // 注意不是 /api/usage —— 那个已经被「每天 token 用量」占了
  if (p === '/api/model-usage' && req.method === 'GET') {
    const running = !!(await ollamaVersion());
    const models = running ? (await listModels() || []).map((m) => m.name) : [];
    const staleDays = Math.max(1, Math.min(365, Number(new URL(req.url, 'http://x').searchParams.get('staleDays')) || 30));
    return json(res, 200, { running, ...usageReport(ROOT, models, staleDays) });
  }

  if (p === '/api/cleanup' && req.method === 'GET') {
    const dir = resolveModelDir(cfg.modelDir);
    const found = findOrphanBlobs(dir);
    return json(res, 200, {
      dir,
      count: found.blobs.length,
      totalGB: found.totalGB,
      preview: found.blobs.slice(0, 20).map((b) => ({ name: b.name, mb: Math.round(b.bytes / 1048576) })),
    });
  }

  if (p === '/api/cleanup' && req.method === 'POST') {
    const body = await readBody(req);
    const dryRun = body.dryRun !== false;
    const dir = resolveModelDir(cfg.modelDir);
    if (!dir) return json(res, 400, { error: '还没配置模型目录' });
    const out = cleanupOrphanBlobs(dir, { dryRun });
    return json(res, 200, { ok: true, dryRun, ...out });
  }

  /* ---------------------------------------------------------- 官方模型库 */
  if (p === '/api/library' && req.method === 'GET') {
    const q = String(url.searchParams.get('q') || '');
    const out = await searchLibrary(q);
    return json(res, 200, { query: q, ...out });
  }

  /* ------------------------------------------------------ 配置检查点 */
  if (p === '/api/config/checkpoints' && req.method === 'GET') {
    const list = listBackups(ROOT).map((b) => ({
      file: path.basename(b.file),
      at: b.mtime,
      size: (() => { try { return fs.statSync(b.file).size; } catch { return 0; } })(),
    }));
    return json(res, 200, { items: list, current: path.basename(path.join(ROOT, '配置.json')) });
  }

  if (p === '/api/config/restore' && req.method === 'POST') {
    const body = await readBody(req);
    const name = path.basename(String(body.file || ''));
    if (!name || !name.startsWith('配置.json.') || !name.endsWith('.bak')) {
      return json(res, 400, { error: '备份文件名不合法' });
    }
    const file = path.join(ROOT, name);
    if (!fs.existsSync(file)) return json(res, 404, { error: '找不到这个备份' });
    try {
      // 回滚前先给当前状态也留一份，错了还能再退回来
      backupConfig(ROOT);
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
      saveConfig(ROOT, parsed);
      for (const key of Object.keys(cfg)) delete cfg[key];
      Object.assign(cfg, sanitizeConfig(parsed));
      return json(res, 200, { ok: true, restored: name, config: cfg });
    } catch (e) {
      return json(res, 400, { error: `回滚失败：${e.message}` });
    }
  }

  /* ---------------------------------------------------- 离线安装包 */
  if (p === '/api/package' && req.method === 'POST') {
    const body = await readBody(req);
    const withNode = !!body.withNode;
    const outDir = path.join(os.tmpdir(), 'local-ai-offline');
    try {
      const { execFileSync } = await import('node:child_process');
      const script = path.join(ROOT, 'scripts', 'package-offline.mjs');
      if (!fs.existsSync(script)) return json(res, 400, { error: '当前部署里没有打包脚本' });
      const args = [script, outDir];
      if (withNode) args.push('--with-node');
      const out = execFileSync(process.execPath, args, { encoding: 'utf8', timeout: 300000 });
      const zipMatch = out.match(/压缩包：(.+?)（/);
      return json(res, 200, {
        ok: true,
        zip: zipMatch ? zipMatch[1].trim() : null,
        dir: outDir,
        output: out.trim(),
      });
    } catch (e) {
      return json(res, 500, { error: `打包失败：${e.message}` });
    }
  }

  /* ------------------------------------------------------------ 模型别名 */
  // Ollama 的 /api/copy 会新建一份清单指向同样的 blob —— 不占额外磁盘
  if (p === '/api/alias' && req.method === 'POST') {
    const body = await readBody(req);
    const from = String(body.from || '').trim();
    const to = String(body.to || '').trim();
    if (!isValidModelName(from) || !isValidModelName(to)) {
      return json(res, 400, { error: '模型名不合法，例如 qwen3:8b' });
    }
    if (from === to) return json(res, 400, { error: '新名字不能和原名一样' });
    if (!(await ensureOllama())) return json(res, 400, { error: 'Ollama 没在运行' });
    try {
      const r = await fetch(`${OLLAMA_BASE}/api/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: from, destination: to }),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status} ${t}`.trim());
      }
      modelsCache = { at: 0, items: null };      // 让列表重新取一次
      return json(res, 200, { ok: true, from, to, message: `已把 ${from} 复制为 ${to}（不占额外空间）` });
    } catch (e) {
      return json(res, 400, { error: String(e.message || e) });
    }
  }

  /* ------------------------------------------------------------ 用量统计 */
  if (p === '/api/usage' && req.method === 'POST') {
    const body = await readBody(req);
    const tokens = Number(body.tokens) || 0;
    if (tokens <= 0) return json(res, 400, { error: 'tokens 不对' });
    const day = new Date().toISOString().slice(0, 10);
    const list = readList('usage');
    const row = list.find((u) => u.day === day)
      || { day, tokens: 0, calls: 0, models: {} };
    row.tokens += tokens;
    row.calls += 1;
    const model = String(body.model || '未知');
    row.models[model] = (row.models[model] || 0) + tokens;
    writeList('usage', [...list.filter((u) => u.day !== day), row].sort((a, b) => a.day.localeCompare(b.day)));
    return json(res, 200, { ok: true, day: row });
  }

  if (p === '/api/history.md' && req.method === 'GET') {
    const kind = String(url.searchParams.get('kind') || 'health');
    const items = readList(kind);
    const lines = [`# 模型${kind === 'bench' ? '测速' : '体检'}历史`, '', `导出于 ${new Date().toLocaleString()}`, ''];
    if (kind === 'bench') {
      lines.push('| 时间 | 模型 | 生成速度(t/s) | 读提示词(t/s) |', '|---|---|---|---|');
      for (const it of items) {
        lines.push(`| ${new Date(it.at).toLocaleString()} | ${it.model} | ${it.gen} | ${it.prompt} |`);
      }
    } else {
      lines.push('| 时间 | 模型 | 通过 | 总数 | 通过率 | 耗时(秒) |', '|---|---|---|---|---|---|');
      for (const it of items) {
        lines.push(`| ${new Date(it.at).toLocaleString()} | ${it.model} | ${it.passed} | ${it.total} | `
          + `${it.rate == null ? '' : `${Math.round(it.rate * 100)}%`} | ${it.elapsed || ''} |`);
      }
    }
    const name = `localai-${kind}-${new Date().toISOString().slice(0, 10)}.md`;
    applySecurityHeaders(res);
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    });
    return res.end(lines.join('\n'));
  }

  if (p === '/api/usage' && req.method === 'GET') {
    return json(res, 200, { items: readList('usage') });
  }

  /* ------------------------------------------------------------ 历史记录 */
  if (p === '/api/history' && req.method === 'GET') {
    const kind = String(url.searchParams.get('kind') || 'health');
    if (kind !== 'health' && kind !== 'bench') {
      return json(res, 400, { error: '未知的记录类型' });
    }
    return json(res, 200, { kind, items: readList(kind), path: storePath() });
  }

  if (p === '/api/history.csv' && req.method === 'GET') {
    const kind = String(url.searchParams.get('kind') || 'health');
    const items = readList(kind);
    const columns = kind === 'bench'
      ? ['时间', '模型', '生成速度(t/s)', '读提示词(t/s)', '评级']
      : ['时间', '模型', '通过', '总数', '通过率', '采样一致性', '耗时(秒)'];
    const rows = items.map((it) => (kind === 'bench'
      ? [new Date(it.at).toLocaleString(), it.model, it.gen, it.prompt, it.level]
      : [new Date(it.at).toLocaleString(), it.model, it.passed, it.total,
        it.rate == null ? '' : `${Math.round(it.rate * 100)}%`, it.share == null ? '' : `${Math.round(it.share * 100)}%`, it.elapsed]));
    // 加 BOM：Excel 打开 UTF-8 CSV 不会乱码
    const csv = '﻿' + [columns, ...rows]
      .map((r) => r.map((c) => {
        const s = String(c == null ? '' : c);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(',')).join('\r\n');
    const name = `localai-${kind}-${new Date().toISOString().slice(0, 10)}.csv`;
    applySecurityHeaders(res);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    });
    return res.end(csv);
  }

  if (p === '/api/history' && req.method === 'DELETE') {
    const kind = String(url.searchParams.get('kind') || 'health');
    if (kind !== 'health' && kind !== 'bench') {
      return json(res, 400, { error: '未知的记录类型' });
    }
    clearList(kind);
    return json(res, 200, { ok: true, items: [] });
  }

  /* ---------------------------------------------------------- 对话历史 */
  if (p === '/api/sessions' && req.method === 'GET') {
    return json(res, 200, { items: readList('chat') });
  }

  if (p === '/api/sessions' && req.method === 'POST') {
    const body = await readBody(req, 1024 * 1024);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) return json(res, 400, { error: '没有可保存的对话' });
    const session = {
      id: String(body.id || `s${Date.now()}`),
      at: Date.now(),
      title: String(body.title || messages[0].content || '').slice(0, 60),
      model: String(body.model || ''),
      messages: messages.slice(-60),
    };
    const list = readList('chat').filter((s) => s.id !== session.id);
    list.push(session);
    writeList('chat', list);
    return json(res, 200, { ok: true, session, items: list });
  }

  if (p === '/api/sessions' && req.method === 'DELETE') {
    const id = String(url.searchParams.get('id') || '');
    writeList('chat', readList('chat').filter((s) => s.id !== id));
    return json(res, 200, { ok: true, items: readList('chat') });
  }

  /* ---------------------------------------------------------- 诊断与修复 */
  if (p === '/api/diagnose' && req.method === 'GET') {
    return json(res, 200, await diagnose({ root: ROOT, cfg, kitDir: ROOT }));
  }
  if (p === '/api/repair' && req.method === 'POST') {
    const body = await readBody(req);
    const action = String(body.action || '').trim();
    if (!action) return json(res, 400, { error: '缺少修复动作' });
    try {
      const out = await repair(action, { root: ROOT, cfg, kitDir: ROOT });
      return json(res, 200, { ok: true, ...out, report: await diagnose({ root: ROOT, cfg, kitDir: ROOT }) });
    } catch (e) {
      return json(res, 400, { error: String(e.message || e) });
    }
  }

  /* ------------------------------------------------------ 配置导出/导入 */
  if (p === '/api/config/export' && req.method === 'GET') {
    const bundle = exportBundle(ROOT);
    const name = `local-ai-config-${new Date().toISOString().slice(0, 10)}.json`;
    applySecurityHeaders(res);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    });
    return res.end(JSON.stringify(bundle, null, 2));
  }

  if (p === '/api/config/import' && req.method === 'POST') {
    const body = await readBody(req, 1024 * 1024);
    try {
      const out = importBundle(ROOT, body);
      for (const key of Object.keys(cfg)) delete cfg[key];
      Object.assign(cfg, out.config);
      return json(res, 200, { ok: true, ...out });
    } catch (e) {
      return json(res, 400, { error: String(e.message || e) });
    }
  }

  /* ------------------------------------------------------------ 性能基准 */
  if (p === '/api/bench' && req.method === 'POST') {
    if (busy) return json(res, 409, { error: `正在忙：${busy}` });
    busy = 'bench';
    const body = await readBody(req);
    const model = String(body.model || cfg.model || '').trim();
    if (!isValidModelName(model)) { busy = null; return json(res, 400, { error: '模型名不合法' }); }
    if (!(await ensureOllama())) { busy = null; return json(res, 400, { error: 'Ollama 没在运行' }); }
    try { recordUse(ROOT, model, 'bench'); } catch { /* ignore */ }
    json(res, 202, { started: true });
    const gpu = (await collectMetrics({ modelDir: resolveModelDir(cfg.modelDir), sampleMs: 0 })).gpu[0];
    runBenchmark({
      model,
      runs: Math.max(1, Math.min(5, Number(body.runs) || 3)),
      promptTokens: Math.max(200, Math.min(8000, Number(body.promptTokens) || 2000)),
      vramGB: gpu && gpu.memoryTotalMB ? Math.round(gpu.memoryTotalMB / 1024) : 0,
      numCtx: Number(body.numCtx) || 0,
      onProgress: (ev) => broadcast({ type: 'bench', ...ev }),
    })
      .then((out) => {
        // 结果同时存一份：万一 SSE 断了，页面轮询 /api/state 也能拿到
        lastBench = { ...out, at: Date.now() };
        // 存一份历史，用来对比「换了配置之后是不是真的变快了」
        try {
          appendItem('bench', {
            at: lastBench.at,
            model: out.model,
            gen: out.verdict ? out.verdict.genTokensPerSec : null,
            prompt: out.verdict ? out.verdict.promptTokensPerSec : null,
            level: out.verdict ? out.verdict.genLevel : null,
          });
        } catch { /* ignore */ }
        broadcast({ type: 'bench-done', result: out });
      })
      .catch((e) => broadcast({ type: 'error', text: String(e.message || e) }))
      .finally(() => { busy = null; broadcast({ type: 'idle' }); });
    return;
  }

  /* ------------------------------------------------------------ 下载队列 */
  if (p === '/api/queue' && req.method === 'GET') {
    return json(res, 200, pullQueue.snapshot());
  }

  if (p === '/api/queue' && req.method === 'POST') {
    const body = await readBody(req);
    const model = String(body.model || '').trim();
    if (!isValidModelName(model)) {
      return json(res, 400, { error: '模型名不合法，例如 qwen3:8b' });
    }
    if (!(await ensureOllama())) return json(res, 400, { error: 'Ollama 没在运行，而且找不到它的安装位置' });
    const out = pullQueue.add(model);
    if (!out.ok) return json(res, 409, { error: out.error });
    return json(res, 202, { started: true, state: pullQueue.snapshot() });
  }

  if (p === '/api/queue/cancel' && req.method === 'POST') {
    const body = await readBody(req);
    const out = pullQueue.cancel(String(body.model || '').trim());
    if (!out.ok) return json(res, 400, { error: out.error });
    return json(res, 200, { ok: true, state: pullQueue.snapshot() });
  }

  if (p === '/api/queue/clear' && req.method === 'POST') {
    pullQueue.clearFinished();
    return json(res, 200, { ok: true, state: pullQueue.snapshot() });
  }

  if (p === '/api/pull' && req.method === 'POST') {
    if (busy) return json(res, 409, { error: `正在忙：${busy}` });
    const body = await readBody(req);
    const model = String(body.model || '').trim();
    if (!/^[a-z0-9][a-z0-9._\-/]*(:[a-z0-9._\-]+)?$/i.test(model)) {
      return json(res, 400, { error: '模型名不合法，例如 qwen3:8b' });
    }
    if (!(await ensureOllama())) return json(res, 400, { error: 'Ollama 没在运行，而且找不到它的安装位置' });
    busy = `pull:${model}`;
    eventLog = [];
    json(res, 202, { started: true });
    doPull(model, broadcast)
      .then(() => broadcast({ type: 'done', action: 'pull', model }))
      .catch((e) => broadcast({ type: 'error', text: String(e.message || e) }))
      .finally(() => { busy = null; broadcast({ type: 'idle' }); });
    return;
  }

  if (p === '/api/delete' && req.method === 'POST') {
    if (busy) return json(res, 409, { error: `正在忙：${busy}` });
    if (pullQueue.isBusy()) return json(res, 409, { error: '正在下载模型，等下载完再删除' });
    const body = await readBody(req);
    const model = String(body.model || '').trim();
    if (!model) return json(res, 400, { error: '缺少模型名' });
    // 当前配置正在用的模型不能直接删。
    // 控制台只读配置、不回写，所以删掉之后：工作台启动失败 → 用户回控制台装个新的
    // → 配置仍指向被删的那个 → 还是起不来。这是个没有出口的死循环，直接拦掉。
    if (cfg.model && model === cfg.model) {
      return json(res, 409, {
        error: `「${model}」是当前工作台正在使用的模型，删掉后无法启动。` +
               `请先双击「① 双击这里开始安装.cmd」换用别的模型，再回来删除。`,
      });
    }
    if (!(await ensureOllama())) return json(res, 400, { error: 'Ollama 没在运行，无法删除' });
    busy = `delete:${model}`;
    eventLog = [];
    json(res, 202, { started: true });
    doDelete(model, broadcast)
      .then(() => broadcast({ type: 'done', action: 'delete', model }))
      .catch((e) => broadcast({ type: 'error', text: String(e.message || e) }))
      .finally(() => { busy = null; broadcast({ type: 'idle' }); });
    return;
  }

  if (p === '/api/settings' && req.method === 'POST') {
    const body = await readBody(req);
    const out = {};
    if (typeof body.autostart === 'boolean') out.autostart = setAutostart(body.autostart);
    if (typeof body.lanShare === 'boolean') out.lanShare = setLanShare(body.lanShare);
    if (body.ensureOllama) {
      // 「服务」页里点一下就把 Ollama 拉起来
      const ok = await ensureOllama();
      out.ollama = { ok, error: ok ? '' : '找不到 Ollama，或它没能启动' };
    }
    if (typeof body.selfHeal === 'boolean') {
      saveHealSetting(body.selfHeal);
      startHealWatchdog();
      out.selfHeal = { enabled: healStore.enabled };
    }
    return json(res, 200, { ok: true, ...out, settings: readSettings(), selfHeal: healStore.enabled });
  }

  if (p === '/api/service' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.action === 'stop') return json(res, 200, stopService());
    if (body.action === 'start') return json(res, 200, startWorkbench());
    if (body.action === 'uninstall') return json(res, 200, launchUninstall());
    return json(res, 400, { error: '未知操作' });
  }

  if (p === '/api/open-folder' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.which === 'models') {
      const dir = resolveModelDir(cfg.modelDir);
      if (!dir || !fs.existsSync(dir)) return json(res, 400, { error: `模型目录不存在：${dir || '（未配置）'}` });
      return json(res, 200, openFolder(dir));
    }
    return json(res, 200, openFolder(ROOT));
  }

  if (p === '/api/quit' && req.method === 'POST') {
    json(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 300);
    return;
  }

  if (req.method !== 'GET') return json(res, 404, { error: 'not found' });

  // 静态文件
  const file = p === '/' ? 'console.html' : p.replace(/^\/+/, '');
  const full = resolveStaticPath(UI, file);
  if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    applySecurityHeaders(res);
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404');
  }
  if (file === 'console.html') {
    // 首屏数据直接注入，省掉一次往返 —— 页面一打开就有内容，不闪「加载中」
    const boot = {
      state: await buildState(),
      config: await buildConfigPayload(),
      metrics: await buildMetrics({ fast: true }),
    };
    const inject = `<script>window.__BOOT__=${JSON.stringify(boot).replace(/</g, '\\u003c')};</script>`
      + `<script>window.__TOKEN__='${TOKEN}';</script>`;
    const html = fs.readFileSync(full, 'utf8').replace('<script src="console.js"></script>', `${inject}\n<script src="console.js"></script>`);
    applySecurityHeaders(res);
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
    return res.end(html);
  }
  if (file === 'strata.html') {
    // 独立版 Strata 页面（/strata.html）交给共享的适配器处理 —— 令牌注入只有一份实现
    return handleStrata(req, res, { cfg, root: ROOT, ui: UI, token: TOKEN });
  }
  applySecurityHeaders(res);
  pipeFile(res, full, {
    'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
    // 本地工具，缓存只会带来「改了代码但页面还是老的」这种困惑，一律不缓存
    'Cache-Control': 'no-store',
  });
}, {
  // 未预期异常落日志：否则用户只看到「请检查服务日志」，日志里却什么都没有
  onError: (err, req) => {
    const line = `[500] ${req.method} ${req.url} ${(err && err.stack) || err}`;
    logLine(line);
    // 日志流是异步的，控制台窗口里也打一份，排查时不用等 flush
    console.error(line);
  },
});

/* ------------------------------------------------------------------ 启动 */

function listen(port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(port));
  });
}

(async () => {
  initLog();
  loadHealSetting();
  startHealWatchdog();
  let port = 7790;
  for (; port < 7800; port++) {
    try { await listen(port); break; } catch { /* 换一个 */ }
  }
  if (port >= 7800) {
    console.log('   端口 7790~7799 都被占用了，没法启动控制台。');
    console.log('   关掉其它「本地 AI」窗口后重试。');
    process.exitCode = 1;
    return;
  }
  PORT = port;
  const url = `http://127.0.0.1:${port}/`;
  console.log('');
  console.log('==================================================');
  console.log('        本地 AI 控制台   已启动');
  console.log('==================================================');
  console.log('');
  console.log(cfg.backend === 'strata'
    ? '  已接入 Strata：引擎 / WebUI / dsh 状态与启停，加上 Ollama 模型管理。'
    : '  管理模型、上下文、开机自启和局域网共享，启动或停止服务。');
  console.log('');
  console.log('  浏览器没自动打开？把下面这个地址复制到浏览器：');
  console.log(`      ${url}`);
  console.log('');
  console.log('  【重要】这个黑色窗口是控制台本体，用的时候请保持它开着。');
  console.log('');
  if (!process.env.LOCALAI_NO_BROWSER) {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  }
})();
