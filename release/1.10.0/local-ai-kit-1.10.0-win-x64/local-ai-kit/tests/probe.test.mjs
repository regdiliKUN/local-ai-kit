/**
 * 出字快测（quick probe）。
 *
 * 把「试一下」的结果持久化，多个模型横向对比。这里只验证存储往返，
 * 不涉及任何模型调用。
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const kit = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { readProbes, recordProbe, forgetProbe, clearProbes } =
  await import(pathToFileURL(path.join(kit, 'scripts/probe.mjs')).href);

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lak-probe-'));
  return dir;
}

test('没有记录文件时 readProbes 返回空对象', () => {
  const root = tmpRoot();
  assert.deepEqual(readProbes(root), {});
});

test('recordProbe 写入后 readProbes 能读回', () => {
  const root = tmpRoot();
  recordProbe(root, 'qwen3:8b', { ok: true, firstMs: 120, totalMs: 340, chars: 5 });
  const probes = readProbes(root);
  assert.equal(probes['qwen3:8b'].ok, true);
  assert.equal(probes['qwen3:8b'].firstMs, 120);
  assert.equal(probes['qwen3:8b'].totalMs, 340);
  assert.equal(probes['qwen3:8b'].chars, 5);
  assert.ok(Number.isFinite(probes['qwen3:8b'].at));
});

test('同一模型多次快测会被覆盖而不是追加', () => {
  const root = tmpRoot();
  recordProbe(root, 'llama3:8b', { ok: true, firstMs: 200, totalMs: 500, chars: 4 });
  recordProbe(root, 'llama3:8b', { ok: false, firstMs: 0, totalMs: 0, chars: 0 });
  const probes = readProbes(root);
  assert.equal(Object.keys(probes).length, 1);
  assert.equal(probes['llama3:8b'].ok, false);
});

test('不同模型各自保留', () => {
  const root = tmpRoot();
  recordProbe(root, 'a:7b', { ok: true, firstMs: 100, totalMs: 300, chars: 3 });
  recordProbe(root, 'b:13b', { ok: true, firstMs: 300, totalMs: 900, chars: 3 });
  const probes = readProbes(root);
  assert.equal(Object.keys(probes).length, 2);
  assert.ok(probes['a:7b'] && probes['b:13b']);
});

test('forgetProbe 删除指定模型', () => {
  const root = tmpRoot();
  recordProbe(root, 'x:1b', { ok: true, firstMs: 10, totalMs: 20, chars: 1 });
  forgetProbe(root, 'x:1b');
  assert.deepEqual(readProbes(root), {});
});

test('非法模型名不写文件', () => {
  const root = tmpRoot();
  recordProbe(root, '', { ok: true, firstMs: 1, totalMs: 2, chars: 1 });
  recordProbe(root, undefined, { ok: true, firstMs: 1, totalMs: 2, chars: 1 });
  assert.deepEqual(readProbes(root), {});
});

test('clearProbes 清空全部记录', () => {
  const root = tmpRoot();
  recordProbe(root, 'a:1b', { ok: true, firstMs: 1, totalMs: 2, chars: 1 });
  recordProbe(root, 'b:2b', { ok: false, firstMs: 0, totalMs: 0, chars: 0 });
  assert.equal(Object.keys(readProbes(root)).length, 2);
  clearProbes(root);
  assert.deepEqual(readProbes(root), {});
});
