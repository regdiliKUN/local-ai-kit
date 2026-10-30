/**
 * 部署包的配置文件读写（存在安装目录下的 配置.json）。
 *
 * 配置文件是整套东西的「唯一真相」：模型、模型目录、上下文、端口都在里面。
 * 所以这里的原则是 —— 宁可慢一点，也不能把用户配置写坏。
 *
 *   1. 读：容忍 BOM、容忍单字段损坏，坏到读不了就回退到备份
 *   2. 写：先备份再落盘，落盘用「写临时文件 + 改名」，中途断电也不会留半个文件
 *   3. 备份：保留最近 3 份，带时间戳，出问题能拿回来
 */

import fs from 'node:fs';
import path from 'node:path';

const FILE = '配置.json';
const KEEP_BACKUPS = 3;

const DEFAULT_CONFIG = {
  model: '',
  modelDir: '',
  contextWindow: 8192,
};

/* ------------------------------------------------------------------ 读取 */

/** 去掉 UTF-8 BOM（Windows 记事本 / PowerShell 写出来的文件会带） */
function stripBom(text) {
  return text.replace(/^\uFEFF/, '');
}

/**
 * 校验配置对象：只保留认识的字段，并夹住数值范围。
 *
 * 不认识的字段**保留**（用户可能自己加了东西，比如 cloud provider 路径），
 * 但类型明显不对的会被丢掉，避免一个手滑写坏的字段把整个流程带崩。
 */
export function sanitizeConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ...DEFAULT_CONFIG };
  const out = { ...input };

  if (typeof out.model !== 'string') delete out.model;
  if (typeof out.modelDir !== 'string') delete out.modelDir;

  if (out.contextWindow !== undefined) {
    const n = Number(out.contextWindow);
    out.contextWindow = Number.isFinite(n)
      ? Math.min(262144, Math.max(2048, Math.round(n)))
      : DEFAULT_CONFIG.contextWindow;
  }

  for (const key of ['maxTokens', 'headroomTokens']) {
    if (out[key] === undefined || out[key] === null) { delete out[key]; continue; }
    const n = Number(out[key]);
    if (!Number.isFinite(n) || n <= 0) delete out[key];
    else out[key] = Math.round(n);
  }

  for (const key of ['thresholdRatio', 'retainRatio']) {
    if (out[key] === undefined || out[key] === null) { delete out[key]; continue; }
    const n = Number(out[key]);
    if (!Number.isFinite(n) || n <= 0 || n > 1) delete out[key];
    else out[key] = n;
  }

  for (const key of ['enginePort', 'webPort', 'dshPort']) {
    if (out[key] === undefined || out[key] === null) { delete out[key]; continue; }
    const n = Number(out[key]);
    if (!Number.isInteger(n) || n < 1 || n > 65535) delete out[key];
    else out[key] = n;
  }

  return out;
}

/** 列出这个目录里现存的备份（新 → 旧） */
export function listBackups(root) {
  const dir = path.join(root, FILE);
  try {
    return fs.readdirSync(root)
      .filter((name) => name.startsWith(`${FILE}.`) && name.endsWith('.bak'))
      .map((name) => ({ name, file: path.join(root, name), mtime: fs.statSync(path.join(root, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}

/**
 * 读配置。
 *
 * 主文件坏了（被截断 / 手滑写坏）就自动回退到最近一份备份，
 * 并把损坏的文件改名成 .broken 保存现场 —— 便于事后排查。
 */
export function loadConfig(root) {
  const file = path.join(root, FILE);
  let raw = null;
  let exists = false;
  try {
    raw = fs.readFileSync(file, 'utf8');
    exists = true;
  } catch {
    raw = null;
  }

  if (raw != null) {
    try {
      const parsed = JSON.parse(stripBom(raw));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return sanitizeConfig(parsed);
    } catch {
      // 落到下面的备份回退
    }
    try {
      const broken = `${file}.broken`;
      if (!fs.existsSync(broken)) fs.renameSync(file, broken);
    } catch { /* ignore */ }
    return recoverFromBackup(root);
  }

  // 文件压根不存在 = 还没配置过（比如全新安装），这时用旧备份「恢复」反而会
  // 凭空造出一份用户从没填过的配置。所以只在「文件存在但坏了」时才回退。
  return exists ? recoverFromBackup(root) : null;
}

/** 从最近一份备份里恢复（只在主文件损坏时调用） */
function recoverFromBackup(root) {
  for (const backup of listBackups(root)) {
    try {
      const parsed = JSON.parse(stripBom(fs.readFileSync(backup.file, 'utf8')));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return sanitizeConfig(parsed);
    } catch { /* 试下一份 */ }
  }
  return null;
}

/** 读配置并保证有默认值；拿不到就返回默认骨架 */
export function loadConfigSafe(root) {
  return loadConfig(root) || { ...DEFAULT_CONFIG };
}

/** 覆盖前先留一份，路径带时间戳 */
export function backupConfig(root) {
  const file = path.join(root, FILE);
  try {
    if (!fs.existsSync(file)) return null;
    const dst = `${file}.${Date.now()}.bak`;
    fs.copyFileSync(file, dst);
    pruneBackups(root);
    return dst;
  } catch { return null; }
}

/** 只保留最近 KEEP_BACKUPS 份备份 */
function pruneBackups(root) {
  const all = listBackups(root);
  for (const old of all.slice(KEEP_BACKUPS)) {
    try { fs.rmSync(old.file, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * 写配置：先备份 → 写临时文件 → 改名。
 *
 * 改名是同一分区内的原子操作，所以任何时刻磁盘上的 配置.json
 * 要么是旧的完整内容，要么是新的完整内容，不会是半截。
 */
export function saveConfig(root, cfg) {
  const file = path.join(root, FILE);
  const temp = `${file}.${process.pid}.tmp`;
  backupConfig(root);
  try {
    fs.writeFileSync(temp, JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
  return file;
}

/** 合并两个配置对象（后者覆盖前者），写盘前先备份 */
export function mergeConfig(root, patch) {
  const next = { ...loadConfigSafe(root), ...patch };
  saveConfig(root, next);
  return next;
}

export function deploymentRoot(here) {
  if (fs.existsSync(path.join(here, FILE))) return here;
  const parent = path.dirname(here);
  return path.basename(here) === 'scripts' ? parent : here;
}
