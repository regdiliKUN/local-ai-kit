/**
 * 极简 YAML 定点合并工具（只处理「按缩进分块」这一件事，不解析完整 YAML）。
 *
 * 为什么需要它：
 *   dsh 的配置是 `~/.dsh/profiles/<档>/cordis.patch.yml`，用户会自己在里面加
 *   云端 provider、改插件配置。安装向导只应该动自己那几行（ollama-local、
 *   preset-standard、compaction-basic、agent-default-model），**不能整份覆盖**，
 *   否则用户手写的内容会被无声抹掉。
 *
 * 这里的原则是「够用就好」：不追求解析 YAML，只按缩进找出某个条目的起止行，
 * 然后整块替换。找不到就返回 null，由调用方决定是插入还是回退。
 */

/** 统一换行后切行 */
export function toLines(text) {
  return String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
}

export function indentOf(line) {
  const m = line.match(/^ */);
  return m ? m[0].length : 0;
}

export function isBlank(line) {
  return line.trim() === '';
}

/** 把整段文本按 n 个空格缩进（空行保持为空） */
export function indentText(text, n) {
  const pad = ' '.repeat(n);
  return toLines(text).map((l) => (isBlank(l) ? '' : pad + l)).join('\n');
}

/**
 * 从一个块的起始行往后找到块的结束行（不含）。
 *
 * 规则：块内的行缩进必须 > 起始行缩进；遇到第一个缩进 <= 起始行缩进的非空行就结束。
 * 空行只有在「后面还有更深缩进的内容」时才算块内，否则视为块与块之间的分隔。
 */
export function blockEnd(lines, start) {
  const base = indentOf(lines[start]);
  let i = start + 1;
  while (i < lines.length) {
    if (isBlank(lines[i])) {
      let k = i;
      while (k < lines.length && isBlank(lines[k])) k++;
      if (k >= lines.length) break;
      if (indentOf(lines[k]) <= base) break;
      i = k;
      continue;
    }
    if (indentOf(lines[i]) <= base) break;
    i++;
  }
  return i;
}

function re(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------ 序列条目 */

/** 找到 `- id: <id>` 那一行（缩进任意），返回行号或 -1 */
export function findSeqItem(lines, id, { from = 0, to = lines.length } = {}) {
  const reId = new RegExp(`^\\s*- id:\\s*['"]?${re(id)}['"]?\\s*$`);
  for (let i = from; i < to; i++) if (reId.test(lines[i])) return i;
  return -1;
}

/** 某个 `- id: <id>` 条目的 [起, 止) 行号范围；不存在返回 null */
export function seqItemRange(lines, id) {
  const i = findSeqItem(lines, id);
  return i < 0 ? null : [i, blockEnd(lines, i)];
}

/**
 * 替换（或按需在文件末尾插入）一个 `- id: <id>` 序列条目。
 * @returns {string|null} 新文本；没找到且 allowAppend=false 时返回 null
 */
export function spliceSeqItem(text, id, blockText, { allowAppend = true } = {}) {
  const lines = toLines(text);
  const i = findSeqItem(lines, id);
  if (i < 0) {
    if (!allowAppend) return null;
    const tail = lines.slice();
    while (tail.length && isBlank(tail[tail.length - 1])) tail.pop();
    return [...tail, ...toLines(indentText(blockText, 0))].join('\n') + '\n';
  }
  const end = blockEnd(lines, i);
  const ind = indentOf(lines[i]);
  const out = [...lines.slice(0, i), ...toLines(indentText(blockText, ind)), ...lines.slice(end)];
  return out.join('\n');
}

/* ------------------------------------------------------------ 映射键 */

/**
 * 在 [from, to) 行范围内找到 `KEY:` 那一行，返回行号或 -1。
 * 只匹配「恰好等于 key」的行，避免把 `ollama-local-x:` 误当成 `ollama-local:`。
 */
export function findMapKey(lines, key, { from = 0, to = lines.length } = {}) {
  const reKey = new RegExp(`^\\s*${re(key)}\\s*:`);
  for (let i = from; i < to; i++) if (reKey.test(lines[i])) return i;
  return -1;
}

/**
 * 替换一个映射键块（如 `providers:` 下的 `ollama-local:`）。
 * @returns {string|null} 新文本；没找到返回 null
 */
export function spliceMapKey(text, key, blockText, { from = 0, to = Infinity } = {}) {
  const lines = toLines(text);
  const i = findMapKey(lines, key, { from, to: Math.min(to, lines.length) });
  if (i < 0) return null;
  const end = blockEnd(lines, i);
  const ind = indentOf(lines[i]);
  const out = [...lines.slice(0, i), ...toLines(indentText(blockText, ind)), ...lines.slice(end)];
  return out.join('\n');
}

/**
 * 在 `parentKey:` 之下插入一个映射键块（parent 下第一行处）。
 * childIndent 不传时自动取「parent 缩进 + 2」。
 * @returns {string|null} 新文本；没找到 parent 返回 null
 */
export function insertUnderMapKey(text, parentKey, blockText, { childIndent = null, from = 0, to = Infinity } = {}) {
  const lines = toLines(text);
  const p = findMapKey(lines, parentKey, { from, to: Math.min(to, lines.length) });
  if (p < 0) return null;
  const ind = childIndent == null ? indentOf(lines[p]) + 2 : childIndent;
  const at = p + 1;
  const out = [...lines.slice(0, at), ...toLines(indentText(blockText, ind)), ...lines.slice(at)];
  return out.join('\n');
}

/** 文本里是否出现某个 `- id: <id>` 条目 */
export function hasSeqItem(text, id) {
  return findSeqItem(toLines(text), id) >= 0;
}
