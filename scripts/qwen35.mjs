/**
 * Qwen3.5-35B-A3B-Uncensored（llama.cpp llama-server）服务控制。
 *
 * 模型和引擎都在独立目录里（默认 F:\Qwen3.5-35B-A3B-Uncensored），这里只负责：
 *   起服务 / 探活 / 停服务。参数与该目录里的「启动 Qwen3.5（仅 API）.cmd」保持一致。
 *
 * 模型和引擎都**不在仓库里**（21 GB + 1.4 GB），需要自己下载，见 docs/qwen35.md。
 *
 * 配置（配置.json，可选）：
 *   qwen35Home   模型部署目录（里面放 model\ 和 runtime\ 两个子目录）
 *   qwen35ModelFile  model\ 里的 .gguf 文件名，换别的量化版本时改它
 *   qwen35Mmproj     看图用的视觉投影文件（mmproj-*.gguf）。不写就自动找 model\ 里的 mmproj*.gguf；
 *                    设成 false 关闭看图（省约 1 GB 显存）
 *   qwen35Port   端口，默认 18123。不要用 15000 以下的端口：这台机器的动态端口范围是
 *                1024–15000，Hyper-V / WinNAT 每次开机会在里面随机保留几段（例如 8116–8215），
 *                被保留的端口 llama-server 绑不上，直接退出。
 *   qwen35NCpuMoe / qwen35Ctx / qwen35Threads   同 .cmd 里的可调参数
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { pidOnPort } from './detect.mjs';

export const QWEN35_ALIAS = 'Qwen3.5-35B-A3B-Uncensored';
const DEFAULT_MODEL_FILE = 'Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf';
/** 模型下载页（国内可把 huggingface.co 换成 hf-mirror.com） */
export const QWEN35_MODEL_PAGE = 'https://huggingface.co/HauhauCS/Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive';
/** llama.cpp Windows CUDA 版下载页 */
export const LLAMA_CPP_RELEASES = 'https://github.com/ggml-org/llama.cpp/releases';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 视觉投影文件：显式配置优先；否则在 model\ 里找 mmproj*.gguf；配置成 false 就不开看图。
 * 没有它 llama-server 也能跑，只是只认文字。
 */
export function findMmproj(cfg = {}, modelDir) {
  if (cfg.qwen35Mmproj === false) return null;
  if (cfg.qwen35Mmproj) {
    const f = path.join(modelDir, path.basename(String(cfg.qwen35Mmproj)));
    return fs.existsSync(f) ? f : null;
  }
  try {
    const hit = fs.readdirSync(modelDir).find((n) => /^mmproj.*\.gguf$/i.test(n));
    return hit ? path.join(modelDir, hit) : null;
  } catch { return null; }
}

export function qwenSettings(cfg = {}) {
  const home = cfg.qwen35Home || 'F:\\Qwen3.5-35B-A3B-Uncensored';
  const modelDir = path.join(home, 'model');
  return {
    home,
    mmproj: findMmproj(cfg, modelDir),
    exe: path.join(home, 'runtime', 'llama-server.exe'),
    model: path.join(home, 'model', path.basename(String(cfg.qwen35ModelFile || DEFAULT_MODEL_FILE))),
    port: Number(cfg.qwen35Port) || 18123,
    nCpuMoe: Number(cfg.qwen35NCpuMoe) || 10,
    ctx: Number(cfg.qwen35Ctx) || 32768,
    threads: Number(cfg.qwen35Threads) || 16,
    logDir: path.join(cfg.deploymentRoot || home, 'logs'),
  };
}

/** 缺了什么、去哪下 —— 给启动失败时的报错用 */
export function qwenMissingHint(cfg) {
  const s = qwenSettings(cfg);
  const missing = [];
  if (!fs.existsSync(s.model)) missing.push(`模型文件 ${s.model}（下载：${QWEN35_MODEL_PAGE} ，Files 里选 .gguf）`);
  if (!fs.existsSync(s.exe)) missing.push(`llama.cpp 引擎 ${s.exe}（下载：${LLAMA_CPP_RELEASES} ，选 win-cuda-12.4-x64 并解压到 runtime）`);
  return missing.length ? `Qwen3.5 还没部署好，缺少：${missing.join('；')}。详见 docs/qwen35.md` : '';
}

