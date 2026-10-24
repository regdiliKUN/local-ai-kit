/**
 * 模型目录空间分析。
 *
 * 用户问「我的硬盘是不是被模型占满了」，光看一个总数没用 ——
 * 他真正想知道的是：哪个模型最占地方？有没有下了一半没下完的残留？
 * 有没有同一个模型存在多份？
 *
 * Ollama 的目录结构：
 *   blobs/sha256-<digest>                        真正的数据（按内容去重）
 *   manifests/registry.ollama.ai/<ns>/<name>/<tag> 清单，写着它引用了哪些 blob
 *
 * 所以「某个模型占多大」= 它的清单里列出的 blob 大小之和。
 * 多个模型可能共用同一个 blob（尤其是基础模型和微调模型），要按 digest 去重。
 */

import fs from 'node:fs';
import path from 'node:path';

const GB = 1073741824;

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** 递归列出目录下的所有文件（带大小） */
function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out, depth + 1);
    } else if (entry.isFile()) {
      try {
        const st = fs.statSync(full);
        out.push({ path: full, size: st.size, mtime: st.mtimeMs });
      } catch { /* 扫到一半文件被删了，跳过 */ }
    }
  }
  return out;
}

/**
 * 读一个 manifest，算出它引用了哪些 blob、各多大。
 *
 * 注意两件事：
 *   1. manifest 里的 digest 写成 `sha256:<hex>`，blob 文件名却是 `sha256-<hex>`，
 *      要统一成后者才能对得上。
 *   2. 除了 layers，manifest 还有一个 config（模型的元数据），它也是占空间的 blob，
 *      算体积时不能漏。
 *
 * 解析失败返回空数组（不猜、不报错，这个文件不该影响整体分析）。
 */
export function readManifest(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const json = JSON.parse(raw);
    const out = [];
    if (json.config && typeof json.config.digest === 'string') {
      out.push({
        digest: normalizeDigest(json.config.digest),
        size: Number(json.config.size) || 0,
        mediaType: json.config.mediaType || 'config',
      });
    }
    const layers = Array.isArray(json.layers) ? json.layers : [];
    for (const l of layers) {
      if (!l || typeof l.digest !== 'string') continue;
      out.push({
        digest: normalizeDigest(l.digest),
        size: Number(l.size) || 0,
        mediaType: l.mediaType || '',
      });
    }
    return out;
  } catch { return []; }
}

/** `sha256:abc` → `sha256-abc`（统一成 blob 文件名的写法） */
export function normalizeDigest(digest) {
  return String(digest || '').replace(/^sha256:/, 'sha256-');
}

/**
 * 分析模型目录。
 *
 * @param {string} dir 模型目录（通常是 <盘>\ollama\models）
 * @returns {{
 *   dir: string, exists: boolean, totalGB: number,
 *   models: Array<{name:string,sizeGB:number,blobs:number,modified:string|null}>,
 *   sharedGB: number, orphanGB: number, blobCount: number,
 *   top: Array<{name:string,sizeGB:number}>
 * }}
 */
export function analyzeModelDir(dir) {
  const result = {
    dir: dir || '',
    exists: false,
    totalGB: 0,
    models: [],
    sharedGB: 0,
    orphanGB: 0,
    blobCount: 0,
    top: [],
  };
  if (!dir || !fs.existsSync(dir)) return result;
  result.exists = true;

  /* ---- blobs：实际数据 ---- */
  const blobDir = path.join(dir, 'blobs');
  const blobSizes = new Map();     // digest -> size
  let blobTotal = 0;
  if (fs.existsSync(blobDir)) {
    for (const file of walk(blobDir)) {
      blobTotal += file.size;
      // blob 文件名就是完整的 digest（sha256-<hex>），和 manifest 里 layers[].digest 对得上
      const digest = path.basename(file.path);
      blobSizes.set(digest, file.size);
    }
  }
  result.blobCount = blobSizes.size;
  result.totalGB = round2(blobTotal / GB);

  /* ---- manifests：模型清单 ---- */
  const manifestRoot = path.join(dir, 'manifests');
  const used = new Set();
  const models = [];
  if (fs.existsSync(manifestRoot)) {
    for (const file of walk(manifestRoot)) {
      const rel = path.relative(manifestRoot, file.path).split(path.sep);
      // 结构：<registry 主机>/<命名空间…>/<模型名>/<标签>
      // 例如 registry.ollama.ai/library/qwen3/32b → qwen3:32b
      if (rel.length < 3) continue;
      const tag = rel.pop();
      const name = rel.pop();
      rel.shift();                       // 去掉 registry 主机名
      if (rel[0] === 'library') rel.shift();   // library 是 Ollama 的隐式命名空间
      const namespace = rel.join('/');
      const label = namespace ? `${namespace}/${name}:${tag}` : `${name}:${tag}`;
      const layers = readManifest(file.path);
      const size = layers.reduce((n, l) => n + l.size, 0);
      for (const l of layers) used.add(l.digest);
      models.push({
        name: label,
        sizeGB: round2(size / GB),
        bytes: size,
        blobs: layers.length,
        modified: Number.isFinite(file.mtime) ? new Date(file.mtime).toISOString() : null,
      });
    }
  }
  models.sort((a, b) => b.bytes - a.bytes);
  result.models = models;
  result.top = models.slice(0, 8).map((m) => ({ name: m.name, sizeGB: m.sizeGB }));

  /* ---- 哪些 blob 没被任何 manifest 引用 = 残留（下载中断 / 删模型没删干净） ---- */
  let orphan = 0;
  let shared = 0;
  const refCount = new Map();
  // 统计每个 blob 被多少个模型引用
  for (const file of walk(manifestRoot)) {
    for (const l of readManifest(file.path)) {
      refCount.set(l.digest, (refCount.get(l.digest) || 0) + 1);
    }
  }
  for (const [digest, size] of blobSizes) {
    const count = refCount.get(digest) || 0;
    if (count === 0) orphan += size;
    else if (count > 1) shared += size * (count - 1);
  }
  result.orphanGB = round2(orphan / GB);
  result.sharedGB = round2(shared / GB);
  return result;
}

