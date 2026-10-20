/**
 * 配置差异。
 *
 * 检查点原本只能「回滚到这里」，用户看不到会改掉什么。这个模块把两份配置
 * 摊平后逐项对比，输出「改了 / 新增 / 删掉」三类。
 */
import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const kit = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { flatten, diffConfig, labelOf, textOf } =
  await import(pathToFileURL(path.join(kit, 'scripts/configdiff.mjs')).href);

// ---------------------------------------------------------------- flatten
test('嵌套对象摊平成点号键', () => {
  const flat = flatten({ a: 1, b: { c: 2, d: { e: 3 } } });
  assert.deepEqual(flat, { a: 1, 'b.c': 2, 'b.d.e': 3 });
});

test('数组当整体，不展开', () => {
  const flat = flatten({ list: [1, 2, 3] });
  assert.deepEqual(flat.list, [1, 2, 3]);
});

test('空对象保留键名', () => {
  const flat = flatten({ empty: {} });
  assert.deepEqual(flat.empty, {});
});

test('null 和 undefined 都能处理', () => {
  const flat = flatten({ a: null, b: { c: null } });
  assert.equal(flat.a, null);
  assert.equal(flat['b.c'], null);
});

// ---------------------------------------------------------------- diff
test('识别改过的项', () => {
  const d = diffConfig({ model: 'a:1b', contextWindow: 8192 }, { model: 'b:2b', contextWindow: 8192 });
  assert.equal(d.changed.length, 1);
  assert.deepEqual(d.changed[0], { key: 'model', from: 'a:1b', to: 'b:2b' });
  assert.equal(d.same, 1);
});

test('识别新增的项', () => {
  const d = diffConfig({ model: 'a' }, { model: 'a', lanShare: true });
  assert.deepEqual(d.added, [{ key: 'lanShare', to: true }]);
  assert.equal(d.changed.length, 0);
});

test('识别删掉的项', () => {
  const d = diffConfig({ model: 'a', strataHome: 'F:\\AI' }, { model: 'a' });
  assert.deepEqual(d.removed, [{ key: 'strataHome', from: 'F:\\AI' }]);
});

test('嵌套字段的差异能落到具体路径', () => {
  const d = diffConfig({ settings: { theme: 'dark' } }, { settings: { theme: 'light' } });
  assert.equal(d.changed[0].key, 'settings.theme');
  assert.equal(d.changed[0].from, 'dark');
  assert.equal(d.changed[0].to, 'light');
});

test('数组内容变化算一次改动', () => {
  const d = diffConfig({ tags: ['a', 'b'] }, { tags: ['a', 'c'] });
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].key, 'tags');
});

test('完全一样时 total 为 0', () => {
  const cfg = { model: 'a', nested: { x: 1 } };
  const d = diffConfig(cfg, JSON.parse(JSON.stringify(cfg)));
  assert.equal(d.total, 0);
  assert.equal(d.changed.length + d.added.length + d.removed.length, 0);
  assert.equal(d.same, 2);
});

test('空配置对比不抛异常', () => {
  assert.equal(diffConfig({}, {}).total, 0);
  assert.equal(diffConfig(null, null).total, 0);
  assert.equal(diffConfig({}, { a: 1 }).added.length, 1);
});

test('布尔值变化能识别（false → true 不能当成「没变」）', () => {
  const d = diffConfig({ lanShare: false }, { lanShare: true });
  assert.equal(d.changed.length, 1, 'false 和 true 必须算变化');
  assert.equal(d.changed[0].from, false);
  assert.equal(d.changed[0].to, true);
});

test('数字 0 和字符串 "0" 算不同', () => {
  const d = diffConfig({ port: 0 }, { port: '0' });
  assert.equal(d.changed.length, 1);
});

// ---------------------------------------------------------------- 人话转换
test('已知键名翻成中文', () => {
  assert.equal(labelOf('model'), '当前模型');
  assert.equal(labelOf('settings.lanShare'), '局域网共享');
  assert.equal(labelOf('enginePort'), '引擎端口');
});

test('不认识的键名原样返回', () => {
  assert.equal(labelOf('someNewKey'), 'someNewKey');
});

test('布尔值显示成开关', () => {
  assert.equal(textOf(true), '开');
  assert.equal(textOf(false), '关');
});

test('空值显示成（空）', () => {
  assert.equal(textOf(null), '（空）');
  assert.equal(textOf(undefined), '（空）');
});

test('长文本截断，不撑破弹窗', () => {
  const long = 'x'.repeat(200);
  const out = textOf(long);
  assert.ok(out.length <= 60, `实际 ${out.length}`);
  assert.ok(out.endsWith('…'));
});

test('对象折成 JSON 片段', () => {
  assert.equal(textOf([1, 2]), '[1,2]');
  assert.equal(textOf({ a: 1 }), '{"a":1}');
});
