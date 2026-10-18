/**
 * 版本检查与更新。
 *
 * 控制台「版本与更新」那张卡片背后就是这一套：
 *
 *   checkUpdates()  只读：查当前版本 / 查远端最新版本 / 判断配置要不要重新同步
 *   applyUpdates()  只写：同步配置、升级 dsh 运行时，失败尽量回滚
 *
 * 能自动更新的只有两样：
 *   - dsh 运行时（npm 包，装在 dsh-runtime 里，`npm i` 就能升）
 *   - dsh 配置（本部署包生成的那几行，定点合并 + 备份，不动用户自己加的 provider）
 *
 * 不能自动更新的两样（只提示、给链接）：
 *   - 部署包本体：它是一个文件夹，得重新下载新版再跑向导，不能自己覆盖自己
 *   - Ollama 运行时：升级要走官方安装包 / UAC，静默替换风险太大
 *
 * 设计约束：
 *   - 所有远端访问都可注入（fetchJson），测试里不联网
 *   - 所有写操作前先备份，且只碰本部署包自己写的那几个条目
 *   - 更新期间不杀进程、不停服务：dsh 在跑就提示「重启后生效」，由用户决定
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

import { KIT_VERSION, patchProfileText } from './install.mjs';
import { loadConfig } from './config.mjs';
import { modelCapabilities } from './ollama.mjs';

export const KIT_REPO = 'regdiliKUN/local-ai-kit';
export const DSH_PACKAGE = '@deepseek-ai/dsh';
export const OLLAMA_REPO = 'ollama/ollama';

const PROFILE_NAMES = ['web', 'headless'];

/* ------------------------------------------------------------ 版本号比较 */

/** 去掉前缀 v / 空白，只留 x.y.z[-pre] */
export function normalizeVersion(v) {
  const m = String(v == null ? '' : v).trim().match(/^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return m ? m[1] : '';
}

/**
 * 比较两个版本号：a>b 返回 1，a<b 返回 -1，相等 0。
 * 预发布版（0.2.0-rc.2）小于同号正式版（0.2.0），与 semver 一致。
 */
export function compareVersions(a, b) {
  const pa = normalizeVersion(a).split('-');
  const pb = normalizeVersion(b).split('-');
  if (!pa[0] || !pb[0]) return 0;

  const na = pa[0].split('.').map(Number);
  const nb = pb[0].split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((na[i] || 0) > (nb[i] || 0)) return 1;
    if ((na[i] || 0) < (nb[i] || 0)) return -1;
  }

  const preA = pa[1] || '';
  const preB = pb[1] || '';
  if (!preA && !preB) return 0;
  if (!preA) return 1;   // 正式版 > 预发布
  if (!preB) return -1;
  if (preA === preB) return 0;

  const sa = preA.split('.');
  const sb = preB.split('.');
  for (let i = 0; i < Math.max(sa.length, sb.length); i += 1) {
    const x = sa[i];
    const y = sb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) > Number(y) ? 1 : -1;
    } else if (nx !== ny) {
      return nx ? -1 : 1;  // 数字标识 < 字母标识
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

/* ---------------------------------------------------------------- 远端查询 */

const UA = `local-ai-kit/${KIT_VERSION} (update-check)`;

/** 默认的 JSON 抓取；任何失败都转成 { error }，绝不抛给上层 */
export async function fetchJson(url, timeoutMs = 6000) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    return { data: await r.json() };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

/* ------------------------------------------------------------ 本机版本读取 */

/** dsh 运行时版本：直接读 dsh-runtime 里那个 package.json，比问 npm 靠谱 */
export function readDshVersion(root) {
  const p = path.join(root, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')).version || null;
  } catch {
    return null;
  }
}

/** Ollama 版本：`ollama --version` 的输出形如 `ollama version is 0.9.0` */
export function readOllamaVersion(exe = 'ollama') {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(exe, ['--version'], { windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve(null));
    child.on('exit', () => {
      const m = out.match(/(\d+\.\d+\.\d+)/);
      resolve(m ? m[1] : null);
    });
  });
}

/* ------------------------------------------------------------------ 配置 */

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

export function profilePath(profile) {
  return path.join(dshHome(), 'profiles', profile, 'cordis.patch.yml');
}

/** 安装目录里脚本是平铺的，仓库里在 scripts/ 下，两种都试 */
export function readPresetText(root) {
  for (const p of [
    path.join(root, 'preset-standard.patch.yml'),
    path.join(root, 'scripts', 'preset-standard.patch.yml'),
  ]) {
    try { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); } catch { /* 试下一个 */ }
  }
  return null;
}