/**
 * 找出「没被任何 manifest 引用」的 blob（下载中断留下的碎片）。
 *
 * 只查不删 —— 删除是不可逆操作，交给界面上的「清理」按钮，
 * 并且删之前一定要把能释放多少空间说清楚。
 */
export function findOrphanBlobs(dir) {
  const result = { blobs: [], totalBytes: 0, totalGB: 0 };
  if (!dir || !fs.existsSync(dir)) return result;
  const blobDir = path.join(dir, 'blobs');
  const manifestRoot = path.join(dir, 'manifests');
  if (!fs.existsSync(blobDir)) return result;

  // 统计每个 digest 被多少个 manifest 引用
  const refCount = new Map();
  for (const file of walk(manifestRoot)) {
    for (const l of readManifest(file.path)) {
      refCount.set(l.digest, (refCount.get(l.digest) || 0) + 1);
    }
  }

  for (const file of walk(blobDir)) {
    const digest = path.basename(file.path);
    if ((refCount.get(digest) || 0) === 0) {
      result.blobs.push({ name: digest, bytes: file.size, path: file.path });
      result.totalBytes += file.size;
    }
  }
  result.totalGB = round2(result.totalBytes / GB);
  result.blobs.sort((a, b) => b.bytes - a.bytes);
  return result;
}

/**
 * 删除残留 blob。
 *
 * 安全措施：
 *   - 必须在模型目录的 blobs 子目录里（不能是任意路径）
 *   - 再次确认这个 blob 确实没被引用（防止删之前状态变了）
 *   - 逐个删，不用递归删目录
 *
 * @returns {{removed:number, freedBytes:number, freedGB:number, skipped:string[]}}
 */
export function cleanupOrphanBlobs(dir, { dryRun = true } = {}) {
  const out = { removed: 0, freedBytes: 0, freedGB: 0, skipped: [] };
  if (!dir || !fs.existsSync(dir)) return out;
  const blobDir = path.join(dir, 'blobs');
  const found = findOrphanBlobs(dir);
  if (!found.blobs.length) return out;

  // 删之前再统计一次引用情况，确认这批 blob 确实没人用
  const refCount = new Map();
  for (const file of walk(path.join(dir, 'manifests'))) {
    for (const l of readManifest(file.path)) {
      refCount.set(l.digest, (refCount.get(l.digest) || 0) + 1);
    }
  }

  for (const blob of found.blobs) {
    // 必须真的在 blobs 目录里（防止路径被绕出去）
    const full = path.resolve(blob.path);
    if (!full.startsWith(path.resolve(blobDir) + path.sep)) { out.skipped.push(blob.name); continue; }
    if ((refCount.get(blob.name) || 0) > 0) { out.skipped.push(blob.name); continue; }
    if (dryRun) { out.removed += 1; out.freedBytes += blob.bytes; continue; }
    try {
      fs.rmSync(full, { force: true });
      out.removed += 1;
      out.freedBytes += blob.bytes;
    } catch { out.skipped.push(blob.name); }
  }
  out.freedGB = round2(out.freedBytes / GB);
  return out;
}

/**
 * 扫描整台机器上所有可能的模型目录。
 * 用来回答「这台电脑上到底装了哪些模型、分别在哪个盘」。
 */
export function scanAllModelDirs(disks = [], extra = []) {
  const candidates = new Set();
  if (process.env.OLLAMA_MODELS) candidates.add(process.env.OLLAMA_MODELS);
  for (const d of disks) candidates.add(path.join(d.root, 'ollama', 'models'));
  for (const e of extra) if (e) candidates.add(e);

  const out = [];
  for (const dir of candidates) {
    const info = analyzeModelDir(dir);
    if (info.exists && (info.models.length || info.totalGB > 0)) out.push(info);
  }
  return out;
}
