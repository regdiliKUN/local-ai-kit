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
 *   { type:'needs-elevation', reason, hint, action }
 *   { type:'paused', stage }        缺前置（如 Ollama）导致的暂停，不是失败
 *   { type:'done',   summary }
 *   { type:'error',  text, stage, remedy:[...] }
 *       stage   停在哪一步（prepare / ollama / model / verify / dsh / config）
 *       remedy  这一步失败时「你可以这样做」的分步指引，界面直接列出来
 *
 * 入参 opts：
 *   model / modelDir / contextWindow / root       必填
 *   proxy       可选，HTTP 代理（形如 http://127.0.0.1:7890），走命令行 pull
 *   ollamaExe   可选，Ollama 可执行文件路径
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
  hasModel, OLLAMA_BASE,
} from './ollama.mjs';
import { modelInfo } from './models.mjs';
import { toLines, seqItemRange, spliceSeqItem, spliceMapKey, insertUnderMapKey } from './yamlpatch.mjs';

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
function pullViaCli(exe, model, modelDir, emit, tracker, envOverride) {
  return new Promise((resolve, reject) => {
    const env = envOverride || ollamaEnv({ modelDir });
    const child = spawn(exe, ['pull', model], { env, windowsHide: true });

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
  'config.mjs', 'models.mjs', 'ollama.mjs', 'detect.mjs', 'idlist.mjs', 'make-lnk.mjs',
  'make-shortcuts.mjs', 'start-local-ai.mjs', 'stop-local-ai.mjs',
  'console.mjs', 'uninstall.mjs',
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

/**
 * 卸载入口必须**先切到临时目录**再跑 node：
 * 卸载的最后一步要删掉安装目录本身，如果当前目录还在里面，Windows 会拒绝删除。
 */
const uninstallEntry = `@echo off
set NODE_OPTIONS=
title Uninstall Local AI
cd /d "%TEMP%"
set "NODE_EXE=node"
if exist "%~dp0node\\node.exe" set "NODE_EXE=%~dp0node\\node.exe"
"%NODE_EXE%" "%~dp0uninstall.mjs"
echo.
pause
`.replace(/\n/g, '\r\n');

export const CMD_ENTRIES = {
  'start-ai.cmd': cmdEntry('Local AI Workspace', 'start-local-ai.mjs'),
  'stop-ai.cmd': cmdEntry('Stop Local AI', 'stop-local-ai.mjs'),
  '控制台.cmd': cmdEntry('Local AI Console', 'console.mjs'),
  '卸载.cmd': uninstallEntry,
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

/* --------------------------------------------------------- 失败时的指引 */

/**
 * 每一步失败时给用户的「你可以这样做」。
 * 只甩一句报错对非技术用户毫无意义，所以失败必须带上分步的自救指引。
 */
export const REMEDIES = {
  prepare: [
    '确认安装位置的磁盘没有满、也没有被安全软件锁住',
    '如果装了 360 / 火绒之类的安全软件，先临时退出再点「重试安装」',
    '还不行就把部署包解压到 D 盘或 E 盘（路径别有中文），重新双击「① 双击这里开始安装.cmd」',
  ],
  ollama: [
    '确认 Ollama 已经装完（安装窗口跑完、托盘出现羊驼图标）再点「重试安装」',
    '如果弹出了管理员授权窗口，请点「是」',
    '也可以手动到 https://ollama.com/download 下载安装，再回来点「重试安装」',
  ],
  model: [
    '先确认电脑能上网（模型要从 ollama.com 下载）',
    '点「重试安装」就能续传 —— 已经下好的部分不会重下',
    '网速太慢就换个更小的模型，或者换个时间再试；也可以在「存放位置」那一步填一个 HTTP 代理',
  ],
  verify: [
    '点「重试安装」再试一次 —— 多半是模型文件没下完整',
    '如果提示显存不足：回到上一步换个小一点的模型，或把上下文长度调小',
    '还不行就删掉安装目录里的 配置.json，重新运行安装向导',
  ],
  dsh: [
    '确认能访问 npm 源（公司网络或代理可能把它拦了）',
    '点「重试安装」重来一次，npm 会跳过已经下好的包',
    '临时关掉代理 / 安全软件后再试',
  ],
  config: [
    '确认对当前用户的文件夹有写入权限',
    '关掉向导，右键「① 双击这里开始安装.cmd」→「以管理员身份运行」再试',
  ],
  shortcuts: [
    '桌面可能被重定向到了别的盘，或者设成了只读',
    '不影响使用：装完后到安装目录里双击「重建桌面图标.cmd」就能补回来',
  ],
};

const FAIL_TEXT = {
  prepare: '准备安装目录失败',
  ollama: 'Ollama 未就绪',
  model: '模型下载未完成',
  verify: '模型校验没通过',
  dsh: 'DeepSeek Harness 安装失败',
  config: '配置写入失败',
};

/** 某个路径所在磁盘的剩余空间（GB）；取不到返回 null */
function diskFreeGB(p) {
  try {
    const st = fs.statfsSync(path.parse(path.resolve(p)).root);
    return Math.round((st.bsize * st.bavail) / 1e9);
  } catch { return null; }
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
    // 界面文件也复制过去：安装目录里的「本地AI控制台」要用它
    const uiSrc = path.join(kitDir, 'ui');
    if (fs.existsSync(uiSrc)) {
      const uiDst = path.join(root, 'ui');
      fs.mkdirSync(uiDst, { recursive: true });
      for (const f of fs.readdirSync(uiSrc)) {
        const s = path.join(uiSrc, f);
        if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(uiDst, f));
      }
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
      hint: 'Ollama 是本地模型运行引擎，必须安装。点下面的按钮会自动下载并安装（会弹出 Windows 管理员授权窗口，点「是」即可），装完向导会自动接着往下装。',
      action: 'install-ollama',
    });
    emit({ type: 'step', id: 'ollama', status: 'waiting', text: '等待安装 Ollama' });
    return 'paused';   // 缺前置 ≠ 失败，界面显示「等你完成一步」而不是「安装未完成」
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
 * 配了代理时直接走命令行：Node 自带的 fetch 默认不认系统代理，而 Ollama（Go）认 HTTPS_PROXY。
 */
async function stepPullModel(opts, emit) {
  const { model, modelDir, ollamaExe, proxy } = opts;
  emit({ type: 'step', id: 'model', status: 'running', text: `下载模型 ${model}` });

  // 本机已经有这个模型：直接复用，省掉一次十几 GB 的下载
  if (hasModel(modelDir, model)) {
    emit({ type: 'log', text: `${modelDir} 里已经有 ${model}，直接复用，不用重新下载。` });
    emit({ type: 'progress', phase: 'model', percent: 100, text: '本机已有，跳过下载' });
    emit({ type: 'step', id: 'model', status: 'skipped', text: '本机已有，跳过下载' });
    return true;
  }

  // 空间预检：分片下载写到一半没空间会很麻烦，提前拦一道
  const needGB = Math.ceil((modelInfo(model)?.gb || 0) * 1.3);
  const freeGB = diskFreeGB(modelDir);
  if (freeGB != null && needGB > 0 && freeGB < needGB) {
    emit({ type: 'log', text: `! 目标磁盘剩余 ${freeGB} GB，预计需要 ${needGB} GB` });
    emit({ type: 'step', id: 'model', status: 'error', text: `磁盘空间不足（剩 ${freeGB} GB，需要约 ${needGB} GB）` });
    return false;
  }
  if (freeGB != null) emit({ type: 'log', text: `目标磁盘剩余 ${freeGB} GB，预计需要 ${needGB} GB。` });

  const expected = Math.round((modelInfo(model)?.gb || 0) * 1e9);
  const tracker = createPullTracker(emit, expected);
  tracker.flush({ force: true });

  const cliEnv = proxy
    ? { ...ollamaEnv({ modelDir }), HTTPS_PROXY: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy }
    : null;

  if (proxy) {
    emit({ type: 'log', text: `已启用代理 ${proxy}，改用命令行下载。` });
    try {
      await pullViaCli(ollamaExe, model, modelDir, emit, tracker, cliEnv);
    } catch (e) {
      emit({ type: 'log', text: String(e.message || e) });
      emit({ type: 'step', id: 'model', status: 'error', text: '下载未完成，可重新运行继续' });
      return false;
    }
  } else {
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
  }

  emit({ type: 'progress', phase: 'model', percent: 100, text: '完成' });
  emit({ type: 'step', id: 'model', status: 'done', text: '模型已就绪' });
  return true;
}

/**
 * 模型完整性校验。
 *
 * ollama pull 自己会校验分片摘要，但「文件下载完整」不等于「能跑起来」——
 * 显存不够、模型跟 Ollama 版本不匹配，都要等真正加载时才暴露。
 * 所以这里显式跑一次 1 token 的推理，把问题在安装阶段就摆出来，
 * 而不是等用户打开工作台提问才发现「本地运行失败」。
 */
async function stepVerify(opts, emit) {
  const { model, contextWindow } = opts;
  emit({ type: 'step', id: 'verify', status: 'running', text: '校验模型' });

  const show = await fetch(`${OLLAMA_BASE}/api/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  if (!show || !show.ok) {
    emit({ type: 'log', text: '模型没有注册到 Ollama 服务里。' });
    emit({ type: 'step', id: 'verify', status: 'error', text: '模型没注册成功' });
    return false;
  }
  emit({ type: 'log', text: '模型文件完整，已注册到 Ollama。' });

  emit({ type: 'log', text: `正在试加载一次（上下文 ${contextWindow}，首次约 1 分钟）...` });
  let r = null;
  try {
    r = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: 'hi',
        stream: false,
        options: { num_predict: 1, num_ctx: contextWindow },
      }),
      signal: AbortSignal.timeout(300000),
    });
  } catch (e) {
    emit({ type: 'log', text: `试加载失败：${e.message}` });
    emit({ type: 'step', id: 'verify', status: 'error', text: '模型加载失败' });
    return false;
  }
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    emit({ type: 'log', text: `试加载失败：${j.error || `HTTP ${r.status}`}` });
    emit({ type: 'step', id: 'verify', status: 'error', text: '模型加载失败（多半是显存不够）' });
    return false;
  }

  emit({ type: 'step', id: 'verify', status: 'done', text: '模型可以正常运行' });
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

/** 部署包版本；写进生成的配置，方便以后判断这份文件是谁写的、要不要升级 */
export const KIT_VERSION = '1.3.0';

/* ------------------------------------------------- dsh 配置块（未缩进） */

function providerBlock(model, contextWindow, input) {
  return `ollama-local:
  displayName: Ollama 本地 (${model})
  apiKeyEnv: OLLAMA_API_KEY
  api: openai-completions
  baseURL: http://127.0.0.1:11434/v1
  models:
    - id: ${model}
      name: ${model} 本地
      contextWindow: ${contextWindow}
      maxTokens: 8192
      input: ${input}`;
}

function llmPiAiBlock(model, contextWindow, input) {
  const prov = providerBlock(model, contextWindow, input)
    .split('\n').map((l) => (l.trim() ? `      ${l}` : '')).join('\n');
  return `- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
${prov}`;
}

/** headless 档没有 agent 预设，compaction-basic 就挂在根层，按 id 就能命中 */
function compactionBlock() {
  return `- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  config:
    thresholdRatio: 0.6
    headroomTokens: 8192
    retainRatio: 0.25`;
}

function defaultModelBlock(model) {
  return `- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: ollama-local
    model: ${model}`;
}

/**
 * 读取 preset-standard 副本（web 档要用它覆盖 dsh 默认预设，才能改到
 * 预设内部的 compaction-basic）。读不到就返回 null，调用方跳过这一项。
 */
export function readPresetStandard(kitDir) {
  try {
    return fs.readFileSync(path.join(kitDir, 'scripts', 'preset-standard.patch.yml'), 'utf8');
  } catch { return null; }
}

/**
 * 去掉副本开头的说明注释，只留 YAML 实体。
 * 合并（而不是新建）时必须用它：否则每跑一次安装就会把那段注释再插一遍，越堆越多。
 */
export function presetBody(presetText) {
  const lines = toLines(presetText);
  let i = 0;
  while (i < lines.length && (lines[i].trim() === '' || lines[i].trimStart().startsWith('#'))) i++;
  return lines.slice(i).join('\n').trimEnd();
}

/**
 * 把一个 profile 的配置文本更新到最新。
 *
 * **定点合并，不整份覆盖**：只替换 ollama-local / preset-standard /
 * compaction-basic / agent-default-model 这几个条目，用户在同一个文件里
 * 自己加的 provider、插件配置原样保留。
 *
 * @returns {{ text: string, notes: string[] }}
 */
export function patchProfileText(prevText, { profile, model, contextWindow, input, presetText }) {
  const notes = [];
  let text = String(prevText || '');

  if (!text.trim()) {
    const parts = [
      GENERATED_MARK,
      `# kit-version: ${KIT_VERSION}`,
      llmPiAiBlock(model, contextWindow, input),
    ];
    if (profile === 'web' && presetText) parts.push(presetText.trimEnd());
    if (profile === 'headless') parts.push(compactionBlock(), defaultModelBlock(model));
    return { text: `${parts.join('\n')}\n`, notes: ['新建配置'] };
  }

  // ---- 1) 本地 provider ----
  const prov = providerBlock(model, contextWindow, input);
  let done = false;
  const range = seqItemRange(toLines(text), 'llm-pi-ai');
  if (range) {
    const scoped = { from: range[0], to: range[1] };
    const r1 = spliceMapKey(text, 'ollama-local', prov, scoped);
    if (r1 != null) {
      text = r1;
      done = true;
      notes.push('更新 ollama-local（你添加的其它 provider 原样保留）');
    } else {
      const r2 = insertUnderMapKey(text, 'providers', prov, scoped);
      if (r2 != null) {
        text = r2;
        done = true;
        notes.push('在 llm-pi-ai 下新增 ollama-local（你添加的其它 provider 原样保留）');
      }
    }
  }
  if (!done) {
    text = spliceSeqItem(text, 'llm-pi-ai', llmPiAiBlock(model, contextWindow, input));
    notes.push('新增 llm-pi-ai 配置块');
  }

  // ---- 2) web 档：重述 preset-standard，修复长对话被压缩禁用 ----
  if (profile === 'web' && presetText) {
    text = spliceSeqItem(text, 'preset-standard', presetBody(presetText));
    notes.push('写入 preset-standard（修复长对话「已达输出 token 上限」）');
  }

  // ---- 3) headless 档：根层压缩配置 + 默认模型 ----
  if (profile === 'headless') {
    text = spliceSeqItem(text, 'compaction-basic', compactionBlock());
    text = spliceSeqItem(text, 'agent-default-model', defaultModelBlock(model));
    notes.push('写入 compaction-basic / agent-default-model');
  }

  return { text, notes };
}

/** 改动前留一份带时间戳的备份，最多保留 3 份 */
function backupProfile(file, emit) {
  try {
    const bak = `${file}.${Date.now()}.bak`;
    fs.copyFileSync(file, bak);
    emit({ type: 'log', text: `已备份原有配置：${bak}` });
    const dir = path.dirname(file);
    const base = path.basename(file);
    const olds = fs.readdirSync(dir)
      .filter((n) => n.startsWith(`${base}.`) && n.endsWith('.bak'))
      .sort();
    for (const n of olds.slice(0, Math.max(0, olds.length - 3))) {
      try { fs.rmSync(path.join(dir, n), { force: true }); } catch { /* ignore */ }
    }
  } catch (e) {
    emit({ type: 'log', text: `! 备份配置失败（${e.code || e.message}），继续写入` });
  }
}

async function stepConfig(opts, emit) {
  const { root, model, contextWindow, kitDir } = opts;
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
    const presetText = readPresetStandard(kitDir);
    if (!presetText) emit({ type: 'log', text: '! 没找到 preset-standard 副本，跳过长对话优化' });

    for (const profile of ['web', 'headless']) {
      const dir = path.join(home, 'profiles', profile);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'cordis.patch.yml');
      const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      const { text, notes } = patchProfileText(prev, { profile, model, contextWindow, input, presetText });
      if (prev && prev !== text) backupProfile(file, emit);
      if (prev !== text) {
        fs.writeFileSync(file, text, 'utf8');
        for (const n of notes) emit({ type: 'log', text: `${profile} 档：${n}` });
      } else {
        emit({ type: 'log', text: `${profile} 档：配置已是最新，未改动` });
      }
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

/**
 * 跑完整安装。
 * @returns {Promise<{ok:boolean, paused?:boolean, stage?:string}>}
 */
export async function runInstall(opts, emit) {
  const kitDir = opts.kitDir || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const o = {
    ...opts,
    kitDir,
    root: normPath(opts.root),
    modelDir: normPath(opts.modelDir),
  };

  emit({ type: 'begin' });

  const stages = [
    ['prepare', () => stepPrepare(o, emit)],
    ['ollama', () => stepOllama(o, emit)],
    ['model', () => stepPullModel(o, emit)],
    ['verify', () => stepVerify(o, emit)],
    ['dsh', () => stepDsh(o, emit)],
    ['config', () => stepConfig(o, emit)],
  ];

  for (const [stage, run] of stages) {
    const r = await run();
    // 「缺前置」不是失败：比如没装 Ollama，界面要显示「等你完成一步」并自动续装
    if (r === 'paused') {
      emit({ type: 'paused', stage });
      return { ok: false, paused: true, stage };
    }
    if (!r) {
      emit({
        type: 'error',
        stage,
        text: FAIL_TEXT[stage] || '安装失败',
        remedy: REMEDIES[stage] || [],
      });
      return { ok: false, stage };
    }
  }

  const shortcutsOk = stepShortcuts(o, emit);

  emit({
    type: 'done',
    summary: {
      root: o.root,
      model: o.model,
      modelDir: o.modelDir,
      contextWindow: o.contextWindow,
      shortcutsOk,
    },
  });
  return { ok: true };
}
