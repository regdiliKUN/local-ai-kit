/**
 * release/ 里的校验清单必须和实际文件对得上。
 *
 * 这条清单是给人验证「下载到的包有没有坏」用的，它一旦和文件不一致，
 * 就比没有清单更糟 —— 别人按清单校验会全部失败，然后以为包坏了。
 *
 * 这个仓库在这上面栽过好几次：删掉的文件还留在清单里、改过的文件哈希没更新、
 * 加了 .gitignore 把文件挡在仓库外但清单里还算着它。所以这里把三条不变量钉住：
 *   1. 清单里每一条都能找到文件，且哈希一致
 *   2. release/ 下的文件（除清单自己）都登记在册
 *   3. 清单是 LF 换行（CRLF 会让 sha256sum -c 把路径读成带 \r 的）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const kit = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const releaseDir = path.join(kit, 'release');
const manifestPath = path.join(releaseDir, 'SHA256SUMS.txt');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

/** 清单可能不存在（还没做过发布），这时跳过而不是报错 */
function readManifest() {
  if (!fs.existsSync(manifestPath)) return null;
  const raw = fs.readFileSync(manifestPath, 'utf8');
  return {
    raw,
    entries: raw.split('\n').filter(Boolean).map((line) => {
      const m = /^([0-9a-f]{64})\s\s(.+)$/.exec(line);
      assert.ok(m, `清单里有格式不对的行：${line.slice(0, 80)}`);
      return { hash: m[1], file: m[2] };
    }),
  };
}

test('发布清单的每一条都和文件对得上', (t) => {
  const manifest = readManifest();
  if (!manifest) return t.skip('还没有 release/SHA256SUMS.txt');

  const bad = [];
  const missing = [];
  for (const { hash, file } of manifest.entries) {
    const full = path.join(kit, file);
    if (!fs.existsSync(full)) { missing.push(file); continue; }
    if (sha256(full) !== hash) bad.push(file);
  }
  assert.deepEqual(missing, [], `清单里这些文件已经不存在了：\n${missing.join('\n')}`);
  assert.deepEqual(bad, [], `这些文件改过但清单没更新：\n${bad.join('\n')}`);
});

test('release/ 下没有漏登记的文件', (t) => {
  const manifest = readManifest();
  if (!manifest) return t.skip('还没有 release/SHA256SUMS.txt');

  const listed = new Set(manifest.entries.map((e) => e.file));
  const extra = walk(releaseDir)
    .map((f) => path.relative(kit, f).split(path.sep).join('/'))
    .filter((f) => f !== 'release/SHA256SUMS.txt' && !listed.has(f));

  assert.deepEqual(extra, [], `这些文件在 release/ 里但没登记进清单：\n${extra.join('\n')}`);
});

test('清单用 LF 换行', (t) => {
  const manifest = readManifest();
  if (!manifest) return t.skip('还没有 release/SHA256SUMS.txt');

  // 行尾多一个 \r，`sha256sum -c` 就会去找「带 \r 的文件名」，一条都校验不过
  assert.ok(!manifest.raw.includes('\r'), '清单里出现了 CR，sha256sum -c 会全部失败');
});
