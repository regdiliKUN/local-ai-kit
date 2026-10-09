/**
 * 安装引擎：把安装拆成带进度上报的步骤，供图形界面驱动。
 *
 * 通过 emit(event) 上报：
 *   { type:'step',   id, status:'running'|'done'|'skipped'|'error'|'waiting', text }
 *   { type:'log',    text }
 *   { type:'progress', percent, text }
 *   { type:'needs-elevation', reason, hint }
 *   { type:'done',   summary }
 *   { type:'error',  text }
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { modelInfo, pickContextWindow } from './models.mjs';
import { createShortcuts, findDesktop } from './make-shortcuts.mjs';
import { saveConfig } from './config.mjs';

const OLLAMA_BASE = 'http://127.0.0.1:11434';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 路径规范化：统一反斜杠、合并重复分隔符。外部传进来的路径不可信。 */
function normPath(p) {
  if (!p) return p;
  return String(p).replace(/\//g, '\\').replace(/\\{2,}/g, '\\');
}

const SCRIPT_FILES = [
  'config.mjs', 'models.mjs', 'idlist.mjs', 'make-lnk.mjs', 'make-shortcuts.mjs',
  'start-local-ai.mjs', 'stop-local-ai.mjs',
];

const CMD_ENTRIES = {
  'start-ai.cmd': `@echo off
chcp 65001 >nul
set NODE_OPTIONS=
title Local AI Workspace
echo.
node "%~dp0start-local-ai.mjs"
echo.
pause
`,
  'stop-ai.cmd': `@echo off
chcp 65001 >nul
title Stop Local AI
echo.
node "%~dp0stop-local-ai.mjs"
echo.
pause
`,
  '重建桌面图标.cmd': `@echo off
chcp 65001 >nul
set NODE_OPTIONS=
title Rebuild Desktop Shortcuts
echo.
node "%~dp0make-shortcuts.mjs"
echo.
pause
`,
};

async function isUp(url, timeout = 3000) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(timeout) });
    return true;
  } catch { return false; }
}

function killOllama() {
  for (const img of ['ollama app.exe', 'ollama.exe']) {
    try { execSync(`taskkill /IM "${img}" /F`, { stdio: 'ignore' }); } catch { /* 没在跑 */ }
  }
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
  const { model, modelDir, ollamaExe } = opts;
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

  const env = {
    ...process.env,
    OLLAMA_HOST: '127.0.0.1:11434',
    OLLAMA_MODELS: modelDir,
    OLLAMA_FLASH_ATTENTION: '1',
    OLLAMA_KV_CACHE_TYPE: 'q8_0',
    OLLAMA_CONTEXT_LENGTH: String(opts.contextWindow || 32768),
    OLLAMA_KEEP_ALIVE: '30m',
  };

  // 关键：服务用哪个模型目录由它「启动时」的环境变量决定，
  // 而 ollama pull 是通过运行中的服务写入的 —— 所以必须保证目录一致。
  if (await isUp(`${OLLAMA_BASE}/api/version`)) {
    const tags = await fetch(`${OLLAMA_BASE}/api/tags`).then((r) => r.json()).catch(() => null);
    const visible = (tags?.models || []).some((m) => m.name === model);
    const onDisk = modelInfo(model) && fs.existsSync(path.join(
      modelDir, 'manifests', 'registry.ollama.ai', 'library',
      model.split(':')[0], model.split(':')[1] || 'latest',
    ));
    if (visible || !onDisk) {
      emit({ type: 'log', text: 'Ollama 服务已在运行。' });
      emit({ type: 'step', id: 'ollama', status: 'done', text: 'Ollama 已就绪' });
      return true;
    }
    emit({ type: 'log', text: '运行中的 Ollama 使用了别的模型目录，正在重启...' });
    killOllama();
    await sleep(2500);
  } else {
    emit({ type: 'log', text: '正在以配置的模型目录启动 Ollama...' });
  }

  const child = spawn(ollamaExe, ['serve'], { detached: true, stdio: 'ignore', env });
  child.unref();

  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    if (await isUp(`${OLLAMA_BASE}/api/version`, 1500)) {
      emit({ type: 'log', text: `Ollama 已启动（模型目录：${modelDir}）` });
      emit({ type: 'step', id: 'ollama', status: 'done', text: 'Ollama 已就绪' });
      return true;
    }
  }
  emit({ type: 'step', id: 'ollama', status: 'error', text: '启动超时' });
  return false;
}

