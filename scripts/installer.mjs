/**
 * 本地 AI 安装向导 —— 图形界面服务。
 *
 * 启动一个本地 HTTP 服务器，把界面送到浏览器，并对外提供：
 *   GET  /api/detect          环境检测结果
 *   GET  /api/events          SSE 安装进度流
 *   POST /api/install         开始安装（body: {model, modelDir, contextWindow}）
 *   POST /api/install-ollama  下载并以管理员权限安装 Ollama
 *   POST /api/open-workbench  打开工作台
 *   POST /api/quit            关闭安装向导
 *
 * 安全：服务只监听 127.0.0.1，但浏览器里任何网页都能向它发请求。所以
 *   - 校验 Host 头（防 DNS rebinding）
 *   - 所有 POST 必须带页面里注入的随机令牌（别的网站拿不到，跨站请求带不上自定义头）
 *   - 安装目录、Ollama 路径由服务端自己检测，不信任请求里传来的值
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { detectAll } from './detect.mjs';
import { runInstall } from './install.mjs';
import { findOllama, isValidModelName } from './ollama.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.dirname(HERE);
const UI = path.join(KIT, 'ui');

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
let installing = false;
let ollamaInstalling = false;
let eventLog = [];

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

/** 校验安装参数；返回 { error } 或规范化后的参数 */
function validateInstall(body) {
  const model = String(body.model || '').trim();
  if (!isValidModelName(model)) return { error: `模型名不合法：${model || '（空）'}` };

  const rawDir = String(body.modelDir || '').trim().replace(/\//g, '\\');
  if (!/^[A-Za-z]:\\/.test(rawDir) || /[<>"|?*]/.test(rawDir.slice(2))) {
    return { error: '模型目录必须是完整路径，例如 D:\\ollama\\models' };
  }
  const modelDir = path.win32.resolve(rawDir);
  if (!fs.existsSync(modelDir.slice(0, 3))) return { error: `磁盘 ${modelDir.slice(0, 2)} 不存在` };

  const cw = Math.round(Number(body.contextWindow) || 8192);
  const contextWindow = Math.min(131072, Math.max(2048, cw));
  return { model, modelDir, contextWindow };
}

// 检测结果缓存：避免每次刷新都重跑 nvidia-smi / whoami（也避免并发重复检测）
let detectCache = null;
let detectAt = 0;
async function detectCached(force = false) {
  if (!force && detectCache && Date.now() - detectAt < 15000) return detectCache;
  detectCache = await detectAll();
  detectAt = Date.now();
  return detectCache;
}

function broadcast(event) {
  // 记入历史：新连上的客户端（含刷新后的页面）会先回放一遍，
  // 这样安装到一半刷新不会丢进度、也不会退回向导开头。
  eventLog.push(event);
  if (eventLog.length > 800) eventLog.shift();

  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { /* 客户端已断开 */ }
  }
}

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(s);
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); }
    });
  });
}

/* --------------------------------------------------------- 管理员权限相关 */

/** 用 PowerShell 的 Start-Process -Verb RunAs 触发 UAC 授权 */
function runElevated(file, args) {
  const argList = args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(',');
  const ps = `Start-Process -FilePath '${file.replace(/'/g, "''")}' -ArgumentList ${argList} -Verb RunAs -Wait`;
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const ok = r.status === 0;
  return { ok, detail: ok ? '' : ((r.stderr || '') + (r.stdout || '')).trim() };
}

const OLLAMA_SETUP_URL = 'https://ollama.com/download/OllamaSetup.exe';

/** 校验安装包的数字签名：必须有效，且签发给 Ollama */
function verifySignature(file) {
  const ps = `$s=Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true });
  const [status = '', subject = ''] = (r.stdout || '').trim().split('|');
  return { ok: status === 'Valid' && /\bO=Ollama\b|CN=Ollama\b/i.test(subject), status, subject };
}

async function installOllama(emit) {
  const tmp = path.join(os.tmpdir(), `OllamaSetup-${process.pid}.exe`);
  emit({ type: 'log', text: '正在下载 Ollama 安装包...' });

  try {
    const r = await fetch(OLLAMA_SETUP_URL, { redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const total = Number(r.headers.get('content-length') || 0);
    // 安装包有上百 MB，边下边写文件，不整个放进内存
    const out = fs.createWriteStream(tmp);
    let got = 0;
    let lastPct = -1;
    for await (const chunk of r.body) {
      if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
      got += chunk.length;
      const pct = total ? Math.round((got / total) * 100) : -1;
      if (total && pct !== lastPct) {
        lastPct = pct;
        emit({ type: 'progress', percent: pct, text: `${(got / 1e6).toFixed(0)} MB / ${(total / 1e6).toFixed(0)} MB` });
      }
    }
    await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    emit({ type: 'error', text: `下载 Ollama 失败：${e.message}。可手动到 https://ollama.com/download 下载安装后重试。` });
    return false;
  }

  const sig = verifySignature(tmp);
  if (!sig.ok) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    emit({ type: 'error', text: `Ollama 安装包签名校验失败（${sig.status || '未知'}），已删除。请到 https://ollama.com/download 手动下载。` });
    return false;
  }
  emit({ type: 'log', text: '签名校验通过，正在启动安装程序（请在弹出的窗口中确认）...' });

  const r = runElevated(tmp, ['/VERYSILENT', '/NORESTART']);
  try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  if (!r.ok && /canceled|取消|1223/i.test(r.detail)) {
    emit({ type: 'error', text: '你取消了管理员授权，Ollama 未安装。' });
    return false;
  }
  emit({ type: 'log', text: '安装程序已结束，正在重新检测...' });
  return true;
}

