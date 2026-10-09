/**
 * 安装引擎：把安装拆成带进度上报的步骤，供图形界面驱动。
 *
 * 通过 emit(event) 上报：
 *   { type:'step',   id, status:'running'|'done'|'skipped'|'error'|'waiting', text }
 *   { type:'log',    text }
 *   { type:'progress', phase, percent, got, total, speed, eta, parts, text }
 *       phase  当前属于哪一步（model / ollama-setup），界面据此显示标题
 *       got    已下载字节数（仅模型下载有）
 *       total  总字节数（仅模型下载有）
 *       speed  字节/秒（仅模型下载有）
 *       eta    预计剩余秒数（仅模型下载有）
 *       parts  分片进度 { done, total }（仅模型下载有）
 *   { type:'needs-elevation', reason, hint }
 *   { type:'done',   summary }
 *   { type:'error',  text }
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createShortcuts, findDesktop } from './make-shortcuts.mjs';
import { saveConfig } from './config.mjs';
import {
  isUp, servesDir, killOllama, spawnServe, waitUp, ollamaEnv, persistOllamaVars, modelCapabilities,
  OLLAMA_BASE,
} from './ollama.mjs';
import { modelInfo } from './models.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ 进度辅助 */

const BYTE_UNITS = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };

/** 人类可读体积。用十进制单位，和 Ollama 自己的显示口径保持一致 */
function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${Math.round(n)} B`;
}

/** 把 "1.2" + "GB" 解析成字节数 */
function parseHumanBytes(num, unit) {
  return Number(num) * (BYTE_UNITS[String(unit).toUpperCase()] || 1);
}

/**
 * 汇总 Ollama 的分片下载进度。
 *
 * 模型是分片（layer）下载的，一次可能同时下好几个分片，每个分片各有各的百分比。
 * 只上报「某一个分片」的百分比，进度条就会来回跳，用户根本看不出到底下了多少 ——
 * 所以这里按分片分别记账，再汇总成一个整体进度，顺带算出实时速度和剩余时间。
 */
export function createPullTracker(emit, expectedBytes = 0) {
  const parts = new Map(); // 分片 id -> { got, total }
  let firstAt = 0; // 第一个分片事件到达的时间
  let lastAt = 0;
  let lastGot = 0;
  let speed = 0; // 字节/秒，指数滑动平均，避免数字乱跳
  let lastFlush = 0;

  function snapshot() {
    let got = 0;
    let total = 0;
    let done = 0;
    for (const p of parts.values()) {
      got += p.got;
      total += p.total;
      if (p.total > 0 && p.got >= p.total) done++;
    }
    return { got, total, done, all: parts.size };
  }

  return {
    /** 记一个分片的进度（字节） */
    layer(id, got, total) {
      if (!id) return;
      if (!firstAt) firstAt = Date.now();
      const cur = parts.get(id) || { got: 0, total: 0 };
      if (total > 0) cur.total = total;
      const cap = cur.total || got;
      cur.got = Math.max(cur.got, Math.min(got, cap)); // 分片进度只增不减
      parts.set(id, cur);
    },

    /** 刷新一次进度；默认 250ms 节流，避免刷爆 SSE */
    flush({ force = false } = {}) {
      const now = Date.now();
      if (!force && now - lastFlush < 250) return;
      lastFlush = now;

      // 不知道模型标称体积时，分母只能靠「已知分片之和」，而分片是陆续出现的 ——
      // 太早报百分比就会出现「98% 突然掉回 10%」的跳变。
      // 所以先等分片信息稳定下来（约 1.2 秒），这期间只显示「正在获取模型信息」。
      if (expectedBytes <= 0 && (!firstAt || now - firstAt < 1200)) {
        emit({ type: 'progress', phase: 'model', indeterminate: true, percent: 0, text: '正在获取模型信息…' });
        return;
      }

      const { got, total, done, all } = snapshot();
      if (lastAt) {
        const dt = (now - lastAt) / 1000;
        if (dt > 0.2 && got >= lastGot) {
          const inst = (got - lastGot) / dt;
          speed = speed ? speed * 0.6 + inst * 0.4 : inst;
        }
      }
      lastAt = now;
      lastGot = got;

      // 分母取「已知总量」和「模型标称体积」里更大的那个：
      // 刚开始只知道少数分片，用标称体积可以避免进度虚高，也不会中途回退。
      const denom = Math.max(total, expectedBytes);
      const percent = denom > 0 ? Math.min(99, Math.floor((got / denom) * 100)) : 0;

      emit({
        type: 'progress',
        phase: 'model',
        percent,
        got,
        total: denom,
        speed,
        eta: speed > 0 && denom > got ? (denom - got) / speed : 0,
        parts: all > 1 ? { done, total: all } : null,
        text: `${fmtBytes(got)} / ${fmtBytes(denom)}`,
      });
    },
  };
}

/**
 * 走 Ollama 的 HTTP 接口拉模型。
 *
 * /api/pull 会流式返回结构化 JSON（每个分片带 digest / total / completed），
 * 比解析命令行那根进度条可靠得多。
 */
async function pullViaApi(model, emit, tracker) {
  const r = await fetch(`${OLLAMA_BASE}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: true }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (!r.body) throw new Error('响应没有数据流');

  const decoder = new TextDecoder();
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
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      handle(line);
    }
  }
  if (buf.trim()) handle(buf);
}

