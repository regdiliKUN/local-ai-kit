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
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.mjs';
import { OLLAMA_BASE, findOllama, isUp, killOllama, spawnServe, waitUp, ollamaEnv } from './ollama.mjs';
import { readSettings, startupDir, freeSpaceGB, detectDisks } from './detect.mjs';
import { makeLnk } from './make-lnk.mjs';

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
};

const TOKEN = crypto.randomBytes(24).toString('hex');
let PORT = 0;

const clients = new Set();
let busy = null;            // 当前在忙什么（'pull:模型名' 之类），避免并发操作
let eventLog = [];

const cfg = loadConfig(ROOT) || {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- 基础 */

function hostOk(req) {
  const h = String(req.headers.host || '').toLowerCase();
  return h === `127.0.0.1:${PORT}` || h === `localhost:${PORT}`;
}

function postOk(req) {
  const origin = req.headers.origin;
  if (origin && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) return false;
  const t = String(req.headers['x-localai-token'] || '');
  return t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 64 * 1024) req.destroy(); });
    req.on('end', () => {
      try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); }
    });
  });
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

/* ------------------------------------------------------------------ 路由 */

const server = http.createServer(async (req, res) => {
  if (!hostOk(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('forbidden');
  }
  if (req.method !== 'GET' && !postOk(req)) return json(res, 403, { error: '请求来源不可信' });

  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

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
  const full = path.join(UI, file);
  if (!full.startsWith(UI + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404');
  }
  if (file === 'console.html') {
    const inject = `<script>window.__TOKEN__='${TOKEN}';</script>`;
    const html = fs.readFileSync(full, 'utf8').replace('<script src="console.js"></script>', `${inject}\n<script src="console.js"></script>`);
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
    return res.end(html);
  }
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
  console.log('  这里可以管理模型（加装 / 删除）、开关开机自启、');
  console.log('  开关局域网共享、启动或停止服务。');
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
