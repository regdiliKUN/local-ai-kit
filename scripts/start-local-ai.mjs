/**
 * 启动本地 AI 工作台。
 *
 *   1. 检查 / 启动 Ollama 推理服务
 *   2. 把模型预热进显存
 *   3. 启动 DeepSeek Harness 并自动打开浏览器
 *
 * 本窗口就是服务控制台 —— 保持它开着；关闭它就等于停止服务。
 */

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.mjs';
import { OLLAMA_BASE, findOllama, isUp, servesDir, killOllama, spawnServe, waitUp } from './ollama.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DSH_BASE = 'http://127.0.0.1:3080';

const cfg = loadConfig(ROOT);

const log = (s = '') => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openBrowser(url) {
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
}

const children = [];

async function ensureOllama() {
  log('[1/3] Ollama 推理服务');
  if (await isUp()) {
    // 开机自启的 Ollama 托盘程序可能用的是别的模型目录 / 参数，那样会找不到模型
    if (!cfg.modelDir || await servesDir(cfg.modelDir)) {
      log('      已在运行（使用现有实例，不受本窗口关闭影响）。');
      return true;
    }
    log('      运行中的 Ollama 用的不是配置的模型目录，正在重启...');
    killOllama();
    await sleep(2500);
  }
  const exe = findOllama();
  if (!exe) {
    log('      找不到 Ollama，请重新运行安装向导，或到 https://ollama.com/download 手动安装。');
    return false;
  }
  log('      正在启动...');
  const child = spawnServe(exe, cfg);
  children.push(child);
  child.stderr.on('data', (d) => {
    for (const line of d.toString().split(/\r?\n/)) {
      if (/level=ERROR|panic|fatal/i.test(line)) process.stderr.write('[ollama] ' + line + '\n');
    }
  });
  if (await waitUp(40)) {
    log(`      启动成功（模型目录：${cfg.modelDir || '默认'}，随本窗口关闭而停止）。`);
    return true;
  }
  log('      启动超时。');
  return false;
}

async function warmUp() {
  log('[2/3] 预热模型');
  const ps = await fetch(`${OLLAMA_BASE}/api/ps`).then((r) => r.json()).catch(() => null);
  if (ps?.models?.some((m) => m.name === cfg.model || m.model === cfg.model)) {
    log('      模型已在显存中，跳过。');
    return true;
  }
  log('      正在把模型加载进显存（首次约 1 分钟）...');
  try {
    const r = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, prompt: 'hi', stream: false, options: { num_predict: 1 } }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      log(`      加载失败：${j.error || `HTTP ${r.status}`}`);
      if (r.status === 404) log('      模型不在配置的目录里。请重新运行安装向导下载模型。');
      else log('      可能是显存不够：重新运行安装向导选个小一点的模型，或把 配置.json 里的 contextWindow 改小。');
      return false;
    }
  } catch (e) {
    log(`      加载失败：${e.message}`);
    return false;
  }
  log('      模型已就绪。');
  return true;
}

function runDsh() {
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
  child.on('exit', (code) => { log('\nDeepSeek Harness 已退出。'); process.exit(code ?? 0); });
}

function shutdown() {
  log('\n正在停止服务...');
  for (const c of children) { try { c.kill(); } catch { /* ignore */ } }
  process.exit(0);
}

(async () => {
  if (!cfg || !cfg.model) {
    log('找不到 配置.json（或里面没有模型），请重新运行安装向导。');
    process.exitCode = 1;
    return;
  }

  log('==================================================');
  log(`   本地 AI 工作台   ${cfg.model}`);
  log('==================================================');
  log();

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);   // 直接点窗口右上角关闭

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