/** 兜底：老版本 Ollama 没有结构化接口时，解析命令行进度条（精度略低） */
function pullViaCli(exe, model, modelDir, emit, tracker) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ['pull', model], { env: ollamaEnv({ modelDir }), windowsHide: true });

    let buf = '';
    const handle = (chunk) => {
      buf += chunk.toString();
      const lines = buf.split(/[\r\n]/);
      buf = lines.pop();
      for (const line of lines) {
        const id = (line.match(/pulling\s+([0-9a-f]{6,})/i) || [])[1];
        const size = line.match(/([\d.]+)\s*(GB|MB|KB|B)\s*\/\s*([\d.]+)\s*(GB|MB|KB|B)/i);
        if (id && size) {
          tracker.layer(id, parseHumanBytes(size[1], size[2]), parseHumanBytes(size[3], size[4]));
          tracker.flush();
        } else if (/verifying|writing manifest|removing|success/i.test(line)) {
          emit({ type: 'log', text: line.trim() });
        }
      }
    };

    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ollama pull 退出码 ${code}`))));
    child.on('error', reject);
  });
}

/** 固定 DeepSeek Harness 版本：它的 latest 还是 RC，配置格式变了会导致装完用不了 */
export const DSH_PACKAGE = '@deepseek-ai/dsh@0.2.0-rc.2';

/** 路径规范化：统一反斜杠、合并重复分隔符。外部传进来的路径不可信。 */
function normPath(p) {
  if (!p) return p;
  return String(p).replace(/\//g, '\\').replace(/\\{2,}/g, '\\');
}

const SCRIPT_FILES = [
  'config.mjs', 'models.mjs', 'ollama.mjs', 'idlist.mjs', 'make-lnk.mjs', 'make-shortcuts.mjs',
  'start-local-ai.mjs', 'stop-local-ai.mjs',
];

/**
 * 安装目录里的 .cmd 入口。内容必须是纯 ASCII + CRLF。
 * 优先用安装目录里自带的 node（用便携 Node 安装时会复制一份过来），否则用 PATH 里的。
 */
const cmdEntry = (title, script) => `@echo off
chcp 65001 >nul
set NODE_OPTIONS=
title ${title}
set "NODE_EXE=node"
if exist "%~dp0node\\node.exe" set "NODE_EXE=%~dp0node\\node.exe"
echo.
"%NODE_EXE%" "%~dp0${script}"
echo.
pause
`.replace(/\n/g, '\r\n');

export const CMD_ENTRIES = {
  'start-ai.cmd': cmdEntry('Local AI Workspace', 'start-local-ai.mjs'),
  'stop-ai.cmd': cmdEntry('Stop Local AI', 'stop-local-ai.mjs'),
  '重建桌面图标.cmd': cmdEntry('Rebuild Desktop Shortcuts', 'make-shortcuts.mjs'),
};

/** 当前 node 是否在 PATH 里（不在 = 用的是部署包自带的便携 Node） */
function nodeOnPath() {
  try {
    execSync('where node', { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function isPermError(e) {
  return e && (e.code === 'EACCES' || e.code === 'EPERM' || /access is denied|拒绝访问|权限/i.test(String(e.message)));
}

/* ------------------------------------------------------------------ 各步骤 */

async function stepPrepare(opts, emit) {
  const { root, kitDir } = opts;
  emit({ type: 'step', id: 'prepare', status: 'running', text: '准备安装目录' });

  try {
    fs.mkdirSync(root, { recursive: true });
    for (const f of SCRIPT_FILES) {
      fs.copyFileSync(path.join(kitDir, 'scripts', f), path.join(root, f));
    }
    fs.mkdirSync(path.join(root, 'icons'), { recursive: true });
    for (const f of fs.readdirSync(path.join(kitDir, 'icons'))) {
      fs.copyFileSync(path.join(kitDir, 'icons', f), path.join(root, 'icons', f));
    }
    for (const [f, body] of Object.entries(CMD_ENTRIES)) {
      fs.writeFileSync(path.join(root, f), body, 'ascii');
    }
    // 用便携 Node 运行时，把 node.exe 复制到安装目录，桌面图标才能脱离部署包独立运行
    if (!nodeOnPath()) {
      const dst = path.join(root, 'node', 'node.exe');
      if (path.resolve(process.execPath) !== path.resolve(dst)) {
        try {
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.copyFileSync(process.execPath, dst);
          emit({ type: 'log', text: `已复制 Node.js 运行时到 ${dst}` });
        } catch (e) {
          // 工作台正在运行时 node.exe 被占用，沿用旧的即可
          emit({ type: 'log', text: `! 复制 Node.js 运行时失败（${e.code || e.message}），沿用已有版本` });
        }
      }
    }
    emit({ type: 'log', text: `安装目录：${root}` });
    emit({ type: 'step', id: 'prepare', status: 'done', text: '安装目录就绪' });
    return true;
  } catch (e) {
    if (isPermError(e)) {
      emit({
        type: 'needs-elevation',
        reason: `无法写入安装目录：${root}`,
        hint: '该位置需要管理员权限。可以换一个位置，或以管理员身份重新运行安装程序。',
      });
    }
    emit({ type: 'step', id: 'prepare', status: 'error', text: String(e.message || e) });
    return false;
  }
}

async function stepOllama(opts, emit) {
  const { modelDir, ollamaExe } = opts;
  emit({ type: 'step', id: 'ollama', status: 'running', text: '准备 Ollama 推理服务' });

  if (!ollamaExe) {
    emit({
      type: 'needs-elevation',
      reason: '未检测到 Ollama，需要先安装',
      hint: 'Ollama 是本地模型运行引擎，必须安装。点击下方按钮会自动下载并安装（会弹出 Windows 管理员授权窗口）。',
      action: 'install-ollama',
    });
    emit({ type: 'step', id: 'ollama', status: 'waiting', text: '等待安装 Ollama' });
    return false;
  }

  try {
    fs.mkdirSync(modelDir, { recursive: true });
  } catch (e) {
    emit({ type: 'step', id: 'ollama', status: 'error', text: `无法创建模型目录 ${modelDir}：${e.message}` });
    return false;
  }

  // 写入用户环境变量：Ollama 托盘程序开机自启时也会用同一个模型目录和参数
  const failed = persistOllamaVars(opts);
  if (failed.length) emit({ type: 'log', text: `! 写入环境变量失败：${failed.join(', ')}（不影响本次安装）` });

  // 关键：服务用哪个模型目录由它「启动时」的环境变量决定，
  // 而 ollama pull 是通过运行中的服务写入的 —— 所以必须保证目录一致。
  // 只有能证明运行中的服务就是用这个目录时才复用；否则（包括目录还是空的）一律重启。
  if (await isUp()) {
    if (await servesDir(modelDir)) {
      emit({ type: 'log', text: 'Ollama 服务已在运行，且模型目录一致。' });
      emit({ type: 'step', id: 'ollama', status: 'done', text: 'Ollama 已就绪' });
      return true;
    }
    emit({ type: 'log', text: '正在用配置的模型目录重启 Ollama...' });
    killOllama();
    await sleep(2500);
  } else {
    emit({ type: 'log', text: '正在以配置的模型目录启动 Ollama...' });
  }

  spawnServe(ollamaExe, opts, { detached: true });
  if (await waitUp(40)) {
    emit({ type: 'log', text: `Ollama 已启动（模型目录：${modelDir}）` });
    emit({ type: 'step', id: 'ollama', status: 'done', text: 'Ollama 已就绪' });
    return true;
  }
  emit({ type: 'step', id: 'ollama', status: 'error', text: '启动超时' });
  return false;
}

/**
 * 拉取模型。
 *
 * 关键点：进度是「所有分片合起来」的，不是某一个分片的 —— 否则进度条会来回跳。
 * 优先用 HTTP 接口拿结构化数据；拿不到再退回命令行解析。
 */
async function stepPullModel(opts, emit) {
  const { model, modelDir, ollamaExe } = opts;
  emit({ type: 'step', id: 'model', status: 'running', text: `下载模型 ${model}` });

  const expected = Math.round((modelInfo(model)?.gb || 0) * 1e9);
  const tracker = createPullTracker(emit, expected);
  tracker.flush({ force: true });

  try {
    await pullViaApi(model, emit, tracker);
  } catch (e) {
    emit({ type: 'log', text: `! 结构化进度不可用（${e.message}），改用命令行进度` });
    try {
      await pullViaCli(ollamaExe, model, modelDir, emit, tracker);
    } catch (e2) {
      emit({ type: 'log', text: String(e2.message || e2) });
      emit({ type: 'step', id: 'model', status: 'error', text: '下载未完成，可重新运行继续' });
      return false;
    }
  }

  emit({ type: 'progress', phase: 'model', percent: 100, text: '完成' });
  emit({ type: 'step', id: 'model', status: 'done', text: '模型已就绪' });
  return true;
}

function stepDsh(opts, emit) {
  const { root } = opts;
  emit({ type: 'step', id: 'dsh', status: 'running', text: '安装 DeepSeek Harness' });

  const dshDir = path.join(root, 'dsh-runtime');
  const bin = path.join(dshDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

  if (fs.existsSync(bin)) {
    emit({ type: 'log', text: 'DeepSeek Harness 已安装，跳过。' });
    emit({ type: 'step', id: 'dsh', status: 'skipped', text: '已安装' });
    return Promise.resolve(true);
  }

  try {
    fs.mkdirSync(dshDir, { recursive: true });
    fs.writeFileSync(path.join(dshDir, 'package.json'),
      JSON.stringify({ name: 'local-ai-runtime', private: true }, null, 2));
  } catch (e) {
    if (isPermError(e)) {
      emit({ type: 'needs-elevation', reason: `无法写入 ${dshDir}`, hint: '该位置需要管理员权限。' });
    }
    emit({ type: 'step', id: 'dsh', status: 'error', text: String(e.message) });
    return Promise.resolve(false);
  }

  emit({ type: 'log', text: `正在安装 ${DSH_PACKAGE}（约 1–3 分钟，请勿关闭）...` });

  // 用异步 spawn 而不是 spawnSync：不阻塞事件循环，
  // npm 的输出能实时转发到界面，用户能看到「还在动」而不是页面一动不动。
  // 必须 --ignore-scripts：koffi 的 postinstall 缺 CMake 会失败并让 npm 回滚整个安装。
  // PATH 里加上当前 node 所在目录：用便携 Node 时 npm 就在它旁边。
  return new Promise((resolve) => {
    const child = spawn('npm',
      ['install', DSH_PACKAGE, '--ignore-scripts', '--no-audit', '--no-fund'],
      {
        cwd: dshDir,
        shell: true,
        windowsHide: true,
        env: { ...process.env, PATH: `${path.dirname(process.execPath)};${process.env.PATH || ''}` },
      });

    let buf = '';
    const handle = (chunk) => {
      buf += chunk.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (s) emit({ type: 'log', text: s });
      }
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);

    const finish = () => {
      if (fs.existsSync(bin)) {
        emit({ type: 'step', id: 'dsh', status: 'done', text: 'DeepSeek Harness 已就绪' });
        return resolve(true);
      }
      const tail = buf.split(/\r?\n/).slice(-6).join('\n');
      if (/EACCES|EPERM|denied/i.test(tail)) {
        emit({ type: 'needs-elevation', reason: '安装 DeepSeek Harness 时权限不足', hint: '尝试以管理员身份重新运行。' });
      }
      if (tail) emit({ type: 'log', text: tail });
      emit({ type: 'step', id: 'dsh', status: 'error', text: '安装失败' });
      resolve(false);
    };

    child.on('close', finish);
    child.on('error', (e) => {
      emit({ type: 'log', text: String(e.message) });
      finish();
    });
  });
}

const GENERATED_MARK = '# 由本地 AI 安装向导生成';

async function stepConfig(opts, emit) {
  const { root, model, contextWindow } = opts;
  emit({ type: 'step', id: 'config', status: 'running', text: '写入配置' });

  // 按模型实际能力声明输入类型：纯文本模型声明 image 会让工作台发图片过去直接报错
  const caps = await modelCapabilities(model);
  const input = caps && !caps.includes('vision') ? '[text]' : '[text, image]';
  if (caps && !caps.includes('tools')) {
    emit({ type: 'log', text: `! ${model} 不支持工具调用，工作台只能聊天，不能读写文件 / 执行命令。` });
  }

  try {
    saveConfig(root, { model, modelDir: opts.modelDir, contextWindow });

    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const patch = (withDefault) => `${GENERATED_MARK}
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      ollama-local:
        displayName: Ollama 本地 (${model})
        apiKeyEnv: OLLAMA_API_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:11434/v1
        models:
          - id: ${model}
            name: ${model} 本地
            contextWindow: ${contextWindow}
            maxTokens: 8192
            input: ${input}
