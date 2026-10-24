/**
 * 模型使用记录。
 *
 * 这个模块要回答的问题是「哪些模型装完就没碰过」——
 * 模型动辄几个 GB，装十几个就是上百 GB，光看安装列表看不出该删谁。
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const kit = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { recordUse, readUsage, usageReport, forgetModel } =
  await import(pathToFileURL(path.join(kit, 'scripts/usage.mjs')).href);

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'localai-usage-'));
}

test('记录后能读回来，计数累加', () => {
  const root = tmpRoot();
  try {
    recordUse(root, 'qwen2.5:7b', 'chat');
    recordUse(root, 'qwen2.5:7b', 'chat');
    recordUse(root, 'qwen2.5:7b', 'bench');
    const u = readUsage(root);
    assert.equal(u.models['qwen2.5:7b'].count, 3);
    assert.equal(u.models['qwen2.5:7b'].kinds.chat, 2);
    assert.equal(u.models['qwen2.5:7b'].kinds.bench, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('不同模型分开记', () => {
  const root = tmpRoot();
  try {
    recordUse(root, 'a:1b', 'chat');
    recordUse(root, 'b:2b', 'bench');
    const u = readUsage(root);
    assert.deepEqual(Object.keys(u.models).sort(), ['a:1b', 'b:2b']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('空模型名不写脏数据', () => {
  const root = tmpRoot();
  try {
    assert.equal(recordUse(root, '', 'chat'), null);
    assert.equal(recordUse(root, '   ', 'chat'), null);
    assert.deepEqual(readUsage(root).models, {});
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('记录文件损坏时当空处理，不抛异常', () => {
  const root = tmpRoot();
  try {
    fs.writeFileSync(path.join(root, '使用记录.json'), '{坏掉的 json', 'utf8');
    assert.deepEqual(readUsage(root).models, {});
    // 还能正常继续记录
    recordUse(root, 'x:1b', 'chat');
    assert.equal(readUsage(root).models['x:1b'].count, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('从没记录过的模型标成 never', () => {
  const root = tmpRoot();
  try {
    recordUse(root, 'used:7b', 'chat');
    const rep = usageReport(root, ['used:7b', 'never:13b']);
    const never = rep.rows.find((r) => r.name === 'never:13b');
    assert.equal(never.never, true);
    assert.equal(never.stale, true, '没用过的一律算该清理的候选');
    assert.deepEqual(rep.neverUsed, ['never:13b']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('超过阈值的标成 stale', () => {
  const root = tmpRoot();
  try {
    recordUse(root, 'old:7b', 'chat');
    // 手动把 last 改成 60 天前
    const file = path.join(root, '使用记录.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.models['old:7b'].last = new Date(Date.now() - 60 * 86400000).toISOString();
    fs.writeFileSync(file, JSON.stringify(data), 'utf8');

    const rep = usageReport(root, ['old:7b'], 30);
    const row = rep.rows.find((r) => r.name === 'old:7b');
    assert.equal(row.stale, true);
    assert.ok(row.daysAgo >= 59, `daysAgo 应约 60，实际 ${row.daysAgo}`);
    assert.deepEqual(rep.stale, ['old:7b']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('最近用过的不会被标 stale', () => {
  const root = tmpRoot();
  try {
    recordUse(root, 'fresh:7b', 'chat');
    const rep = usageReport(root, ['fresh:7b'], 30);
    assert.equal(rep.rows[0].stale, false);
    assert.equal(rep.rows[0].daysAgo, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('记录里有、但已经不装的模型单独报出来', () => {
  const root = tmpRoot();
  try {
    recordUse(root, 'removed:7b', 'chat');
    recordUse(root, 'still:7b', 'chat');
    const rep = usageReport(root, ['still:7b']);
    assert.deepEqual(rep.removed, ['removed:7b'], '用户可能以为这个还在');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('删模型时能一起清掉记录', () => {
  const root = tmpRoot();
  try {
    recordUse(root, 'gone:7b', 'chat');
    assert.equal(forgetModel(root, 'gone:7b'), true);
    assert.equal(readUsage(root).models['gone:7b'], undefined);
    // 再删一次返回 false，不报错
    assert.equal(forgetModel(root, 'gone:7b'), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('记录数量有上限，不会无限增长', () => {
  const root = tmpRoot();
  try {
    for (let i = 0; i < 210; i++) recordUse(root, `m${i}:1b`, 'chat');
    const u = readUsage(root);
    assert.ok(Object.keys(u.models).length <= 200, `实际 ${Object.keys(u.models).length}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
