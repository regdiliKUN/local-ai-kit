import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectFiles, buildManifest } from '../scripts/package-offline.mjs';

const kit = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('离线包会收进关键文件，不会带 node_modules 和运行期残留', () => {
  const files = collectFiles(kit);
  assert.ok(files.length > 10, '应该收进不少文件');
  assert.ok(files.some((f) => f.startsWith('scripts') && f.endsWith('console.mjs')));
  assert.ok(files.some((f) => f.startsWith('ui') && f.endsWith('console.html')));
  assert.ok(files.some((f) => f.includes('① 双击这里开始安装.cmd')));
  assert.ok(files.some((f) => f.startsWith('healthcheck')));
  // 不该带的
  assert.ok(!files.some((f) => f.includes('node_modules')));
  assert.ok(!files.some((f) => f.includes('check_out')));
  assert.ok(!files.some((f) => f.startsWith('node' + path.sep)));
  assert.ok(!files.some((f) => f.endsWith('.tmp')));
});

test('校验清单能对上每个文件的哈希', () => {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-manifest-'));
  try {
    const rels = ['a.txt', 'sub/b.txt'];
    for (const r of rels) {
      const full = path.join(stage, r);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, `内容-${r}`, 'utf8');
    }
    const manifest = buildManifest(stage, rels);
    const lines = manifest.split('\n');
    assert.equal(lines.length, 2);
    for (const line of lines) {
      const [hash, rel] = line.split(/\s{2}/);
      assert.match(hash, /^[0-9a-f]{64}$/);
      assert.ok(rels.includes(rel));
    }
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
});
