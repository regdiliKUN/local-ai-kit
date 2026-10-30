/**
 * 模型使用记录。
 *
 * 为什么需要：模型动辄几个 GB，装十几个就是上百 GB。用户想知道
 * 「哪些是我真在用的、哪些装完就没碰过」，光看安装列表看不出来。
 *
 * 和 history.mjs 的区别：那个是内存环形缓冲，关掉控制台就没了；
 * 这个要跨会话保留，所以落盘到部署目录。
 */

import fs from 'node:fs';
import path from 'node:path';

const FILE = '使用记录.json';
const MAX_MODELS = 200;

function filePath(root) {
  return path.join(root, FILE);
}

/** 读出来，坏文件当空的处理——不值得因为记录文件坏了就让控制台打不开 */
export function readUsage(root) {
  try {
    const raw = fs.readFileSync(filePath(root), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !data.models) return { version: 1, models: {} };
    return { version: 1, models: data.models };
  } catch {
    return { version: 1, models: {} };
  }
}

function write(root, data) {
  const file = filePath(root);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(temp, file);
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * 记一次使用。
 * @param {string} root 部署目录
 * @param {string} model 模型名（带 tag，例如 qwen2.5:7b）
 * @param {'chat'|'bench'|'pull'} kind 用在哪
 */
export function recordUse(root, model, kind = 'chat') {
  const name = String(model || '').trim();
  if (!name) return null;
  const data = readUsage(root);
  const now = new Date().toISOString();
  const cur = data.models[name] || { first: now, last: now, count: 0, kinds: {} };
  cur.last = now;
  cur.count = (cur.count || 0) + 1;
  cur.kinds = cur.kinds || {};
  cur.kinds[kind] = (cur.kinds[kind] || 0) + 1;
  data.models[name] = cur;

  // 只留最近用过的 N 个，避免文件无限增长
  const names = Object.keys(data.models);
  if (names.length > MAX_MODELS) {
    names
      .sort((a, b) => String(data.models[a].last).localeCompare(String(data.models[b].last)))
      .slice(0, names.length - MAX_MODELS)
      .forEach((n) => { delete data.models[n]; });
  }

  write(root, data);
  return cur;
}

/**
 * 把使用记录和已装模型对起来。
 *
 * 返回每一行的「多久没用了」，并且标出从未用过的——那批最该被考虑清理。
 *
 * @param {string} root 部署目录
 * @param {string[]} installed 已装模型名列表
 * @param {number} staleDays 超过多少天算「闲置」
 */
export function usageReport(root, installed, staleDays = 30) {
  const data = readUsage(root);
  const now = Date.now();
  const rows = (installed || []).map((name) => {
    const rec = data.models[name];
    if (!rec) {
      return { name, last: null, count: 0, kinds: {}, daysAgo: null, never: true, stale: true };
    }
    const t = Date.parse(rec.last);
    const daysAgo = Number.isFinite(t) ? Math.floor((now - t) / 86400000) : null;
    return {
      name,
      last: rec.last,
      count: rec.count || 0,
      kinds: rec.kinds || {},
      daysAgo,
      never: false,
      stale: daysAgo == null ? false : daysAgo >= staleDays,
    };
  });

  // 记录里出现过但已经不装的模型，顺手报出来（用户可能以为还在）
  const installedSet = new Set(installed || []);
  const removed = Object.keys(data.models).filter((n) => !installedSet.has(n));

  return {
    rows,
    staleDays,
    neverUsed: rows.filter((r) => r.never).map((r) => r.name),
    stale: rows.filter((r) => r.stale).map((r) => r.name),
    removed,
    totalTracked: Object.keys(data.models).length,
  };
}

/** 清掉某个模型的记录（删模型时一起清，免得以后重装被当成「用过」） */
export function forgetModel(root, model) {
  const data = readUsage(root);
  if (data.models[model]) {
    delete data.models[model];
    write(root, data);
    return true;
  }
  return false;
}
