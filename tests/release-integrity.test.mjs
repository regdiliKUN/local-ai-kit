import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const kit = fileURLToPath(new URL('../', import.meta.url));
const manifest = path.join(kit, 'release', 'SHA256SUMS.txt');

test('发行包中的文件与 SHA256 清单一致，下载后可以逐项校验', {
  // 离线安装包只有运行时源码，没有仓库级的 release/ 目录。
  skip: !fs.existsSync(path.join(kit, 'release')),
}, () => {
  const problems = [];
  const listed = new Set();
  for (const line of fs.readFileSync(manifest, 'utf8').trim().split(/\r?\n/)) {
    const entry = line.match(/^([a-f0-9]{64})  (release\/[^\r\n]+)$/);
    assert.ok(entry, `无效的校验清单条目：${line}`);
    const [, hash, rel] = entry;
    assert.ok(!listed.has(rel), `重复的校验条目：${rel}`);
    listed.add(rel);
    const file = path.join(kit, rel);
    if (!fs.existsSync(file)) {
      problems.push(`缺少文件：${rel}`);
      continue;
    }
    const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (actual !== hash) problems.push(`SHA256 不匹配：${rel}`);
  }
  assert.ok(listed.size > 0, '校验清单不能为空');
  for (const version of fs.readdirSync(path.join(kit, 'release'), { withFileTypes: true })) {
    if (!version.isDirectory()) continue;
    const dir = path.join(kit, 'release', version.name);
    for (const rel of fs.readdirSync(dir, { recursive: true })) {
      if (!fs.statSync(path.join(dir, rel)).isFile()) continue;
      const entry = ['release', version.name, ...rel.split(path.sep)].join('/');
      if (!listed.has(entry)) problems.push(`未列入校验清单：${entry}`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});
