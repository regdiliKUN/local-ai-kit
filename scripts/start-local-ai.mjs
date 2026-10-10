/**
 * 本地 AI 工作台启动器。
 *
 *   1. 清掉外来的 Ollama，由本窗口独占启动一个（不再"捡"别人的进程）
 *   2. 把模型按配置的上下文长度预热进显存
 *   3. 启动 DeepSeek Harness 并自动打开浏览器
 *
 * 本窗口就是服务控制台 —— 保持它开着；关闭它就等于停止服务。
 *
 * 为什么第 1 步必须先杀再起：
 *   早期实现是「发现 11434 上已有 Ollama 就直接复用」。可那个进程如果不属于本窗口
 *   （别的会话 / 别的终端 / 托盘自启起的），随时会被别人收走，工作台就会报
 *   「本地运行失败 Connection error」，而本窗口的启动器毫不知情。
 *   宁可多花几十秒重新加载模型，也要保证 Ollama 的生命周期和本窗口绑定。
 */

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadConfig } from './config.mjs';
import { OLLAMA_BASE, findOllama, isUp, killOllama, spawnServe, waitUp } from './ollama.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DSH_BASE = 'http://127.0.0.1:3080';
const MAX_OLLAMA_RESPAWNS = 3;

const cfg = loadConfig(ROOT);
const MODEL = (cfg && cfg.model) || '';
const CONTEXT_LENGTH = Number(cfg && cfg.contextWindow) || 8192;

const children = [];
let shuttingDown = false;
let ollamaRespawns = 0;

const log = (s = '') => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openBrowser(url) {
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
}

/* --------------------------------------------------------------- Ollama */

/** 杀掉所有 ollama 进程（含别的会话、托盘自启、上次残留的） */
export function killStrayOllama() {
  try {
    killOllama();
    return true;
  } catch {
    return false;
  }
}

function startOllama(exe) {
  const child = spawnServe(exe, cfg, { detached: false });
  children.push(child);

  child.stderr.on('data', (d) => {
    for (const line of d.toString().split(/\r?\n/)) {
      if (/level=ERROR|panic|fatal/i.test(line)) process.stderr.write('[ollama] ' + line + '\n');
    }
  });

  // 看门狗：只要不是主动关窗口，Ollama 挂了就自动拉起来
  child.on('exit', (code) => {
    if (shuttingDown) return;
    if (ollamaRespawns >= MAX_OLLAMA_RESPAWNS) {
      log(`      Ollama 已连续退出 ${MAX_OLLAMA_RESPAWNS} 次，停止自动重启。请手动检查。`);
      return;
    }
    ollamaRespawns += 1;
    log(`      Ollama 意外退出（code ${code}），第 ${ollamaRespawns} 次自动重启...`);
    startOllama(exe);
  });

  return child;
}

export async function ensureOllama() {
  log('[1/3] Ollama 推理服务');

  // 不管 11434 上有没有人在跑，一律先清掉，再由本窗口起一个
  if (await isUp(`${OLLAMA_BASE}/api/version`, 1500)) {
    log('      检测到已有 Ollama 在运行，先结束它，改由本窗口独占。');
    killStrayOllama();
    for (let i = 0; i < 15; i++) {
      if (!(await isUp(`${OLLAMA_BASE}/api/version`, 1500))) break;
      await sleep(1000);
    }
  }

  const exe = findOllama();
  if (!exe) {
    log('      找不到 Ollama。');
    log('      请重新运行安装向导（双击「① 双击这里开始安装.cmd」），');
    log('      或到 https://ollama.com/download 手动安装后重试。');
    return false;
  }

  log('      正在启动（随本窗口关闭而停止）...');
  startOllama(exe);

  if (await waitUp(40)) {
    log(`      已就绪（模型目录：${(cfg && cfg.modelDir) || '默认'}）。`);
    return true;
  }
  log('      启动超时。请确认 Ollama 已安装，或重新运行安装向导。');
  return false;
}

/* --------------------------------------------------------------- 预热 */