/* ------------------------------------------------------------------ 路由 */

const server = http.createServer(async (req, res) => {
  if (!hostOk(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('forbidden');
  }
  if (req.method !== 'GET' && !postOk(req)) {
    return json(res, 403, { error: '请求来源不可信' });
  }

  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  if (p === '/api/detect') {
    return json(res, 200, await detectCached());
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

  if (p === '/api/install' && req.method === 'POST') {
    if (installing || ollamaInstalling) return json(res, 409, { error: '安装已在进行中' });
    const v = validateInstall(await readBody(req));
    if (v.error) return json(res, 400, { error: v.error });
    const detect = await detectCached();
    if (!detect.install.root) return json(res, 400, { error: '找不到可写的安装目录' });

    installing = true;
    eventLog = [];
    json(res, 202, { started: true });

    runInstall(
      {
        ...v,
        root: detect.install.root,
        ollamaExe: findOllama(),
        kitDir: KIT,
      },
      broadcast,
    ).catch((e) => broadcast({ type: 'error', text: String(e.message || e) }))
      .finally(() => { installing = false; });
    return;
  }

  if (p === '/api/install-ollama' && req.method === 'POST') {
    if (installing || ollamaInstalling) return json(res, 409, { error: '安装已在进行中' });
    ollamaInstalling = true;
    json(res, 202, { started: true });
    installOllama(broadcast).then(async (ok) => {
      if (ok) broadcast({ type: 'detect-refresh', data: await detectCached(true) });
    }).finally(() => { ollamaInstalling = false; });
    return;
  }

  if (p === '/api/open-workbench' && req.method === 'POST') {
    spawn('cmd', ['/c', 'start', '', 'http://127.0.0.1:3080'], { detached: true, stdio: 'ignore' }).unref();
    return json(res, 200, { ok: true });
  }

  if (p === '/api/quit' && req.method === 'POST') {
    json(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 300);
    return;
  }

  if (req.method !== 'GET') return json(res, 404, { error: 'not found' });

  // 静态文件
  let file = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
  const full = path.join(UI, file);
  if (!full.startsWith(UI + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404');
  }

  // 首页把检测结果直接注入，省掉一次往返（首屏立刻可见，不闪「检测中」）
  if (file === 'index.html') {
    const data = await detectCached();
    const inject = `<script>window.__DETECT__=${JSON.stringify(data).replace(/</g, '\\u003c')};window.__TOKEN__='${TOKEN}';</script>`;
    const html = fs.readFileSync(full, 'utf8').replace('<script src="app.js"></script>', `${inject}\n<script src="app.js"></script>`);
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
  let port = 7788;
  for (; port < 7800; port++) {
    try { await listen(port); break; } catch { /* 端口占用，换一个 */ }
  }
  if (port >= 7800) {
    console.log('   端口 7788–7799 全被占用，无法启动安装向导。请关闭占用端口的程序后重试。');
    process.exitCode = 1;
    return;
  }
  PORT = port;
  const url = `http://127.0.0.1:${port}/`;
  console.log('==================================================');
  console.log('   本地 AI 安装向导');
  console.log('==================================================');
  console.log();
  console.log(`   已在浏览器中打开：${url}`);
  console.log('   如果没自动打开，请手动复制上面的地址。');
  console.log();
  console.log('   安装过程中请保持本窗口开启。');
  console.log();
  // LOCALAI_NO_BROWSER=1：不自动打开浏览器（远程桌面 / 自动化测试时用）
  if (!process.env.LOCALAI_NO_BROWSER) {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  }
})();