/** 从现有配置里推断 provider 声明的输入类型，推断不出来就按纯文本 */
function detectInput(prevText) {
  const m = String(prevText || '').match(/^\s*input:\s*(\[[^\]]*\])/m);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '[text]';
}

/**
 * 算出某个 profile 应有的配置文本，并与磁盘上的现状比对。
 * @returns {{ profile: string, file: string, current: string, expected: string, needsSync: boolean, error?: string }}
 */
export function planProfileSync({ profile, root, model, contextWindow, presetText, input }) {
  const file = profilePath(profile);
  let current = '';
  try { current = fs.readFileSync(file, 'utf8'); } catch { /* 不存在 = 空 */ }

  if (!presetText) {
    return { profile, file, current, expected: current, needsSync: false, error: '找不到 preset-standard.patch.yml' };
  }
  try {
    const { text } = patchProfileText(current, {
      profile,
      model,
      contextWindow,
      input: input || detectInput(current),
      presetText,
    });
    // 比对前统一换行：老版本写过的文件可能是 CRLF，YAML 层面完全等价，
    // 不该因为行尾差异被判定为「需要同步」而反复重写。
    const norm = (s) => String(s).replace(/\r\n/g, '\n');
    return { profile, file, current, expected: text, needsSync: norm(text) !== norm(current) };
  } catch (e) {
    return { profile, file, current, expected: current, needsSync: false, error: String((e && e.message) || e) };
  }
}

/* ------------------------------------------------------------------ 检查 */

/**
 * 查一遍所有组件。
 *
 * @param {object} opts
 * @param {string} opts.root            安装目录
 * @param {string} [opts.kitVersion]    当前部署包版本，默认取 install.mjs 里的 KIT_VERSION
 * @param {object} [opts.cfg]           配置（model / contextWindow），默认读 配置.json
 * @param {Function} [opts.fetchJson]   远端抓取，测试可注入
 * @param {Function} [opts.readDsh]     读 dsh 版本，测试可注入
 * @param {Function} [opts.readOllama]  读 ollama 版本，测试可注入
 * @param {Function} [opts.capabilities] 读模型能力，测试可注入
 * @returns {Promise<{checkedAt:string, components:Array, updates:number, ok:boolean}>}
 */
export async function checkUpdates(opts = {}) {
  const root = opts.root;
  if (!root) throw new Error('缺少安装目录 root');
  const fetchJsonFn = opts.fetchJson || fetchJson;
  const readDsh = opts.readDsh || readDshVersion;
  const readOllama = opts.readOllama || readOllamaVersion;
  const kitVersion = normalizeVersion(opts.kitVersion || KIT_VERSION);
  const cfg = opts.cfg || loadConfig(root) || {};

  const components = [];

  /* 1) 部署包本体 */
  {
    const r = await fetchJsonFn(`https://api.github.com/repos/${KIT_REPO}/releases/latest`);
    const latest = r.data ? normalizeVersion(r.data.tag_name || r.data.name) : '';
    components.push({
      id: 'kit',
      name: '部署包（本地 AI 工具集）',
      current: kitVersion,
      latest: latest || '',
      auto: false,
      status: !latest ? 'unknown' : compareVersions(latest, kitVersion) > 0 ? 'outdated' : 'ok',
      reason: r.error || (!latest ? '没有可用的 release 信息' : ''),
      hint: '新版是一个完整文件夹：下载后解压，再双击「① 双击这里开始安装.cmd」覆盖安装（模型不会重下）',
      url: `https://github.com/${KIT_REPO}/releases/latest`,
    });
  }

  /* 2) dsh 运行时 */
  {
    const current = readDsh(root);
    const r = await fetchJsonFn(`https://registry.npmjs.org/${DSH_PACKAGE.replace('/', '%2F')}/latest`);
    const latest = r.data ? normalizeVersion(r.data.version) : '';
    components.push({
      id: 'dsh',
      name: 'DeepSeek Harness 运行时',
      current: current || '未安装',
      latest: latest || '',
      auto: true,
      status: !current ? 'unknown'
        : !latest ? 'unknown'
          : compareVersions(latest, current) > 0 ? 'outdated' : 'ok',
      reason: r.error || (!current ? '安装目录里找不到 dsh-runtime' : ''),
      hint: '通过 npm 就地升级，升级后需要重启工作台才生效',
      url: `https://www.npmjs.com/package/${DSH_PACKAGE}`,
    });
  }

  /* 3) Ollama 运行时 */
  {
    const current = await readOllama();
    const r = await fetchJsonFn(`https://api.github.com/repos/${OLLAMA_REPO}/releases/latest`);
    const latest = r.data ? normalizeVersion(r.data.tag_name || r.data.name) : '';
    components.push({
      id: 'ollama',
      name: 'Ollama 推理引擎',
      current: current || '未检测到',
      latest: latest || '',
      auto: false,
      status: !current || !latest ? 'unknown'
        : compareVersions(latest, current) > 0 ? 'outdated' : 'ok',
      reason: r.error || (!current ? '没找到 ollama 命令，可能装在了非默认位置' : ''),
      hint: '推理引擎要装官方安装包才能升级，这里只提示版本，不会替你替换',
      url: 'https://ollama.com/download',
    });
  }

  /* 4) dsh 配置（本部署包写的那几行） */
  {
    const presetText = readPresetText(root);
    let input = detectInput('');
    try {
      const caps = opts.capabilities
        ? await opts.capabilities(cfg.model)
        : (cfg.model ? await modelCapabilities(cfg.model) : null);
      if (caps) input = caps.includes('vision') ? '[text, image]' : '[text]';
    } catch { /* 拿不到能力就沿用配置里的写法 */ }

    const plans = PROFILE_NAMES.map((profile) => planProfileSync({
      profile,
      root,
      model: cfg.model || '',
      contextWindow: cfg.contextWindow || 16384,
      presetText,
      input,
    }));
    const bad = plans.filter((p) => p.error);
    const dirty = plans.filter((p) => p.needsSync);
    components.push({
      id: 'config',
      name: 'dsh 配置（provider / 压缩参数）',
      current: dirty.length ? '待同步' : '已同步',
      latest: '已同步',
      auto: true,
      status: bad.length ? 'unknown' : dirty.length ? 'outdated' : 'ok',
      reason: bad.length ? bad[0].error : (dirty.length ? `${dirty.map((p) => p.profile).join('、')} 档需要重新同步` : ''),
      hint: '只改写本部署包自己写的那几个条目，你自己加的 provider / 插件原样保留（改动前会备份）',
      plans,
    });
  }

  const updates = components.filter((c) => c.status === 'outdated').length;
  return {
    checkedAt: new Date().toISOString(),
    components,
    updates,
    autoUpdates: components.filter((c) => c.status === 'outdated' && c.auto).length,
    ok: true,
  };
}

