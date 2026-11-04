#!/usr/bin/env node
/**
 * dsh 预设自愈 —— 让本地模型的「上下文压缩」在 dsh 升级后仍然有效。
 *
 * 为什么需要它：
 *   压缩插件 compaction-basic 挂在 agent 预设内部（preset-standard / preset-cordis 的
 *   config.plugins 数组里）。dsh 的补丁机制只按 id 匹配根层级的行，或 group: true 的分组，
 *   进不到这个普通数组，所以调参只能「整段重述」预设。官方一升级，重述的那份就旧了。
 *
 * 这个脚本做两件事，都是幂等的：
 *   1. 把两个预设重述块里的 compaction-basic 参数校正回本机需要的值；
 *      并记录 dsh 版本，版本变了就提醒「官方预设可能新增了工具，需要人工核对」。
 *   2. 把压缩摘要的提示词换成中文版（原版强制输出英文工程笔记，中文对话会走样）。
 *      只在检测到英文原文时替换，已经中文就跳过。
 *
 * 用法：
 *   node scripts/dsh-preset-sync.mjs            # 校正
 *   node scripts/dsh-preset-sync.mjs --check    # 只检查，需要改动时退出码 1
 *   node scripts/dsh-preset-sync.mjs --quiet    # 启动器里调用，无输出
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = path.resolve(HERE, '..');

/** 本机压缩策略：窗口 49152 时，阈值落在 22118、逐字保留 12288 */
export const COMPACTION_POLICY = {
  thresholdRatio: '0.45',
  headroomTokens: '8192',
  retainRatio: '0.3',
  maxTokens: '6144',
};

const BEGIN = '# >>> dsh-preset-sync:begin';
const END = '# <<< dsh-preset-sync:end';

