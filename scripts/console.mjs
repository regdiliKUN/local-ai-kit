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
  createSafeServer, readBody,
  createOriginGuard, createRateLimiter, jsonResponse, applySecurityHeaders, resolveStaticPath,
} from './local-http.mjs';
import crypto from 'node:crypto';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.mjs';
import { handleStrata } from './strata.mjs';
import { OLLAMA_BASE, findOllama, isUp, killOllama, spawnServe, waitUp, ollamaEnv } from './ollama.mjs';
import { readSettings, startupDir, freeSpaceGB, detectDisks } from './detect.mjs';
import { makeLnk } from './make-lnk.mjs';
import { saveConfig } from './config.mjs';
import { KIT_VERSION, patchProfileText, readPresetStandard, resolveBudgets } from './install.mjs';
import { collectMetrics } from './metrics.mjs';
import { createHistory } from './history.mjs';

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
let eventLog = [];

/** 限流器：GET 宽松（页面要轮询），POST 收紧（会改东西） */
const rateLimit = createRateLimiter({ getLimit: 240, postLimit: 30 });

/** 指标历史：概览页的曲线靠它 */
const metricHistory = createHistory(120);
/** 上一次采到的完整指标（缓存用，别把历史点当完整数据返回） */
let lastMetrics = null;
/** 上一次采指标的时间，用来限流（不需要 1 秒采一次） */
let metricsAt = 0;

const cfg = loadConfig(ROOT) || {};

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
  const payload = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) { try { res.write(payload); } catch { /* closed */ } }
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

async function listModels() {
  try {
    const r = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    return (j.models || []).map((m) => ({
      name: m.name,
      sizeGB: Number(((m.size || 0) / 1e9).toFixed(2)),
      modified: m.modified_at || null,
      params: (m.details && m.details.parameter_size) || '',
      quant: (m.details && m.details.quantization_level) || '',
    }));
  } catch { return null; }
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
  // 让改动生效：重启 Ollama
  killOllama();
  return { ok: true, lanShare: on };
}

/* ------------------------------------------------------------- 服务控制 */

function pidOnPort(port) {
  try {
    const out = execSync('netstat -ano -p TCP', { encoding: 'utf8' });
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
      if (m && Number(m[1]) === port) return Number(m[2]);
    }
  } catch { /* ignore */ }
  return null;
}

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
    else if (ev.type === 'item') broadcast({ type: 'health-item', id: ev.id, ok: ev.ok, cat: ev.cat });
    else if (ev.type === 'done') broadcast({ type: 'health-done', ok: ev.ok, summary: ev.summary });
    else if (ev.type === 'error') broadcast({ type: 'health-error', text: ev.text });
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
    const now = Date.now();
    // 1 秒内重复请求直接用缓存，省掉一次 nvidia-smi 调用
    let current = null;
    if (now - metricsAt < 1000 && lastMetrics) {
      current = lastMetrics;
    } else {
      current = await collectMetrics({ modelDir: cfg.modelDir || '' });
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
    return json(res, 200, {
      current,
      history: {
        cpu: metricHistory.series('cpu'),
        memory: metricHistory.series('memory'),
        gpu: metricHistory.series('gpu'),
        vram: metricHistory.series('vram'),
        disk: metricHistory.series('disk'),
        at: metricHistory.series('at'),
      },
    });
  }

  if (cfg.backend === 'strata') return handleStrata(req, res, { cfg, root: ROOT, ui: UI, token: TOKEN });

  if (p === '/api/state') {
    const running = !!(await ollamaVersion());
    const models = running ? await listModels() : [];
    const settings = readSettings();
    const disks = detectDisks();
    return json(res, 200, {
      root: ROOT,
      model: cfg.model || '',
      modelDir: cfg.modelDir || '',
      contextWindow: cfg.contextWindow || 8192,
      running,
      models: models || [],
      settings,
      disks: disks.map((d) => ({ letter: d.letter, freeGB: d.freeGB, totalGB: d.totalGB })),
      modelDirFreeGB: cfg.modelDir ? freeSpaceGB(cfg.modelDir) : null,
      busy,
      logPath: path.join(os.tmpdir(), 'localai-console.log'),
    });
  }

  if (p === '/api/config' && req.method === 'GET') {
    const cs = readContextState();
    const running = !!(await ollamaVersion());
    const models = running ? await listModels() : [];
    return json(res, 200, {
      ...cs,
      models: (models || []).map((m) => m.name),
      limits: { min: CTX_MIN, max: CTX_MAX },
      presets: CTX_PRESETS,
      kitVersion: KIT_VERSION,
      dshHome: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    });
  }

  if (p === '/api/config' && req.method === 'POST') {
    if (busy) return json(res, 409, { error: `正在忙：${busy}` });
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
    const body = await readBody(req);
    busy = 'health';
    runHealth(!!(body && body.quick));
    return json(res, 202, { started: true });
  }

  if (p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    for (const e of eventLog) res.write(`data: ${JSON.stringify(e)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
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
    return json(res, 200, { ok: true, ...out, settings: readSettings() });
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
      const dir = cfg.modelDir || '';
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
    const inject = `<script>window.__TOKEN__='${TOKEN}';</script>`;
    const html = fs.readFileSync(full, 'utf8').replace('<script src="console.js"></script>', `${inject}\n<script src="console.js"></script>`);
    applySecurityHeaders(res);
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
    return res.end(html);
  }
  applySecurityHeaders(res);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
});

/* ------------------------------------------------------------------ 启动 */

function listen(port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(port));
  });
}

(async () => {
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
    ? '  已接入 Strata：查看引擎 / WebUI / dsh 状态，启动或停止服务。'
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