/** 拉取模型，并把 ollama 的进度条解析成百分比 */
function stepPullModel(opts, emit) {
  const { model, modelDir, ollamaExe } = opts;
  emit({ type: 'step', id: 'model', status: 'running', text: `下载模型 ${model}` });

  return new Promise((resolve) => {
    const child = spawn(ollamaExe, ['pull', model], {
      env: { ...process.env, OLLAMA_MODELS: modelDir },
    });

    let buf = '';
    const handle = (chunk) => {
      buf += chunk.toString();
      const parts = buf.split(/[\r\n]/);
      buf = parts.pop();
      for (const line of parts) {
        const pct = line.match(/(\d+)%/);
        const size = line.match(/([\d.]+)\s*(GB|MB)\s*\/\s*([\d.]+)\s*(GB|MB)/);
        if (pct) {
          const text = size ? `${size[1]} ${size[2]} / ${size[3]} ${size[4]}` : line.trim();
          emit({ type: 'progress', percent: Number(pct[1]), text });
        } else if (/verifying|writing manifest|success/i.test(line)) {
          emit({ type: 'log', text: line.trim() });
        }
      }
    };

    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('exit', (code) => {
      if (code === 0) {
        emit({ type: 'progress', percent: 100, text: '完成' });
        emit({ type: 'step', id: 'model', status: 'done', text: '模型已就绪' });
        resolve(true);
      } else {
        emit({ type: 'step', id: 'model', status: 'error', text: '下载未完成，可重新运行继续' });
        resolve(false);
      }
    });
    child.on('error', (e) => {
      emit({ type: 'step', id: 'model', status: 'error', text: String(e.message) });
      resolve(false);
    });
  });
}

function stepDsh(opts, emit) {
  const { root } = opts;
  emit({ type: 'step', id: 'dsh', status: 'running', text: '安装 DeepSeek Harness' });

  const dshDir = path.join(root, 'dsh-runtime');
  const bin = path.join(dshDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

  if (fs.existsSync(bin)) {
    emit({ type: 'log', text: 'DeepSeek Harness 已安装，跳过。' });
    emit({ type: 'step', id: 'dsh', status: 'skipped', text: '已安装' });
    return true;
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
    return false;
  }

  emit({ type: 'log', text: '正在安装（约 1–3 分钟，请勿关闭）...' });
  // 必须 --ignore-scripts：koffi 的 postinstall 缺 CMake 会失败并让 npm 回滚整个安装
  const r = spawnSync('npm',
    ['install', '@deepseek-ai/dsh', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: dshDir, encoding: 'utf8', shell: true });

  if (fs.existsSync(bin)) {
    emit({ type: 'step', id: 'dsh', status: 'done', text: 'DeepSeek Harness 已就绪' });
    return true;
  }
  const tail = ((r.stderr || '') + (r.stdout || '')).split(/\r?\n/).slice(-6).join('\n');
  if (/EACCES|EPERM|denied/i.test(tail)) {
    emit({ type: 'needs-elevation', reason: '安装 DeepSeek Harness 时权限不足', hint: '尝试以管理员身份重新运行。' });
  }
  emit({ type: 'log', text: tail });
  emit({ type: 'step', id: 'dsh', status: 'error', text: '安装失败' });
  return false;
}

function stepConfig(opts, emit) {
  const { root, model, contextWindow } = opts;
  emit({ type: 'step', id: 'config', status: 'running', text: '写入配置' });

  try {
    saveConfig(root, { model, modelDir: opts.modelDir, contextWindow });

    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const patch = (withDefault) => `# 由本地 AI 安装向导生成
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
            input: [text, image]
${withDefault ? `- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: ollama-local
    model: ${model}
` : ''}`;

    for (const p of ['web', 'headless']) {
      const dir = path.join(home, 'profiles', p);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), patch(p === 'headless'), 'utf8');
    }

    // 本地端点也需要一个非空 API key
    const cred = path.join(home, '.credentials.yaml');
    let text = fs.existsSync(cred) ? fs.readFileSync(cred, 'utf8') : 'version: 1\nrecords: {}\nrefs:\n';
    if (!/OLLAMA_API_KEY/.test(text)) {
      if (!/^refs:/m.test(text)) text += '\nrefs:\n';
      text = text.replace(/^refs:\s*$/m, 'refs:\n  OLLAMA_API_KEY: ollama');
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
  if (!stepDsh(o, emit)) return emit({ type: 'error', text: 'DeepSeek Harness 安装失败' });
  if (!stepConfig(o, emit)) return emit({ type: 'error', text: '配置写入失败' });
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