/** 中文摘要提示词。@@TAG@@ 会被还原成插件里的 <compacted-summary> 常量插值。 */
const ZH_INSTRUCTION = [
  '\t"你现在是这台 AI 编程助手的上下文压缩引擎。把上面的对话浓缩成一份结构化档案，让另一个模型看完就能无缝接手，不丢失任何关键信息。",',
  '\t"",',
  '\t"严格按下面的 Markdown 结构输出，小节一个都不能少、顺序不能变。用短横线要点，不要写大段散文。某节确实没有内容就写「（无）」，但绝不能删掉这一节。",',
  '\t"",',
  '\t"## 主要请求与意图",',
  '\t"- [用户最初和后来变化的目标；措辞本身有歧义或有约束力时，逐字引用原话]",',
  '\t"",',
  '\t"## 关键技术背景",',
  '\t"- [涉及的技术、框架、模式、约定]",',
  '\t"",',
  '\t"## 文件与代码",',
  '\t"- [精确路径：为什么重要、改了什么、关键片段]",',
  '\t"",',
  '\t"## 报错与修复",',
  '\t"- [报错原文：怎么定位、怎么解决；以及相关的用户反馈]",',
  '\t"",',
  '\t"## 待办",',
  '\t"- [用户明确要求但还没做完的事]",',
  '\t"",',
  '\t"## 当前进度",',
  '\t"- [生成这份档案的时刻，正在做什么]",',
  '\t"",',
  '\t"## 下一步",',
  '\t"- [紧接着要做的唯一动作；没有就写「（无）」]",',
  '\t"",',
  '\t"## 关键上下文",',
  '\t"- [决策及其理由、约束条件、用户偏好、未解决的问题、继续工作所需的数据]",',
  '\t"",',
  '\t"规则：",',
  '\t"- 用简体中文写，工程术语保持原文。文件路径、命令、错误字符串、标识符、数值、函数签名、代码片段必须原样保留，不得改写或翻译。",',
  '\t"- 用户的要求、纠正、否决要如实记录，尤其是他明确表达过的偏好。",',
  '\t"- 不要提到这次摘要请求，也不要提到上下文被压缩过。",',
  '\t"- 只输出档案正文：不要调用任何工具，不要做别的事。",',
  '\t`- 如果对话里已经有一份 ${@@TAG@@} 块，那是之前的档案：不要把旧内容照抄一遍，保留仍然成立的事实、丢掉过时的，把新信息并进同一份结构里。`',
].join('\n');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadPaths() {
  const cfgPath = path.join(KIT_ROOT, '配置.json');
  const cfg = fs.existsSync(cfgPath) ? readJson(cfgPath) : {};
  const dshDir = process.env.DSH_DIR || cfg.dshDir;
  const dshHome = process.env.DSH_HOME_DIR || cfg.dshHome;
  if (!dshDir || !dshHome) throw new Error('配置.json 里缺少 dshDir / dshHome');
  return {
    dshDir,
    dshHome,
    patchFile: path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml'),
    manifest: path.join(dshDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    compactionJs: path.join(dshDir, 'node_modules', '@deepseek-ai', 'dsh-compaction-basic', 'lib', 'index.js'),
  };
}

function dshVersion(manifest) {
  try {
    return readJson(manifest).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 在缩进为 indent 的位置写入 / 覆盖 compaction-basic 的 config 块 */
function applyCompactionConfig(lines, startIdx) {
  const base = lines[startIdx].match(/^\s*/)[0];
  const nameIndent = base + '  ';

  // 条目范围：下一条同层或更外层的 "- id:" 之前
  let entryEnd = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const indent = lines[i].match(/^\s*/)[0].length;
    if (lines[i].trim() && indent <= base.length) { entryEnd = i; break; }
  }

  let nameIdx = -1;
  let configIdx = -1;
  for (let i = startIdx + 1; i < entryEnd; i++) {
    if (nameIdx < 0 && lines[i].startsWith(nameIndent + 'name:')) nameIdx = i;
    if (configIdx < 0 && lines[i].startsWith(nameIndent + 'config:')) configIdx = i;
  }
  // 根层级那条只有 disabled 的同名条目：不碰
  if (nameIdx < 0) return false;

  const kv = Object.entries(COMPACTION_POLICY).map(([k, v]) => `${nameIndent}  ${k}: ${v}`);
  const anchor = configIdx >= 0 ? configIdx : nameIdx;

  if (configIdx < 0) {
    lines.splice(anchor + 1, 0, `${nameIndent}config:`, ...kv);
    return true;
  }

  // 已有 config 块：只改块内键，其它键（如 modelPolicies）原样保留
  let end = configIdx + 1;
  while (end < entryEnd) {
    const l = lines[end];
    if (!l.trim()) { end++; continue; }
    if (!l.startsWith(nameIndent + '  ')) break;
    end++;
  }
  const body = lines.slice(configIdx + 1, end);
  const seen = new Set();
  const kept = body.map((l) => {
    const m = l.match(/^\s+([A-Za-z][\w]*):/);
    if (m && COMPACTION_POLICY[m[1]] !== undefined) {
      seen.add(m[1]);
      return `${nameIndent}  ${m[1]}: ${COMPACTION_POLICY[m[1]]}`;
    }
    return l;
  });
  const added = Object.keys(COMPACTION_POLICY)
    .filter((k) => !seen.has(k))
    .map((k) => `${nameIndent}  ${k}: ${COMPACTION_POLICY[k]}`);
  const nextBody = [...added, ...kept];
  const changed = nextBody.join('\n') !== body.join('\n');
  lines.splice(configIdx + 1, end - configIdx - 1, ...nextBody);
  return changed;
}

function syncPatchFile(file, version, { dryRun }) {
  if (!fs.existsSync(file)) return { skipped: true, reason: `找不到 ${file}` };
  const original = fs.readFileSync(file, 'utf8');
  const lines = original.split(/\r?\n/);
  const notes = [];
  let touched = 0;

  for (let i = 0; i < lines.length; i++) {
    if (/^\s*- id: compaction-basic\s*$/.test(lines[i])) {
      if (applyCompactionConfig(lines, i)) touched++;
    }
  }

  // 版本标记：只在首次或版本变化时写入 / 提醒
  let text = lines.join('\n');
  const beginIdx = text.indexOf(BEGIN);
  const endIdx = text.indexOf(END);
  if (beginIdx >= 0 && endIdx > beginIdx) {
    const marker = text.slice(beginIdx, text.indexOf('\n', beginIdx));
    const recorded = (marker.match(/v(\S+)/) || [])[1];
    if (recorded && recorded !== version) {
      notes.push(`dsh 从 ${recorded} 升到 ${version}：官方预设可能新增/改名了工具，建议核对两个重述块的 plugins 列表`);
      text = text.replace(marker, `${BEGIN}  v${version}`);
    }
  } else {
    text = `${text.replace(/\s+$/, '')}\n\n${BEGIN}  v${version}\n# 由 local-ai-kit/scripts/dsh-preset-sync.mjs 维护：dsh 升级后自动校正压缩参数。\n${END}\n`;
    notes.push('已写入 dsh 版本标记，之后升级会被检测到');
  }

  const changed = text !== original;
  if (changed && !dryRun) {
    const backup = `${file}.bak-preset-sync`;
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, original);
    fs.writeFileSync(file, text);
  }
  return { changed, touched, notes, skipped: false };
}

function syncInstruction(file, { dryRun }) {
  if (!fs.existsSync(file)) return { skipped: true, reason: '找不到压缩插件' };
  const src = fs.readFileSync(file, 'utf8');
  if (src.includes('上下文压缩引擎')) return { changed: false, skipped: false };

  const start = src.indexOf('const COMPACTION_INSTRUCTION = [');
  const endMark = '].join("\\n");';
  const end = start < 0 ? -1 : src.indexOf(endMark, start);
  if (start < 0 || end < 0) {
    return { changed: false, skipped: true, reason: '插件结构已变，未找到摘要提示词（不影响压缩，只是摘要仍是英文）' };
  }

  const block = `const COMPACTION_INSTRUCTION = [\n${ZH_INSTRUCTION.replace('${@@TAG@@}', '${SUMMARY_OPEN_TAG}')}\n${endMark}`;
  const next = src.slice(0, start) + block + src.slice(end + endMark.length);
  if (!dryRun) {
    const backup = `${file}.bak-preset-sync`;
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, src);
    fs.writeFileSync(file, next);
  }
  return { changed: true, skipped: false };
}

export function syncDshPresets({ quiet = false, dryRun = false } = {}) {
  const p = loadPaths();
  const version = dshVersion(p.manifest);
  const patch = syncPatchFile(p.patchFile, version, { dryRun });
  const instr = syncInstruction(p.compactionJs, { dryRun });
  const messages = [];

  if (patch.skipped) messages.push(`⚠ ${patch.reason}`);
  else if (patch.touched) messages.push(`压缩参数已校正（${patch.touched} 个预设）`);
  if (instr.changed) messages.push('摘要提示词已切换为中文');
  if (instr.skipped && instr.reason) messages.push(`⚠ ${instr.reason}`);
  for (const n of patch.notes || []) messages.push(`· ${n}`);

  if (!quiet) for (const m of messages) console.log(`[dsh-sync] ${m}`);
  return { changed: Boolean(patch.changed || instr.changed), messages, version };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const quiet = argv.includes('--quiet');
  const dryRun = check || argv.includes('--dry-run');
  try {
    const r = syncDshPresets({ quiet, dryRun });
    if (check && r.changed) process.exitCode = 1;
  } catch (error) {
    if (!quiet) console.error(`[dsh-sync] 失败：${error.message}`);
    process.exitCode = 2;
  }
}
