/**
 * 本地持久化存储。
 *
 * 控制台需要存一些「跨进程、跨重启」的数据：
 *   - 体检 / 测速的历史（用来画趋势）
 *   - 试用页的对话（关了浏览器还想接着聊）
 *   - 自己攒的提示词模板
 *
 * 全部放在用户数据目录下的一个 JSON 文件里，原子写入，条数有上限。
 * 不进安装目录 —— 卸载时不用清理，也避免用户误删安装目录导致数据丢失。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = process.env.LOCAL_AI_DATA_DIR
  || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'LocalAI');

const FILE = path.join(DIR, 'store.json');

/** 各类型最多留多少条（多了文件会变得很臃肿） */
const LIMITS = {
  health: 60,
  bench: 60,
  chat: 20,
  templates: 50,
  notes: 100,
};

function ensureDir() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* ignore */ }
}

/**
 * 读整个存储。文件不存在或坏了都返回空骨架，不抛异常 ——
 * 「历史丢了」不该让控制台起不来。
 */
export function readStore() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch { return {}; }
}

/** 写整个存储：先写临时文件再改名，避免中途断电留半个文件 */
export function writeStore(store) {
  ensureDir();
  const temp = `${FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(store, null, 2), 'utf8');
    fs.renameSync(temp, FILE);
  } finally { try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ } }
  return store;
}

/** 读某一类数据 */
export function readList(kind) {
  const store = readStore();
  const list = store[kind];
  return Array.isArray(list) ? list : [];
}

/**
 * 往某一类里追加一条，超过上限就丢最旧的。
 * @param {string} kind
 * @param {object} item
 */
export function appendItem(kind, item) {
  const store = readStore();
  const list = Array.isArray(store[kind]) ? store[kind] : [];
  list.push(item);
  const limit = LIMITS[kind] || 50;
  while (list.length > limit) list.shift();
  store[kind] = list;
  writeStore(store);
  return item;
}

/** 覆盖某一类的全部内容 */
export function writeList(kind, list) {
  const store = readStore();
  const limit = LIMITS[kind] || 50;
  store[kind] = Array.isArray(list) ? list.slice(-limit) : [];
  writeStore(store);
  return store[kind];
}

/** 清空某一类 */
export function clearList(kind) {
  const store = readStore();
  store[kind] = [];
  writeStore(store);
  return [];
}

/** 存储文件在哪（界面上要告诉用户） */
export function storePath() {
  return FILE;
}
