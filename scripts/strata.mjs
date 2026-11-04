/** Adapter for an existing Strata workbench. Never starts or configures Ollama. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readBody, resolveStaticPath, applySecurityHeaders } from './local-http.mjs';
import { tailBytes } from './store.mjs';
import { computeStartupProgress, parseStartupMarkers } from './progress.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let operation = null;
let lastStart = 0;
let lastStop = 0;

/**
 * 本次启动任务的状态。null 表示没有正在进行的启动。
 *
 * startedAt 是唯一的真实时钟：进度条上的「已用时」、日志起点、阶段插值都以它为准，
 * 所以它必须在请求刚进来时就落下，而不是等 PowerShell 跑完。
 *
 * backend 决定进度条走哪张阶段表：'strata'（引擎 + 日志里程碑）或 'ollama'（服务 + 显存里的模型）。
 */
let startupJob = null;

/** 开一次启动任务。strata 的各个动作由 runStrataAction 自己调，ollama 由控制台调 */
export function beginStartupJob({ action = 'workbench', backend = 'strata', model = '', logPath = '' } = {}) {
  startupJob = {
    action,
    backend,
    model,
    startedAt: Date.now(),
    logBytes: backend === 'strata' && logPath ? fileSizeSafe(logPath) : 0,
    lastPercent: 0,
    error: null,
    doneAt: null,
  };
  return startupJob;
}

/** 失败原因写进当前任务：进度条要能说明白为什么停了 */
export function failStartupJob(message) {
  if (startupJob && !startupJob.error) startupJob.error = String(message || '启动失败');
}

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

/**
 * 探活。
 *
 * dsh 工作台带 token 保护，匿名 GET / 一定回 401 —— 那是「活着并且在守门」，
 * 不是「没起来」。以前一律按 not ok 判掉，控制台永远显示「未就绪」，
 * 用户点「启动工作台」看见没反应就反复点，其实服务早就起来了。
 * 401/403 说明进程在监听且身份校验生效，就算在线。
 */
async function probe(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1800), redirect: 'error' });
    if (response.ok) return { online: true };
    if (response.status === 401 || response.status === 403) return { online: true, authRequired: true };
    return { online: false, error: `HTTP ${response.status}` };
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
        // 只读末尾 8KB：引擎日志跑几天能到几百 MB，
        // 而这段代码每次 /api/state 都会走（页面每 5 秒轮询一次）。
        const tail = tailBytes(log, 8192);
        if (/\[FATAL\].*VRAM/.test(tail)) engine.startupError = '显存检查未通过，引擎未启动。请释放显存后重试；详情见 logs/kit-engine.stdout.log。';
        else if (/\[(ERROR|FATAL)\]/.test(tail)) engine.startupError = '引擎启动失败，请查看 logs/kit-engine.stdout.log。';
      }
    } catch { /* no launch log yet */ }
  }
  return { backend: 'strata', engine, webui, dsh, busy: operation,
    deploymentRoot: cfg.deploymentRoot, modelDir: cfg.modelDir || '',
    ports: { engine: cfg.enginePort, webui: cfg.webPort, dsh: cfg.dshPort } };
}

/* --------------------------------------------------------------- 启动进度 */

/** 引擎启动日志；里程碑与失败原因都从它尾部读 */
function startupLogPath(cfg) {
  return path.join(cfg.deploymentRoot, 'logs', 'kit-engine.stdout.log');
}

/**
 * 只读「本次启动之后」写入的那部分日志。
 *
 * 为什么要按字节切：这个文件是追加写的，上一次启动留下的 `ready: http://` 还在里面。
 * 如果直接 tail 8KB，用户刚点完启动就会看到「只剩界面没起」的假进度，
 * 而引擎其实还在读权重。所以记下启动那一刻的文件长度，只看之后的增量；
 * 文件比启动时还短说明被截断重写了，那就整体当成本次的日志。
 */
function readStartupLog(cfg, sinceBytes) {
  const file = startupLogPath(cfg);
  try {
    const size = fs.statSync(file).size;
    if (!Number.isFinite(sinceBytes) || size < sinceBytes) return tailBytes(file, 64 * 1024);
    if (size === sinceBytes) return '';
    return tailBytes(file, size - sinceBytes);
  } catch {
    return '';
  }
}

