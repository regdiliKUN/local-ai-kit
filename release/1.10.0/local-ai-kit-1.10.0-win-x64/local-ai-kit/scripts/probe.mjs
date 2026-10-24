/**
 * 出字快测（quick probe）
 *
 * 「试一下」只把结果临时显示在提示里，切走就忘了。这个模块把每次快测的结果
 * 持久化下来，多个模型就能横向对比：谁出字快、谁根本跑不动。
 *
 * 和 v1.8.0 的「模型实测排行」是两回事：
 *   - 实测排行：21 道题逐模型跑分，量大、慢、看能力。
 *   - 出字快测：每个模型发一句最短的话，秒级，只看「能不能出字 + 首字多快」。
 *
 * 存储：<root>/出字快测.json —— 运行期生成，已进 .gitignore。
 */

import fs from 'node:fs';
import path from 'node:path';

const FILE = '出字快测.json';

function fileOf(root) {
  return path.join(root, FILE);
}

/** 读出全部快测记录：{ model: { ok, firstMs, totalMs, chars, at } } */
export function readProbes(root) {
  try {
    const j = JSON.parse(fs.readFileSync(fileOf(root), 'utf-8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

/**
 * 记录一次快测结果。
 * @param {string} root 控制台根目录
 * @param {string} model 模型名
 * @param {{ok:boolean, firstMs:number, totalMs:number, chars:number}} rec
 */
export function recordProbe(root, model, rec) {
  if (!model || typeof model !== 'string') return;
  const all = readProbes(root);
  all[model] = {
    ok: !!rec.ok,
    firstMs: Math.max(0, Number(rec.firstMs) || 0),
    totalMs: Math.max(0, Number(rec.totalMs) || 0),
    chars: Math.max(0, Number(rec.chars) || 0),
    at: Date.now(),
  };
  try {
    fs.writeFileSync(fileOf(root), JSON.stringify(all, null, 2), 'utf-8');
  } catch {
    /* 写不进不该崩界面 */
  }
}

/** 忘掉某个模型的快测记录（模型被删时清理） */
export function forgetProbe(root, model) {
  const all = readProbes(root);
  if (model in all) {
    delete all[model];
    try {
      fs.writeFileSync(fileOf(root), JSON.stringify(all, null, 2), 'utf-8');
    } catch { /* 忽略 */ }
  }
}

/** 清空全部快测记录 */
export function clearProbes(root) {
  try {
    fs.writeFileSync(fileOf(root), '{}', 'utf-8');
  } catch { /* 忽略 */ }
}