export async function warmUp() {
  log('[2/3] 预热模型');

  const ps = await fetch(`${OLLAMA_BASE}/api/ps`).then((r) => r.json()).catch(() => null);
  const loaded = ps && ps.models && ps.models.find((m) => m.name === MODEL || m.model === MODEL);

  if (loaded && Number(loaded.context_length) === CONTEXT_LENGTH) {
    log(`      模型已在显存中（上下文 ${CONTEXT_LENGTH}），跳过。`);
    return true;
  }

  if (loaded) {
    log(`      当前上下文 ${loaded.context_length} ≠ 配置的 ${CONTEXT_LENGTH}，卸载后重载...`);
    await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, keep_alive: 0 }),
    }).catch(() => {});
    await sleep(2000);
  }

  log('      正在把模型加载进显存（首次约 1 分钟，请稍候）...');
  try {
    // 显式带 num_ctx：环境变量是兜底，请求里的 num_ctx 才是硬保证
    const r = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        prompt: 'hi',
        stream: false,
        options: { num_predict: 1, num_ctx: CONTEXT_LENGTH },
      }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      log(`      加载失败：${j.error || `HTTP ${r.status}`}`);
      if (r.status === 404) {
        log('      模型不在配置的模型目录里。请重新运行安装向导下载模型。');
      } else {
        log('      可能是显存不够：重新运行安装向导选个小一点的模型，');
        log('      或把安装目录里的 配置.json 的 contextWindow 改小后重启。');
      }
      return false;
    }
  } catch (e) {
    log(`      加载失败：${e.message}`);
    return false;
  }
  log('      模型已就绪。');
  return true;
}

/* ------------------------------------------------------- DeepSeek Harness */

export function runDsh() {
  log('[3/3] 启动 DeepSeek Harness');
  log('      正在启动（约 10 秒）...');

  const bin = path.join(ROOT, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  const child = spawn(process.execPath, [bin, 'web', '--no-open'], {
    cwd: path.join(ROOT, 'dsh-runtime'),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.push(child);

  let buf = '';
  let opened = false;
  const onData = (chunk) => {
    const s = chunk.toString();
    if (opened) { process.stdout.write(s); return; }
    buf += s;
    const m = buf.match(/http:\/\/127\.0\.0\.1:3080\/\?token=\S+/);
    if (m) {
      opened = true;
      log();
      log('==================================================');
      log('   工作台已就绪，正在打开浏览器');
      log();
      log('   ' + m[0]);
      log('==================================================');
      log();
      log('   本窗口是服务控制台，请保持打开。');
      log('   关闭本窗口 = 停止服务并释放显存。');
      log();
      openBrowser(m[0]);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (code) => {
    log('\nDeepSeek Harness 已退出。');
    process.exit(code ?? 0);
  });
  return child;
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('\n正在停止服务...');
  for (const c of children) { try { c.kill(); } catch { /* ignore */ } }
  process.exit(0);
}

/* ---------------------------------------------------------------- 入口 */

// 直接运行时才走启动流程；被 import 时只暴露函数，方便单独测试
const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectRun) {
  log('==================================================');
  log(`   本地 AI 工作台   ${MODEL || '（未配置）'}`);
  log('==================================================');
  log();

  if (!cfg || !MODEL) {
    log('  找不到 配置.json（或里面没有模型）。');
    log('  请重新运行安装向导：双击「① 双击这里开始安装.cmd」。');
    process.exitCode = 1;
  } else {
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('SIGHUP', shutdown);   // 直接点窗口右上角关闭

    (async () => {
      if (!(await ensureOllama())) { process.exitCode = 1; return; }
      if (!(await warmUp())) log('      工作台仍会启动，但对话前需要先解决上面的问题。');

      if (await isUp(DSH_BASE)) {
        log('[3/3] DeepSeek Harness');
        log('      已在运行，直接打开浏览器。');
        log();
        log('  地址：' + DSH_BASE);
        log();
        openBrowser(DSH_BASE);
        return;
      }
      runDsh();
    })();
  }
}