/** 取文件大小，取不到就当 0 */
function fileSizeSafe(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** Ollama 是否在线，以及指定模型是否已经在显存里 */
async function ollamaState(model) {
  const online = await probe('http://127.0.0.1:11434/api/version');
  let loaded = false;
  if (online.online && model) {
    try {
      const r = await fetch('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.timeout(1500) });
      if (r.ok) {
        const j = await r.json();
        loaded = (j.models || []).some((m) => m.name === model || m.model === model);
      }
    } catch { /* 拿不到就按「还没加载」算，进度只会慢不会假 */ }
  }
  return { online: online.online, loaded };
}

/**
 * 进度查询接口的实现。
 *
 * 信号并行取：两条路径各自探自己关心的那几个端口。任何一个慢都不该拖住整个响应 ——
 * 这个接口会被 500ms 轮询一次，它自己卡住就等于进度条卡住。
 */
export async function startupProgress(cfg) {
  if (!startupJob) return { active: false };
  const now = Date.now();
  // 完成超过一分钟就当作已经结束：否则每次打开控制台都会看到一条 100% 的旧进度
  if (startupJob.doneAt && now - startupJob.doneAt > 60000) {
    startupJob = null;
    return { active: false };
  }

  const backend = startupJob.backend || 'strata';
  const dshProbe = probe(`http://127.0.0.1:${cfg.dshPort}/`);
  const engineProbe = backend === 'ollama' ? null : probe(`http://127.0.0.1:${cfg.enginePort}/health`);
  const ollamaProbe = backend === 'ollama' ? ollamaState(startupJob.model) : null;

  const [dsh, engine, ollama] = await Promise.all([dshProbe, engineProbe, ollamaProbe]);
  const markers = backend === 'ollama'
    ? {}
    : parseStartupMarkers(readStartupLog(cfg, startupJob.logBytes));

  const engineOnline = Boolean(engine && engine.online);
  const ollamaOnline = Boolean(ollama && ollama.online);
  const modelLoaded = Boolean(ollama && ollama.loaded);

  const ready = backend === 'ollama'
    ? ollamaOnline && modelLoaded && dsh.online
    : engineOnline && dsh.online;

  // 超过 5 分钟还没就绪，就不再假装在启动了：卡住的进度条比明确的失败更让人抓狂
  if (!startupJob.error && now - startupJob.startedAt > 5 * 60 * 1000 && !ready) {
    startupJob.error = backend === 'ollama'
      ? '启动超时（5 分钟仍未就绪），请查看 Ollama 是否正常、模型是否已在本地'
      : '启动超时（5 分钟仍未就绪），请查看 logs/kit-engine.stdout.log';
  }

  const progress = computeStartupProgress({
    backend,
    startedAt: startupJob.startedAt,
    // 完成后用 doneAt 当「现在」：否则每次查询都会拿新时间重算用时，
    // 页面刷新一次就从「用时 48 秒」变成「用时 463 秒」
    now: startupJob.doneAt || now,
    engineOnline,
    ollamaOnline,
    modelLoaded,
    dshOnline: dsh.online,
    markers,
    error: startupJob.error,
    lastPercent: startupJob.lastPercent,
  });

  // 记住最高水位：轮询间隔内算出的值只能往前走
  startupJob.lastPercent = Math.max(startupJob.lastPercent, progress.percent);
  if (progress.done && !startupJob.doneAt) startupJob.doneAt = now;

  return {
    active: true,
    action: startupJob.action,
    backend,
    model: startupJob.model || '',
    ...progress,
    startedAt: startupJob.startedAt,
  };
}

/**
 * 快速探活：当目标服务已在线时，直接返回"已在运行"，跳过 PowerShell + WMI 的数秒开销。
 *
 * 背景：用户点「启动工作台」时，即使引擎和 DSH 都已在运行，原来也要等
 * strata-process.ps1 跑完一轮 PowerShell 冷启动 + Get-CimInstance WMI 查询
 * （约 5-8 秒）才返回 alreadyRunning。这里在 Node.js 层先探一下端口：
 * 如果目标服务已经活着，直接返回，省掉整个 PowerShell 流程。
 */
async function quickProbe(cfg, action) {
  if (action === 'stop') return null; // 停服务不走快速路径
  if (action === 'dsh') {
    const r = await probe(`http://127.0.0.1:${cfg.dshPort}/`);
    if (r.online) return { ok: true, accepted: true, alreadyRunning: true };
    return null;
  }
  if (action === 'engine') {
    const r = await probe(`http://127.0.0.1:${cfg.enginePort}/health`);
    if (r.online) return { ok: true, accepted: true, alreadyRunning: true };
    return null;
  }
  if (action === 'webui') {
    // WebUI 依赖引擎，两个都要在线才算"已在运行"
    const [engine, webui] = await Promise.all([
      probe(`http://127.0.0.1:${cfg.enginePort}/health`),
      probe(`http://127.0.0.1:${cfg.webPort}/api/health`),
    ]);
    if (engine.online && webui.online) return { ok: true, accepted: true, alreadyRunning: true };
    return null;
  }
  if (action === 'workbench') {
    // workbench = 引擎 + DSH。两者都在线才算"已在运行"
    const [engine, dsh] = await Promise.all([
      probe(`http://127.0.0.1:${cfg.enginePort}/health`),
      probe(`http://127.0.0.1:${cfg.dshPort}/`),
    ]);
    if (engine.online && dsh.online) return { ok: true, accepted: true, alreadyRunning: true };
    return null;
  }
  return null;
}

export async function runStrataAction(cfg, action, { dryRun = false } = {}) {
  validateStrataConfig(cfg);
  if (!['engine', 'webui', 'workbench', 'dsh', 'stop'].includes(action)) throw new Error('未知操作');

  // 进度计时从这里开始 —— 不是等 PowerShell 跑完。用户点完按钮到进度条动起来之间
  // 的几百毫秒，正好用来把日志起点和开始时间钉住。
  if (action === 'stop') {
    startupJob = null;
  } else if (!dryRun && action !== 'dsh') {
    // dsh 是「启动 Ollama 工作台」流程的最后一步，不能覆盖那一轮的任务，
    // 否则进度条会从 0 重来
    beginStartupJob({ action, backend: 'strata', logPath: startupLogPath(cfg) });
  }

  // 快速路径：服务已在线时跳过 PowerShell，省 5-8 秒 WMI 开销
  if (!dryRun) {
    const quick = await quickProbe(cfg, action);
    if (quick) return quick;
  }

  // 拉起工作台之前先校正 dsh 预设里的压缩参数：dsh 升级会换掉官方预设，
  // 压缩配置是整段重述的，不校正就会静默失效。失败不影响启动。
  if (!dryRun && (action === 'dsh' || action === 'workbench')) {
    try {
      const { syncDshPresets } = await import('./dsh-preset-sync.mjs');
      syncDshPresets({ quiet: true });
    } catch { /* 自愈失败不挡启动 */ }
  }

  const payload = Buffer.from(JSON.stringify({ ...cfg, action, dryRun, nodeExe: process.execPath })).toString('base64');
  const task = new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(HERE, 'strata-process.ps1'), '-Payload', payload],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { err += chunk.toString('utf8'); });
    // 超时给得宽松些：PowerShell 脚本要核验脚本路径、按端口找进程、逐个停，
    // 机器负载高的时候 20 秒可能不够。宁可多等，也不要让用户以为「没反应」。
    // 冷启动引擎时，脚本拉起的常驻进程（引擎 / dsh）会继承本进程的 stdout 管道，
    // 导致 'close' 事件一直不触发 —— 所以这里用 'exit'（进程退出即算完），
    // 不要等 stdio 管道关闭，否则前端会卡满 60 秒才报「超时」，其实服务早起来了。
    const timer = setTimeout(() => { child.kill(); reject(new Error('服务操作超时，请查看日志')); }, 90000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) return reject(new Error(err.trim() || '服务操作失败'));
      try { resolve(JSON.parse(out.replace(/^\uFEFF/, '').trim())); }
      catch { reject(new Error('无法读取服务操作结果')); }
    });
  });

  // 失败原因要落到进度里：否则进度条只能停在半路，用户不知道是显存不够还是脚本崩了
  return task.catch((error) => {
    if (startupJob && startupJob.action === action) {
      startupJob.error = String((error && error.message) || error);
    }
    throw error;
  });
}