export function qwenInstalled(cfg) {
  const s = qwenSettings(cfg);
  return fs.existsSync(s.exe) && fs.existsSync(s.model);
}

/**
 * llama-server 的 /health：加载中回 503，就绪回 200。
 * online = 进程在听端口；loaded = 模型已可用。
 */
export async function qwenState(cfg) {
  const { port } = qwenSettings(cfg);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return { online: true, loaded: r.ok, port };
  } catch {
    return { online: false, loaded: false, port };
  }
}

/** 拉起 llama-server（独立进程，不随控制台退出），日志写到 logs/kit-qwen35.*.log */
export function spawnQwen(cfg) {
  const s = qwenSettings(cfg);
  if (!fs.existsSync(s.exe)) throw new Error(`没找到 llama.cpp 引擎：${s.exe}`);
  if (!fs.existsSync(s.model)) throw new Error(`没找到模型文件：${s.model}`);
  fs.mkdirSync(s.logDir, { recursive: true });
  const out = fs.openSync(path.join(s.logDir, 'kit-qwen35.stdout.log'), 'a');
  const err = fs.openSync(path.join(s.logDir, 'kit-qwen35.stderr.log'), 'a');
  const args = [
    '-m', s.model, '--alias', QWEN35_ALIAS,
    '--host', '127.0.0.1', '--port', String(s.port),
    '-ngl', '99', '--n-cpu-moe', String(s.nCpuMoe),
    '-c', String(s.ctx), '-fa', 'on', '--jinja',
    '-t', String(s.threads), '-np', '1',
  ];
  // 有视觉投影文件就开看图（工作台那边也要把 input 标成 [text, image]）
  if (s.mmproj) args.push('--mmproj', s.mmproj);
  const child = spawn(s.exe, args, {
    cwd: path.dirname(s.exe), detached: true, windowsHide: true, stdio: ['ignore', out, err],
  });
  child.unref();
  fs.closeSync(out); fs.closeSync(err);
  return child.pid;
}

/** 等 /health 变 200；进程中途退出就立刻报错，不干等 */
export async function waitQwenReady(cfg, timeoutSec = 240) {
  const s = qwenSettings(cfg);
  for (let i = 0; i < timeoutSec; i++) {
    const st = await qwenState(cfg);
    if (st.loaded) return true;
    if (!st.online && i > 20) throw new Error(explainQwenFailure(s));
    await sleep(1000);
  }
  throw new Error('Qwen3.5 加载超时，请查看 logs/kit-qwen35.stderr.log');
}

/** 读日志末尾，按真实原因给报错 —— 别一律说「显存不够」 */
function explainQwenFailure(s) {
  const log = path.join(s.logDir, 'kit-qwen35.stderr.log');
  let tail = '';
  try {
    const buf = fs.readFileSync(log);
    tail = buf.subarray(Math.max(0, buf.length - 4096)).toString('utf8');
  } catch { /* 没日志 */ }
  if (/couldn't bind HTTP server socket/i.test(tail)) {
    return `Qwen3.5 绑不上端口 ${s.port}：被其他程序占用，或被 Windows（Hyper-V/WinNAT）保留了。`
      + '在 配置.json 里把 qwen35Port 换成 15000 以上的端口，工作台配置里的 baseURL 也要一起改。';
  }
  if (/out of memory|cudaMalloc failed|failed to allocate/i.test(tail)) {
    return `Qwen3.5 显存不够：关掉占显存的程序，或在 配置.json 里把 qwen35NCpuMoe 调大（如 16）。日志：${log}`;
  }
  return `Qwen3.5 服务没起来，请查看 ${log}`;
}

/** 停掉占着 Qwen 端口的 llama-server（只杀 llama-server，别的进程占了端口不动它） */
export async function stopQwen(cfg) {
  const { port } = qwenSettings(cfg);
  const pid = pidOnPort(port);
  if (!pid) return false;
  let image = '';
  try {
    image = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8', windowsHide: true });
  } catch { /* ignore */ }
  if (!/llama-server\.exe/i.test(image)) return false;
  try { execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'ignore', windowsHide: true }); } catch { /* 已退出 */ }
  for (let i = 0; i < 20 && pidOnPort(port); i++) await sleep(250);
  return true;
}
