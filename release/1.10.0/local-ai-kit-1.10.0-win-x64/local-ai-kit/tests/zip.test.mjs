/**
 * zip 打包的正确性。
 *
 * 这个模块是手写的容器格式，写错了外部工具打不开——所以这里不测「函数返回了 Buffer」，
 * 而是逐字节验证 zip 规范要求的结构。
 */
import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const kit = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { makeZip } = await import(pathToFileURL(path.join(kit, 'scripts/zip.mjs')).href);

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

test('makeZip 生成合法的 zip 结构', () => {
  const buf = makeZip([
    { name: 'a.txt', data: 'hello' },
    { name: 'sub/b.json', data: '{"x":1}' },
  ]);
  assert.equal(buf.readUInt32LE(0), LOCAL_SIG, '开头必须是本地文件头');
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), EOCD_SIG, '结尾必须是中央目录结束记录');
  assert.equal(buf.readUInt16LE(eocd + 8), 2, '条目数应为 2');
  assert.equal(buf.readUInt16LE(eocd + 10), 2, '总条目数应为 2');
});

test('中央目录里的偏移能指回对应的本地头', () => {
  const buf = makeZip([{ name: 'x.txt', data: 'abc' }]);
  const eocd = buf.length - 22;
  const cdOffset = buf.readUInt32LE(eocd + 16);
  assert.equal(buf.readUInt32LE(cdOffset), CENTRAL_SIG);
  // 中央目录里记录的本地头偏移，必须真的是本地头
  const localOffset = buf.readUInt32LE(cdOffset + 42);
  assert.equal(buf.readUInt32LE(localOffset), LOCAL_SIG);
});

test('数据长度与 CRC 写在头里且一致', () => {
  const data = Buffer.from('测试内容 with ascii');
  const buf = makeZip([{ name: 'd.txt', data }]);
  assert.equal(buf.readUInt32LE(18), data.length, '压缩后长度');
  assert.equal(buf.readUInt32LE(22), data.length, '原始长度');
  assert.notEqual(buf.readUInt32LE(14), 0, 'CRC 不能是 0');
});

test('中文文件名与内容按 UTF-8 存储', () => {
  const buf = makeZip([{ name: '中文名.txt', data: '内容' }]);
  // 通用标志位 bit 11 表示文件名是 UTF-8
  const flags = buf.readUInt16LE(6);
  assert.ok(flags & 0x0800, '必须设置 UTF-8 标志位');
  const nameLen = buf.readUInt16LE(26);
  const name = buf.slice(30, 30 + nameLen).toString('utf8');
  assert.equal(name, '中文名.txt');
});

test('Windows 反斜杠路径被规范成 /', () => {
  const buf = makeZip([{ name: 'sub\\deep\\f.txt', data: 'x' }]);
  const nameLen = buf.readUInt16LE(26);
  const name = buf.slice(30, 30 + nameLen).toString('utf8');
  assert.equal(name, 'sub/deep/f.txt', '反斜杠会让解压出来是一堆怪文件名');
});

test('空文件也能打包', () => {
  const buf = makeZip([{ name: 'empty.txt', data: '' }]);
  assert.equal(buf.readUInt32LE(18), 0);
  assert.equal(buf.readUInt32LE(14), 0, '空内容的 CRC 是 0');
  assert.equal(buf.length, 30 + 'empty.txt'.length + 46 + 'empty.txt'.length + 22);
});

test('空列表生成只有 EOCD 的合法 zip', () => {
  const buf = makeZip([]);
  assert.equal(buf.length, 22);
  assert.equal(buf.readUInt32LE(0), EOCD_SIG);
  assert.equal(buf.readUInt16LE(8), 0);
});