${withDefault ? `- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: ollama-local
    model: ${model}
` : ''}`;

    for (const p of ['web', 'headless']) {
      const dir = path.join(home, 'profiles', p);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'cordis.patch.yml');
      // 用户自己写过的配置先备份，不直接覆盖
      if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').startsWith(GENERATED_MARK)) {
        const bak = `${file}.${Date.now()}.bak`;
        fs.copyFileSync(file, bak);
        emit({ type: 'log', text: `已备份原有配置：${bak}` });
      }
      fs.writeFileSync(file, patch(p === 'headless'), 'utf8');
    }

    // 本地端点也需要一个非空 API key
    const cred = path.join(home, '.credentials.yaml');
    let text = fs.existsSync(cred) ? fs.readFileSync(cred, 'utf8') : 'version: 1\nrecords: {}\nrefs:\n';
    if (!/OLLAMA_API_KEY/.test(text)) {
      if (/^refs:\s*\{\s*\}\s*$/m.test(text)) text = text.replace(/^refs:\s*\{\s*\}\s*$/m, 'refs:');
      if (!/^refs:/m.test(text)) text += '\nrefs:\n';
      text = text.replace(/^refs:[ \t]*$/m, 'refs:\n  OLLAMA_API_KEY: ollama');
      fs.writeFileSync(cred, text, 'utf8');
    }

    emit({ type: 'step', id: 'config', status: 'done', text: '配置已写入' });
    return true;
  } catch (e) {
    if (isPermError(e)) {
      emit({ type: 'needs-elevation', reason: '无法写入 dsh 配置目录', hint: '该位置需要管理员权限。' });
    }
    emit({ type: 'step', id: 'config', status: 'error', text: String(e.message) });
    return false;
  }
}

function stepShortcuts(opts, emit) {
  const { root } = opts;
  emit({ type: 'step', id: 'shortcuts', status: 'running', text: '创建桌面快捷方式' });
  try {
    const desktop = findDesktop();
    emit({ type: 'log', text: `桌面位置：${desktop}` });
    const n = createShortcuts(root, desktop, (line) => emit({ type: 'log', text: line }));
    emit({ type: 'step', id: 'shortcuts', status: n ? 'done' : 'error', text: n ? `已创建 ${n} 个快捷方式` : '创建失败' });
    return n > 0;
  } catch (e) {
    emit({ type: 'step', id: 'shortcuts', status: 'error', text: String(e.message) });
    return false;
  }
}

/* ------------------------------------------------------------------ 主流程 */

export async function runInstall(opts, emit) {
  const kitDir = opts.kitDir || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const o = {
    ...opts,
    kitDir,
    root: normPath(opts.root),
    modelDir: normPath(opts.modelDir),
  };

  emit({ type: 'begin' });

  if (!(await stepPrepare(o, emit))) return emit({ type: 'error', text: '准备安装目录失败' });
  if (!(await stepOllama(o, emit))) return emit({ type: 'error', text: 'Ollama 未就绪' });
  if (!(await stepPullModel(o, emit))) return emit({ type: 'error', text: '模型下载未完成' });
  if (!(await stepDsh(o, emit))) return emit({ type: 'error', text: 'DeepSeek Harness 安装失败' });
  if (!(await stepConfig(o, emit))) return emit({ type: 'error', text: '配置写入失败' });
  stepShortcuts(o, emit);

  emit({
    type: 'done',
    summary: {
      root: o.root,
      model: o.model,
      modelDir: o.modelDir,
      contextWindow: o.contextWindow,
    },
  });
}
