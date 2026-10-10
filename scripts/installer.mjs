/**
 * 本地 AI 安装向导 —— 图形界面服务。
 *
 * 启动一个本地 HTTP 服务器，把界面送到浏览器，并对外提供：
 *   GET  /api/detect          环境检测结果（?force=1 强制重新检测）
 *   GET  /api/events          SSE 安装进度流
 *   POST /api/install         开始安装（body: {model, modelDir, contextWindow}）
 *   POST /api/install-ollama  下载并以管理员权限安装 Ollama（装完自动续装）
 *   POST /api/relaunch-elevated  以管理员身份重启本向导（UAC）
 *   POST /api/launch-workbench   启动已装好的本地 AI 工作台
 *   POST /api/open-folder     在资源管理器里打开某个文件夹
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

import { detectAll, freeSpaceGB } from './detect.mjs';
import { runInstall } from './install.mjs';
import { findOllama, isValidModelName } from './ollama.mjs';
import { modelInfo } from './models.mjs';

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
let lastInstall = null;      // 上一次的安装参数：装完 Ollama 后自动续装、失败后一键重试用
let lastSummary = null;

/* -------------------------------------------------------------- 日志文件 */

/**
 * 把安装过程同时写一份到磁盘。
 * 用户遇到问题要找人帮忙时，有日志可发；向导窗口关掉也不会丢。
 */
const LOG_FILE = path.join(os.tmpdir(), 'localai-setup.log');
let logStream = null;
function initLog() {
  try {
    logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' });
    logStream.write(`本地 AI 安装向导  ${new Date().toLocaleString()}\n`);
    logStream.write(`node ${process.version} / ${process.platform} ${os.release()} / ${process.arch}\n`);
    logStream.write(`部署包目录：${KIT}\n\n`);
  } catch { logStream = null; }
}
function logLine(s) {
  if (logStream) { try { logStream.write(`${s}\n`); } catch { /* ignore */ } }
}
function logPath() { return LOG_FILE; }

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

  // 可选代理：网络连不上 ollama.com 时用户会填一个
  const proxy = String(body.proxy || '').trim();
  if (proxy && !/^https?:\/\/\S+$/i.test(proxy)) {
    return { error: '代理地址格式不对，应该形如 http://127.0.0.1:7890' };
  }

  return { model, modelDir, contextWindow, proxy };
}