/* ------------------------------------------------------------------ 更新 */

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function backupFile(file) {
  if (!fs.existsSync(file)) return null;
  const bak = `${file}.${stamp()}.bak`;
  fs.copyFileSync(file, bak);
  // 只留最近 3 份，别把用户目录塞满
  try {
    const dir = path.dirname(file);
    const base = path.basename(file);
    const olds = fs.readdirSync(dir)
      .filter((n) => n.startsWith(`${base}.`) && n.endsWith('.bak'))
      .sort();
    for (const n of olds.slice(0, Math.max(0, olds.length - 3))) {
      try { fs.rmSync(path.join(dir, n), { force: true }); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return bak;
}

/** 默认的 npm 调用；stdout/stderr 逐行回调出去，方便前端看进度 */
export function runNpmInstall({ root, version, onLine }) {
  return new Promise((resolve, reject) => {
    const cwd = path.join(root, 'dsh-runtime');
    if (!fs.existsSync(cwd)) {
      reject(new Error(`找不到 dsh-runtime 目录：${cwd}`));
      return;
    }
    const args = ['i', `${DSH_PACKAGE}@${version}`, '--ignore-scripts', '--no-audit', '--no-fund'];
    const child = spawn('npm', args, { cwd, windowsHide: true, shell: process.platform === 'win32' });
    let err = '';
    child.stdout.on('data', (d) => String(d).split(/\r?\n/).forEach((l) => l && onLine && onLine(l)));
    child.stderr.on('data', (d) => {
      const s = String(d);
      err += s;
      s.split(/\r?\n/).forEach((l) => l && onLine && onLine(l));
    });
    child.on('error', (e) => reject(new Error(`调用 npm 失败：${e.message}`)));
    child.on('exit', (code) => {
      if (code === 0) resolve({ ok: true });
      else reject(new Error(`npm 退出码 ${code}${err ? `：${err.trim().split(/\r?\n/).slice(-1)[0]}` : ''}`));
    });
  });
}

/**
 * 执行更新。
 *
 * @param {object} opts
 * @param {object} opts.report         checkUpdates() 的结果
 * @param {string} opts.root
 * @param {Function} [opts.emit]       进度回调：{type:'step'|'log'|'progress'|'done'|'error', ...}
 * @param {Function} [opts.npmInstall] npm 安装实现，测试可注入
 * @param {boolean} [opts.dshRunning]  工作台是否在跑（只用于提示，不会去杀它）
 */
export async function applyUpdates(opts = {}) {
  const { report, root } = opts;
  const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
  const npmInstall = opts.npmInstall || runNpmInstall;

  if (!report || !Array.isArray(report.components)) throw new Error('缺少检查结果，请先检查更新');

  const updated = [];
  const failed = [];
  const skipped = [];

  const auto = report.components.filter((c) => c.status === 'outdated' && c.auto);
  const manual = report.components.filter((c) => c.status === 'outdated' && !c.auto);

  if (!auto.length) {
    emit({ type: 'log', text: manual.length ? '没有可自动更新的组件（其余需要手动更新）' : '所有组件都已是最新' });
    return { ok: true, updated, failed, skipped: manual.map((c) => ({ id: c.id, reason: '需要手动更新' })) };
  }

  emit({ type: 'progress', percent: 5 });
  let done = 0;
  const bump = (label) => {
    done += 1;
    emit({ type: 'progress', percent: Math.min(95, Math.round((done / auto.length) * 90) + 5), label });
  };

  /* ---- 配置同步 ---- */
  for (const c of auto.filter((x) => x.id === 'config')) {
    emit({ type: 'step', id: 'config', status: 'running', text: '同步 dsh 配置' });
    try {
      for (const plan of c.plans || []) {
        if (!plan.needsSync) {
          emit({ type: 'log', text: `${plan.profile} 档：已是最新，跳过` });
          continue;
        }
        const bak = backupFile(plan.file);
        fs.mkdirSync(path.dirname(plan.file), { recursive: true });
        fs.writeFileSync(plan.file, plan.expected, 'utf8');
        emit({ type: 'log', text: `${plan.profile} 档：已同步${bak ? `（备份 ${path.basename(bak)}）` : ''}` });
      }
      updated.push({ id: 'config', name: 'dsh 配置', from: '待同步', to: '已同步' });
      emit({ type: 'step', id: 'config', status: 'done', text: '配置已同步' });
      bump('配置');
    } catch (e) {
      const reason = String((e && e.message) || e);
      failed.push({ id: 'config', reason });
      emit({ type: 'step', id: 'config', status: 'error', text: reason });
    }
  }

  /* ---- dsh 运行时 ---- */
  for (const c of auto.filter((x) => x.id === 'dsh')) {
    emit({ type: 'step', id: 'dsh', status: 'running', text: `升级 dsh ${c.current} → ${c.latest}` });
    const before = readDshVersion(root);
    try {
      await npmInstall({
        root,
        version: c.latest,
        onLine: (line) => emit({ type: 'log', text: line }),
      });
      const after = readDshVersion(root);
      if (!after) throw new Error('升级后读不到 dsh 版本，可能没装成功');
      if (compareVersions(after, c.latest) < 0) {
        throw new Error(`升级后版本仍是 ${after}，未达到 ${c.latest}`);
      }
      updated.push({ id: 'dsh', name: 'DeepSeek Harness 运行时', from: before || c.current, to: after });
      emit({ type: 'step', id: 'dsh', status: 'done', text: `dsh 已升级到 ${after}` });
      bump('dsh');
    } catch (e) {
      const reason = String((e && e.message) || e);
      // 回滚：装回原版本，避免留下半损坏的 node_modules
      if (before) {
        emit({ type: 'log', text: `升级失败，正在回滚到 ${before} ...` });
        try {
          await npmInstall({ root, version: before, onLine: (line) => emit({ type: 'log', text: line }) });
          emit({ type: 'log', text: `已回滚到 ${before}` });
        } catch (e2) {
          emit({ type: 'log', text: `回滚也失败了：${String((e2 && e2.message) || e2)}` });
        }
      }
      failed.push({ id: 'dsh', reason });
      emit({ type: 'step', id: 'dsh', status: 'error', text: reason });
    }
  }

  for (const c of manual) {
    skipped.push({ id: c.id, name: c.name, reason: '需要手动更新', url: c.url });
  }

  emit({ type: 'progress', percent: 100 });

  const ok = failed.length === 0;
  const summary = {
    ok,
    updated,
    failed,
    skipped,
    restartHint: updated.some((u) => u.id === 'dsh'),
  };
  if (ok) emit({ type: 'done', action: 'update', result: summary });
  else emit({ type: 'error', text: failed.map((f) => `${f.id}: ${f.reason}`).join('；'), result: summary });
  return summary;
}

/* ------------------------------------------------------------ 单飞（防重入） */

/**
 * 更新锁：正在更新时第二次调用直接抛 BUSY，避免用户连点导致两路 npm 同时跑。
 */
export function createUpdateLock() {
  let busy = false;
  return {
    get busy() { return busy; },
    async run(fn) {
      if (busy) {
        const e = new Error('更新已在进行中，请等它跑完');
        e.code = 'BUSY';
        throw e;
      }
      busy = true;
      try { return await fn(); } finally { busy = false; }
    },
  };
}
