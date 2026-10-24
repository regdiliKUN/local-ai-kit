/**
 * 抽取界面上的中文文案，生成翻译字典的骨架。
 *
 * 用法：
 *   node scripts/extract-i18n.mjs            # 打印统计
 *   node scripts/extract-i18n.mjs --json     # 导出 JSON（用来生成字典）
 *   node scripts/extract-i18n.mjs --missing  # 列出字典里缺的条目
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 要扫描的界面文件 */
const FILES = ['ui/console.html', 'ui/strata.html', 'ui/app.js', 'ui/console.js', 'ui/strata.js'];

/** 已有字典（从 i18n.js 里读出来） */
function loadDict() {
  const file = path.join(KIT, 'ui', 'i18n.js');
  if (!fs.existsSync(file)) return {};
  const src = fs.readFileSync(file, 'utf8');
  const m = src.match(/(?:export )?const DICT = \{([\s\S]*?)\n\};/);
  if (!m) return {};
  const dict = {};
  const re = /^\s*'((?:[^'\\]|\\.)*)'\s*:\s*'((?:[^'\\]|\\.)*)'/gm;
  let g;
  while ((g = re.exec(m[1])) !== null) {
    // 源码里 \\\\ 表示一个反斜杠，取出来要还原
    dict[g[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\')] = g[2].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  }
  return dict;
}

/**
 * 从 HTML 里取叶子元素的完整文本。
 *
 * 只取「<p>整句话</p>」这种没有子标签的叶子元素 —— 这样拿到的是完整句子，
 * 不会像按文本节点切那样把一句话切成两半（那样翻译出来会前言不搭后语）。
 */
function htmlTexts(src) {
  const out = [];
  const body = src.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  const re = /<([a-zA-Z][\w-]*)(?:\s[^>]*)?>([^<>]+)<\/\1>/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const t = m[2].replace(/\s+/g, ' ').trim();
    if (/[一-鿿]/.test(t) && t.length >= 2 && t.length <= 120) out.push(t);
  }
  return out;
}

/** 从 JS 里取含中文的字符串字面量 */
function jsStrings(src) {
  const out = [];
  // 简单粗暴但可靠：按引号切段，再筛掉明显是代码的
  const parts = src.split(/['"`]/);
  for (const raw of parts) {
    const t = raw.replace(/\\n/g, ' ').replace(/\\t/g, ' ').replace(/\s+/g, ' ').trim();
    if (t.length < 2 || t.length > 90) continue;
    if (!/[一-鿿]/.test(t)) continue;
    // 像代码的不收
    if (/[{};]|=>|function\s|const\s|let\s|return\s|document\.|querySelector/.test(t)) continue;
    // 半个标签 / 半个属性 的也不要（说明切串切歪了）
    if (/[<>]/.test(t)) continue;
    if (t.includes('=') && !/＝/.test(t)) continue;
    // 以标点开头/结尾的多半是长句被切开的碎片，翻译它反而会翻错
    if (/^[，。、：；！？）】》”」·…]/.test(t)) continue;
    if (/[，。、：；！？（【《“「]$/.test(t)) continue;
    out.push(t);
  }
  return out;
}

const all = new Map();   // 文本 -> 来源文件集合
for (const rel of FILES) {
  const file = path.join(KIT, rel);
  if (!fs.existsSync(file)) continue;
  const src = fs.readFileSync(file, 'utf8');
  const texts = rel.endsWith('.html') ? htmlTexts(src) : jsStrings(src);
  for (const t of texts) {
    if (!all.has(t)) all.set(t, new Set());
    all.get(t).add(rel);
  }
}

const dict = loadDict();
const keys = [...all.keys()].sort();
const missing = keys.filter((k) => !(k in dict));

if (process.argv.includes('--json')) {
  const obj = {};
  for (const k of keys) obj[k] = dict[k] || '';
  fs.writeFileSync(path.join(KIT, 'i18n-template.json'), JSON.stringify(obj, null, 2), 'utf8');
  console.log(`已写出 i18n-template.json（${keys.length} 条，其中 ${missing.length} 条待翻译）`);
} else if (process.argv.includes('--missing')) {
  for (const k of missing) console.log(k);
  console.log(`\n共 ${keys.length} 条，待翻译 ${missing.length} 条`);
} else {
  console.log(`界面文案 ${keys.length} 条，已翻译 ${keys.length - missing.length} 条，待翻译 ${missing.length} 条`);
  for (const [file, n] of Object.entries(Object.fromEntries(
    FILES.map((f) => [f, [...all.values()].filter((s) => s.has(f)).length]),
  ))) console.log(`  ${file.padEnd(18)} ${n}`);
}
