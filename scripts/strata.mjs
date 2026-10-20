/** Adapter for an existing Strata workbench. Never starts or configures Ollama. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readBody, resolveStaticPath, applySecurityHeaders } from './local-http.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let operation = null;
let lastStart = 0;
let lastStop = 0;

export function validateStrataConfig(cfg) {
  for (const key of ['deploymentRoot', 'strataHome', 'dshDir']) {
    if (!cfg[key] || !path.isAbsolute(cfg[key])) throw new Error(`${key} 必须是绝对路径`);
  }
  const ports = ['enginePort', 'webPort', 'dshPort'].map((key) => cfg[key]);
  if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535) || new Set(ports).size !== 3) {
    throw new Error('服务端口必须是三个不同的有效整数');
  }
  const files = [
    path.join(cfg.deploymentRoot, 'workbench', 'tools', 'run-strata.bat'),
    path.join(cfg.deploymentRoot, 'workbench', 'webui', 'server.py'),
    path.join(cfg.strataHome, 'serve', 'server.py'),
    path.join(cfg.dshDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ];
  for (const file of files) if (!fs.existsSync(file)) throw new Error(`缺少部署文件：${file}`);
  return cfg;
}

async function probe(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1800), redirect: 'error' });
    if (!response.ok) return { online: false, error: `HTTP ${response.status}` };
    return { online: true };
  } catch { return { online: false, error: '服务未启动或尚未就绪' }; }
}

export async function strataState(cfg) {
  const [engine, webui, dsh] = await Promise.all([
    probe(`http://127.0.0.1:${cfg.enginePort}/health`),
    probe(`http://127.0.0.1:${cfg.webPort}/api/health`),
    probe(`http://127.0.0.1:${cfg.dshPort}/`),
  ]);
  if (!engine.online) {
    const log = path.join(cfg.deploymentRoot, 'logs', 'kit-engine.stdout.log');
    try {
      if (fs.statSync(log).mtimeMs > lastStop) {
        const tail = fs.readFileSync(log, 'utf8').slice(-8192);
        if (/\[FATAL\].*VRAM/.test(tail)) engine.startupError = '显存检查未通过，引擎未启动。请释放显存后重试；详情见 logs/kit-engine.stdout.log。';
        else if (/\[(ERROR|FATAL)\]/.test(tail)) engine.startupError = '引擎启动失败，请查看 logs/kit-engine.stdout.log。';
      }
    } catch { /* no launch log yet */ }
  }
  return { backend: 'strata', engine, webui, dsh, busy: operation,
    deploymentRoot: cfg.deploymentRoot, modelDir: cfg.modelDir || '',
    ports: { engine: cfg.enginePort, webui: cfg.webPort, dsh: cfg.dshPort } };
}

export function runStrataAction(cfg, action, { dryRun = false } = {}) {
  validateStrataConfig(cfg);
  if (!['engine', 'webui', 'workbench', 'stop'].includes(action)) throw new Error('未知操作');
  const payload = Buffer.from(JSON.stringify({ ...cfg, action, dryRun, nodeExe: process.execPath })).toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(HERE, 'strata-process.ps1'), '-Payload', payload],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { err += chunk.toString('utf8'); });
    // 超时给得宽松些：PowerShell 脚本要核验脚本路径、按端口找进程、逐个停，
    // 机器负载高的时候 20 秒可能不够。宁可多等，也不要让用户以为「没反应」。
    const timer = setTimeout(() => { child.kill(); reject(new Error('服务操作超时，请查看日志')); }, 60000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim() || '服务操作失败'));
      try { resolve(JSON.parse(out.replace(/^\uFEFF/, '').trim())); }
      catch { reject(new Error('无法读取服务操作结果')); }
    });
  });
}

function json(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

export async function handleStrata(req, res, { cfg, ui, token, metrics }) {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  if (pathname === '/api/state' && req.method === 'GET') return json(res, 200, await strataState(cfg));
  if (pathname === '/api/service' && req.method === 'POST') {
    const { action } = await readBody(req);
    if (!['engine', 'webui', 'workbench', 'stop'].includes(action)) return json(res, 400, { error: '未知操作' });
    if (operation || (action !== 'stop' && Date.now() - lastStart < 5000)) return json(res, 409, { error: '服务正在启动或停止，请稍候刷新' });
    operation = action;
    try {
      const result = await runStrataAction(cfg, action);
      if (action === 'stop') lastStop = Date.now();
      if (action !== 'stop') lastStart = Date.now();
      return json(res, result.ok ? 200 : 409, result);
    } catch (error) { return json(res, 400, { error: error.message }); }
    finally { operation = null; }
  }
  // Block Ollama-specific APIs while using Strata, including model downloads and profile edits.
  if (pathname.startsWith('/api/')) return json(res, 409, { error: '当前为 Strata 部署，请使用工作台维护模型与配置' });
  // Strata 模式只提供这几张页面：控制台本体、它的脚本和图表库。
  // 注意用 resolveStaticPath 校验，别让 ../ 之类的路径穿出去。
  if (req.method === 'GET' && ['/', '/strata.html', '/strata.js', '/charts.js'].includes(pathname)) {
    const file = pathname === '/' ? 'strata.html' : pathname.replace(/^\/+/, '');
    const full = resolveStaticPath(ui, file);
    if (!full || !fs.existsSync(full)) return json(res, 404, { error: 'not found' });
    let body = fs.readFileSync(full, 'utf8');
    if (file === 'strata.html') {
      body = body.replace('/*TOKEN*/', `window.__TOKEN__=${JSON.stringify(token)};`);
      // 首屏把机器状态一起注入 —— 页面一打开就有数字，不闪「读取中」
      if (metrics) {
        try {
          const boot = await metrics();
          body = body.replace('<script src="charts.js"></script>',
            `<script>window.__METRICS__=${JSON.stringify(boot).replace(/</g, '\\u003c')};</script>`
            + '<script src="charts.js"></script>');
        } catch { /* 拿不到就算了，页面会自己再拉一次 */ }
      }
    }
    applySecurityHeaders(res);
    res.writeHead(200, {
      'Content-Type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    return res.end(body);
  }
  return json(res, 404, { error: 'not found' });
}