/** 模型下载前的磁盘空间预检；够用返回 null，不够返回给用户看的中文说明 */
function spaceProblem(model, modelDir) {
  const needGB = Math.ceil(((modelInfo(model) || {}).gb || 0) * 1.3);
  const freeGB = freeSpaceGB(modelDir);
  if (freeGB == null || needGB <= 0 || freeGB >= needGB) return null;
  return `磁盘 ${modelDir.slice(0, 2)} 只剩 ${freeGB} GB，放不下这个模型（下载 + 解压需要约 ${needGB} GB）。`
    + '请换一块空间更大的盘，或者回上一步选个小一点的模型。';
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

  // 落一份到磁盘日志，方便出问题时排查
  if (event.type === 'step') logLine(`[${event.status}] ${event.text || event.id}`);
  else if (event.type === 'log') logLine(`      ${event.text}`);
  else if (event.type === 'error') logLine(`[错误] ${event.text}`);
  else if (event.type === 'progress') logLine(`  ${event.percent}%  ${event.text || ''}`);
  else logLine(`[${event.type}] ${JSON.stringify(event).slice(0, 300)}`);

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

/**
 * 以管理员身份重启本向导（触发 UAC 弹窗）。
 *
 * 关键细节：整条 PowerShell 命令里**只用单引号**，一个双引号都不出现。
 * 因为 Node 在 Windows 上会把带空格的参数包进双引号、并把内层双引号转义成 \"，
 * 而 powershell.exe 解析 -Command 时对 \" 很敏感，稍有不慎整条命令就跑不起来。
 * 路径里的空格交给单引号；脚本用「相对路径 + -WorkingDirectory」，
 * 这样连中文目录都不用再被引号包一层。
 */
function relaunchElevated() {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const rel = path.join('scripts', 'installer.mjs');
  const ps = [
    `$p = Start-Process -FilePath ${q(process.execPath)}`,
    `-ArgumentList ${q(rel)}`,
    `-WorkingDirectory ${q(KIT)}`,
    `-Verb RunAs -PassThru`,
    `; if ($p) { exit 0 } else { exit 1 }`,
  ].join(' ');
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const ok = r.status === 0;
  return { ok, detail: ok ? '' : ((r.stderr || '') + (r.stdout || '')).trim() };
}

/** 在资源管理器里打开文件夹；给了 select 就顺带选中那个文件 */
function openFolder(dir, select) {
  try {
    if (select && fs.existsSync(select)) {
      spawn('explorer.exe', [`/select,${select}`], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
    }
    return true;
  } catch { return false; }
}

/** 启动已经装好的工作台（等于双击桌面的「启动本地AI」） */
function launchWorkbench() {
  const root = detectCache?.install?.root;
  if (!root) return { ok: false, error: '还没安装，找不到安装目录' };
  const cmd = path.join(root, 'start-ai.cmd');
  if (!fs.existsSync(cmd)) return { ok: false, error: `找不到启动脚本：${cmd}` };
  spawn('cmd.exe', ['/c', 'start', '', cmd], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true };
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
    let lastAt = Date.now();
    let lastGot = 0;
    let speed = 0;
    for await (const chunk of r.body) {
      if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
      got += chunk.length;
      const now = Date.now();
      if (now - lastAt >= 500) {
        speed = (got - lastGot) / ((now - lastAt) / 1000);
        lastAt = now;
        lastGot = got;
      }
      const pct = total ? Math.round((got / total) * 100) : -1;
      if (total && pct !== lastPct) {
        lastPct = pct;
        emit({
          type: 'progress',
          phase: 'ollama-setup',
          percent: pct,
          got,
          total,
          speed,
          eta: speed > 0 ? (total - got) / speed : 0,
          text: `${(got / 1e6).toFixed(0)} MB / ${(total / 1e6).toFixed(0)} MB`,
        });
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

/**
 * 真正开始跑安装。
 * 抽成独立函数，是为了「失败后一键重试」和「装完 Ollama 自动续装」都能复用同一套逻辑。
 */
function startInstall(params) {
  installing = true;
  eventLog = [];
  runInstall({ ...params, ollamaExe: findOllama(), kitDir: KIT }, broadcast)
    .catch((e) => broadcast({ type: 'error', text: String(e.message || e), stage: 'internal', remedy: [] }))
    .finally(() => { installing = false; });
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
    return json(res, 200, await detectCached(url.searchParams.get('force') === '1'));
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
    if (!detect.install.root) return json(res, 400, { error: '找不到可写的安装目录，无法安装' });

    const sp = spaceProblem(v.model, v.modelDir);
    if (sp) return json(res, 400, { error: sp });

    lastInstall = { ...v, root: detect.install.root };
    json(res, 202, { started: true });
    startInstall(lastInstall);
    return;
  }

  // 失败后一键重试：用上次的参数再跑一遍（已完成的步骤会自动跳过 / 续传）
  if (p === '/api/retry' && req.method === 'POST') {
    if (installing || ollamaInstalling) return json(res, 409, { error: '安装已在进行中' });
    if (!lastInstall) return json(res, 400, { error: '没有可重试的安装，请重新走一遍向导' });
    const detect = await detectCached(true);
    if (!detect.install.root) return json(res, 400, { error: '找不到可写的安装目录' });
    lastInstall.root = detect.install.root;
    json(res, 202, { started: true });
    startInstall(lastInstall);
    return;
  }

  if (p === '/api/install-ollama' && req.method === 'POST') {
    if (installing || ollamaInstalling) return json(res, 409, { error: '安装已在进行中' });
    ollamaInstalling = true;
    json(res, 202, { started: true });
    installOllama(broadcast).then(async (ok) => {
      if (!ok) return;
      const fresh = await detectCached(true);
      if (lastInstall) {
        // 之前就是卡在「缺 Ollama」上：装完直接接着装，不让用户再走一遍向导
        broadcast({ type: 'log', text: 'Ollama 已装好，正在自动继续安装…' });
        lastInstall.root = fresh.install.root || lastInstall.root;
        startInstall(lastInstall);
      } else {
        broadcast({ type: 'detect-refresh', data: fresh });
      }
    }).finally(() => { ollamaInstalling = false; });
    return;
  }

  // 以管理员身份重启本向导（UAC）
  if (p === '/api/relaunch-elevated' && req.method === 'POST') {
    const r = relaunchElevated();
    json(res, 200, { ok: r.ok, error: r.ok ? '' : (r.detail || '未能获得管理员权限') });
    if (r.ok) setTimeout(() => process.exit(0), 900);
    return;
  }

  // 启动已装好的工作台
  if (p === '/api/launch-workbench' && req.method === 'POST') {
    return json(res, 200, launchWorkbench());
  }

  // 打开文件夹（安装目录 / 部署包目录 / 日志所在目录）
  if (p === '/api/open-folder' && req.method === 'POST') {
    const body = await readBody(req);
    const which = String(body.which || 'install');
    if (which === 'kit') {
      openFolder(KIT, path.join(KIT, '① 双击这里开始安装.cmd'));
      return json(res, 200, { ok: true });
    }
    if (which === 'logs') {
      openFolder(path.dirname(LOG_FILE), LOG_FILE);
      return json(res, 200, { ok: true });
    }
    const root = detectCache?.install?.root;
    if (!root) return json(res, 400, { error: '还没安装' });
    openFolder(root);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/log-path' && req.method === 'GET') {
    return json(res, 200, { path: LOG_FILE, kit: KIT });
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
  initLog();
  let port = 7788;
  for (; port < 7800; port++) {
    try { await listen(port); break; } catch { /* 端口占用，换一个 */ }
  }
  if (port >= 7800) {
    console.log('');
    console.log('==================================================');
    console.log('   无法启动安装向导');
    console.log('==================================================');
    console.log('');
    console.log('   原因：端口 7788 ~ 7799 全都被占用了。');
    console.log('');
    console.log('   怎么办：');
    console.log('     1. 先关掉其它正在运行的「本地 AI 安装向导」窗口，再重试；');
    console.log('     2. 还不行就重启电脑，然后重新双击「① 双击这里开始安装.cmd」。');
    console.log('');
    console.log('   想自己查是谁占用了端口：在开始菜单搜索 cmd 打开，输入');
    console.log('       netstat -ano | findstr :7788');
    console.log('   记下最后一列的数字（进程号），到任务管理器里结束它。');
    console.log('');
    process.exitCode = 1;
    return;
  }
  PORT = port;
  const url = `http://127.0.0.1:${port}/`;
  const autoOpen = !process.env.LOCALAI_NO_BROWSER;

  console.log('');
  console.log('==================================================');
  console.log('        本地 AI 安装向导   已启动');
  console.log('==================================================');
  console.log('');
  console.log('  接下来会自动打开浏览器，跟着页面上的提示点「继续」就行。');
  console.log('');
  console.log('  【重要】这个黑色窗口就是安装程序本体，');
  console.log('          安装期间请保持它开着，装完再关。');
  console.log('');
  console.log(autoOpen ? '  浏览器没自动打开？把下面这个地址复制到浏览器：' : '  请在浏览器里打开下面这个地址：');
  console.log(`      ${url}`);
  console.log('');
  console.log(`  如果安装出错，日志在：${LOG_FILE}`);
  console.log('');
  logLine(`listen ${url}`);
  if (autoOpen) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
})();
