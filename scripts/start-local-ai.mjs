/**
 * 启动本地 AI 工作台。
 *
 *   1. 检查 / 启动 Ollama 推理服务
 *   2. 把模型预热进显存
 *   3. 启动 DeepSeek Harness 并自动打开浏览器
 *
 * 本窗口就是服务控制台 —— 保持它开着；关闭它就等于停止服务。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OLLAMA_BASE = 'http://127.0.0.1:11434';
const DSH_BASE = 'http://127.0.0.1:3080';

const cfg = loadConfig(ROOT) || { model: 'qwen3.8:27b', modelDir: '', contextWindow: 32768 };

const log = (s = '') => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findOllama() {
  const probes = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'),
    'C:\\Program Files\\Ollama\\ollama.exe',
  ];
  for (const p of probes) if (p && fs.existsSync(p)) return p;
  try {
    return execSync('where ollama', { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  } catch { return null; }
}

const OLLAMA_ENV = {
  ...process.env,
  OLLAMA_HOST: '127.0.0.1:11434',
  OLLAMA_MODELS: cfg.modelDir || process.env.OLLAMA_MODELS || '',
  OLLAMA_FLASH_ATTENTION: '1',
  OLLAMA_KV_CACHE_TYPE: 'q8_0',
  OLLAMA_CONTEXT_LENGTH: String(cfg.contextWindow || 32768),
  OLLAMA_KEEP_ALIVE: '30m',
};

async function isUp(url, timeout = 3000) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(timeout) });
    return true;
  } catch { return false; }
}

function openBrowser(url) {
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
}

const children = [];

async function ensureOllama() {
  log('[1/3] Ollama 推理服务');
  if (await isUp(`${OLLAMA_BASE}/api/version`)) {
    log('      已在运行（使用现有实例，不受本窗口关闭影响）。');
    return true;
  }
  const exe = findOllama();
  if (!exe) {
    log('      找不到 Ollama，请重新运行「开始部署」或手动安装。');
    return false;
  }
  log('      未运行，正在启动...');
  const child = spawn(exe, ['serve'], { stdio: ['ignore', 'pipe', 'pipe'], env: OLLAMA_ENV });
  children.push(child);
  child.stderr.on('data', (d) => {
    for (const line of d.toString().split(/\r?\n/)) {
      if (/level=ERROR|panic|fatal/i.test(line)) process.stderr.write('[ollama] ' + line + '\n');
    }
  });
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    if (await isUp(`${OLLAMA_BASE}/api/version`, 1500)) {
      log('      启动成功（随本窗口关闭而停止）。');
      return true;
    }
  }
  log('      启动超时。');
  return false;
}

async function warmUp() {
  log('[2/3] 预热模型');
  const ps = await fetch(`${OLLAMA_BASE}/api/ps`).then((r) => r.json()).catch(() => null);
  if (ps?.models?.some((m) => m.name === cfg.model || m.model === cfg.model)) {
    log('      模型已在显存中，跳过。');
    return;
  }
  log('      正在把模型加载进显存（首次约 1 分钟）...');
  await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, prompt: 'hi', stream: false, options: { num_predict: 1 } }),
  }).catch(() => {});
  log('      模型已就绪。');
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
  log('==================================================');
  log(`   本地 AI 工作台   ${cfg.model}`);
  log('==================================================');
  log();

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (!(await ensureOllama())) { process.exitCode = 1; return; }
  await warmUp();

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