function json(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

/**
 * Strata 部署的服务控制。
 *
 * 以前 Strata 模式会把整个控制台「接管」掉 —— 只剩三个服务的启停，
 * 模型管理这些全被挡掉。现在改成**并存**：控制台的通用功能照常可用，
 * Strata 的服务状态作为一个额外的信息源并进来。
 */

/**
 * 端口 → 进程号。
 *
 * 这里以前有一份自己的实现，但 `execSync` 根本没 import ——
 * 调用时抛 ReferenceError，又被 `catch {}` 静默吞掉，于是**永远返回 null**。
 * 现在统一用 detect.mjs 里那一份（那边正则也更宽松，认 0.0.0.0 / [::]）。
 */
export { pidOnPort } from './detect.mjs';

export async function handleStrata(req, res, { cfg, root, ui, token, metrics }) {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  if (pathname === '/api/state' && req.method === 'GET') return json(res, 200, await strataState(cfg));
  if (pathname === '/api/progress' && req.method === 'GET') return json(res, 200, await startupProgress(cfg));
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
  // 其余的 /api/* 不再拦截 —— 控制台的通用功能（模型管理、测速、体检……）
  // 在 Strata 部署下同样能用：Strata 走自己的引擎，但 Ollama 也可能装着模型，
  // 那些功能对 Ollama 那部分是真的有用。

  // 独立访问 /strata.html 时仍然提供这页（给只想看服务状态的人用）
  // 必须包含 '/'：用户从快捷方式打开就是访问根路径，漏了会直接看到 {"error":"not found"}
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
