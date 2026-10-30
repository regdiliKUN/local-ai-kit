/**
 * 文件小工具：读日志尾巴、原子写。
 *
 * 这两个是「性能 / 数据安全」类改动的底座，用错地方不会报错、只会悄悄变慢或悄悄丢数据，
 * 所以单独测一遍。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const kit = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { tailBytes, writeFileAtomic } = await import(pathToFileURL(path.join(kit, 'scripts', 'store.mjs')).href);

test('tailBytes 只读末尾，且丢掉被切断的半行', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-tail-'));
  try {
    const file = path.join(dir, 'a.log');
    const lines = Array.from({ length: 2000 }, (_, i) => `第 ${i} 行：这是一条比较长的日志内容，用来把文件撑大一点`);
    fs.writeFileSync(file, lines.join('\n'), 'utf8');

    const tail = tailBytes(file, 500);
    assert.ok(tail.length > 0);
    assert.ok(tail.length <= 500, '不应该读超过要求的字节数');
    // 第一行可能是半行，必须被丢掉；最后一行必须完整保留
    assert.ok(tail.endsWith(lines[lines.length - 1]), '最后一行应当完整');
    assert.ok(!tail.startsWith('行'), '被切断的半行不应出现在结果里');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('tailBytes 对不存在的文件返回空串而不是抛异常', () => {
  assert.equal(tailBytes(path.join(os.tmpdir(), '绝对不存在的文件-9f3a.log')), '');
});

test('tailBytes 在小文件上原样返回全文', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-tail2-'));
  try {
    const file = path.join(dir, 'b.log');
    fs.writeFileSync(file, 'hello\nworld', 'utf8');
    assert.equal(tailBytes(file, 8192), 'hello\nworld');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('writeFileAtomic 覆盖旧内容且不留临时文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-atomic-'));
  try {
    const file = path.join(dir, '出字快测.json');
    fs.writeFileSync(file, '{"old":1}', 'utf8');
    writeFileAtomic(file, '{"new":2}');
    assert.equal(fs.readFileSync(file, 'utf8'), '{"new":2}');
    assert.deepEqual(fs.readdirSync(dir), ['出字快测.json'], '不该留下 .tmp');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
