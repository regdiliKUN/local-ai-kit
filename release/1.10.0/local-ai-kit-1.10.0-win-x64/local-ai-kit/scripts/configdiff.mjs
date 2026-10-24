/**
 * 配置差异。
 *
 * 检查点（.bak）原本只能「回滚到这里」——用户看不到回滚会改掉什么，
 * 只能凭时间戳猜。这个模块把两份配置摊平成「键 → 值」再逐项对比。
 */

/** 把嵌套对象摊平成 { 'a.b.c': value }，数组当成整体比较 */
export function flatten(obj, prefix = '', out = {}) {
  if (obj === null || obj === undefined) {
    if (prefix) out[prefix] = obj;
    return out;
  }
  if (Array.isArray(obj)) {
    if (prefix) out[prefix] = obj;
    return out;
  }
  if (typeof obj !== 'object') {
    if (prefix) out[prefix] = obj;
    return out;
  }
  const keys = Object.keys(obj);
  if (!keys.length) {
    if (prefix) out[prefix] = {};
    return out;
  }
  for (const k of keys) flatten(obj[k], prefix ? `${prefix}.${k}` : k, out);
  return out;
}

function same(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  }
  return false;
}

/**
 * 对比两份配置。
 *
 * @param {object} before 旧配置（检查点）
 * @param {object} after  新配置（当前）
 * @returns {{changed: {key,from,to}[], added: {key,to}[], removed: {key,from}[], same: number}}
 */
export function diffConfig(before, after) {
  const a = flatten(before || {});
  const b = flatten(after || {});
  const changed = [];
  const added = [];
  const removed = [];
  let sameCount = 0;

  for (const key of Object.keys(b)) {
    if (!(key in a)) { added.push({ key, to: b[key] }); continue; }
    if (same(a[key], b[key])) { sameCount++; continue; }
    changed.push({ key, from: a[key], to: b[key] });
  }
  for (const key of Object.keys(a)) {
    if (!(key in b)) removed.push({ key, from: a[key] });
  }

  const byKey = (x, y) => x.key.localeCompare(y.key);
  return {
    changed: changed.sort(byKey),
    added: added.sort(byKey),
    removed: removed.sort(byKey),
    same: sameCount,
    total: changed.length + added.length + removed.length,
  };
}

/** 人话版的键名，直接给界面用；不认识的键原样返回 */
const LABELS = {
  model: '当前模型',
  modelDir: '模型存放位置',
  contextWindow: '上下文长度',
  maxTokens: '输出上限',
  headroomTokens: '预留余量',
  backend: '部署方式',
  enginePort: '引擎端口',
  webPort: 'WebUI 端口',
  dshPort: 'dsh 端口',
  strataHome: 'Strata 目录',
  deploymentRoot: '部署目录',
  autoStart: '开机自启',
  lanShare: '局域网共享',
  theme: '主题',
  pythonExe: 'Python 路径',
  keepAlive: '保活时长',
};

export function labelOf(key) {
  const tail = String(key).split('.').pop();
  return LABELS[tail] || key;
}

/** 值转成可读文本：布尔变「开/关」，对象/数组折成 JSON 片段 */
export function textOf(v) {
  if (v === true) return '开';
  if (v === false) return '关';
  if (v === null || v === undefined) return '（空）';
  if (typeof v === 'object') {
    try {
      const s = JSON.stringify(v);
      return s.length > 60 ? `${s.slice(0, 57)}…` : s;
    } catch { return '（无法显示）'; }
  }
  const s = String(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}
