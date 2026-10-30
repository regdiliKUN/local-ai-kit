import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseLibrary, parsePulls, decodeEntities } from '../scripts/library.mjs';
import { proxySettings } from '../scripts/netcheck.mjs';
import { findOrphanBlobs, cleanupOrphanBlobs, analyzeModelDir } from '../scripts/space.mjs';
import { buildReport } from '../scripts/report.mjs';
import { readList, appendItem, writeList, clearList } from '../scripts/store.mjs';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/* ------------------------------------------------------------ 模型库解析 */

/** 官网页面的最小片段（结构照抄官网，只留解析需要的部分） */
const LIB_HTML = `
<ul>
  <li class="flex">
    <a href="/library/qwen3" class="group">
      <h2><span class="truncate">qwen3</span></h2>
      <p class="max-w-lg break-words text-neutral-800 text-md">Qwen3 is the latest generation &amp; more.</p>
      <span class="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5">tools</span>
      <span class="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5">thinking</span>
      <span class="inline-flex items-center rounded-md bg-[#ddf4ff] px-2 py-0.5">8b</span>
      <span class="inline-flex items-center rounded-md bg-[#ddf4ff] px-2 py-0.5">32b</span>
      <p class="my-4 flex space-x-5">
        <span class="flex items-center"><svg .../><span >40.7M</span>
        <span class="hidden sm:flex">&nbsp;Pulls</span></span>
        <span class="flex items-center"><svg .../><span >58</span>
        <span class="hidden sm:flex">&nbsp;Tags</span></span>
      </p>
    </a>
  </li>
  <li class="flex">
    <a href="/library/gemma3" class="group">
      <h2><span class="truncate">gemma3</span></h2>
      <p class="max-w-lg">Runs on a single GPU.</p>
      <span class="inline-flex items-center rounded-md bg-indigo-50">vision</span>
      <span class="inline-flex items-center rounded-md bg-[#ddf4ff]">12b</span>
      <span >41.3M</span><span class="hidden sm:flex">&nbsp;Pulls</span>
    </a>
  </li>
</ul>`;

test('模型库页面能被解析出名字、描述、能力和尺寸', () => {
  const items = parseLibrary(LIB_HTML);
  assert.equal(items.length, 2);
  assert.equal(items[0].name, 'qwen3');
  assert.equal(items[0].description, 'Qwen3 is the latest generation & more.');
  assert.deepEqual(items[0].capabilities, ['tools', 'thinking']);
  assert.deepEqual(items[0].sizes, ['8b', '32b']);
  assert.equal(items[0].pulls, '40.7M');
  assert.equal(items[1].name, 'gemma3');
  assert.deepEqual(items[1].capabilities, ['vision']);
  assert.equal(items[1].pulls, '41.3M');
});

test('模型库解析遇到垃圾输入不崩', () => {
  assert.deepEqual(parseLibrary(''), []);
  assert.deepEqual(parseLibrary('<html>没有模型</html>'), []);
  assert.deepEqual(parseLibrary(null), []);
});

test('下载量能换算成数字', () => {
  assert.equal(parsePulls('40.7M'), 40700000);
  assert.equal(parsePulls('603.2K'), 603200);
  assert.equal(parsePulls('1.2B'), 1200000000);
  assert.equal(parsePulls('43M'), 43000000);
  assert.equal(parsePulls(''), 0);
  assert.equal(parsePulls('abc'), 0);
});

test('HTML 实体能正确解码', () => {
  assert.equal(decodeEntities('Meta&#39;s Llama 3.2'), "Meta's Llama 3.2");
  assert.equal(decodeEntities('a &amp; b'), 'a & b');
  assert.equal(decodeEntities('&lt;tag&gt;'), '<tag>');
});

/* ------------------------------------------------------------ 代理识别 */

test('能认出环境变量里的代理，并遮住里面的账号', () => {
  const list = proxySettings({
    HTTP_PROXY: 'http://user:pass@127.0.0.1:7890',
    HTTPS_PROXY: 'http://127.0.0.1:7890',
  });
  assert.equal(list.length, 2);
  assert.ok(!JSON.stringify(list).includes('pass'), '不该把代理密码写进界面');
  assert.ok(list[0].value.includes('127.0.0.1:7890'));
  assert.deepEqual(proxySettings({}), []);
});

/* ------------------------------------------------------------ 残留清理 */

function makeModelDir(withOrphan) {
  const root = tmp('localai-clean-');
  const blobs = path.join(root, 'blobs');
  const manifest = path.join(root, 'manifests', 'registry.ollama.ai', 'library', 'demo');
  fs.mkdirSync(blobs, { recursive: true });
  fs.mkdirSync(manifest, { recursive: true });
  fs.writeFileSync(path.join(blobs, 'sha256-aaa'), Buffer.alloc(1024));
  fs.writeFileSync(path.join(manifest, 'latest'), JSON.stringify({
    config: { digest: 'sha256:aaa', size: 1024 },
    layers: [],
  }));
  if (withOrphan) fs.writeFileSync(path.join(blobs, 'sha256-orphan'), Buffer.alloc(1024 * 1024));
  return root;
}

test('能找出没被引用的 blob', () => {
  const root = makeModelDir(true);
  try {
    const found = findOrphanBlobs(root);
    assert.equal(found.blobs.length, 1);
    assert.equal(found.blobs[0].name, 'sha256-orphan');
    assert.ok(found.totalGB >= 0);
    // 有引用的那个不能被当成残留
    assert.ok(!found.blobs.some((b) => b.name === 'sha256-aaa'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('预演清理不会真的删文件', () => {
  const root = makeModelDir(true);
  try {
    const out = cleanupOrphanBlobs(root, { dryRun: true });
    assert.equal(out.removed, 1);
    assert.ok(fs.existsSync(path.join(root, 'blobs', 'sha256-orphan')), '预演不该删文件');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('真清理只删没人用的 blob', () => {
  const root = makeModelDir(true);
  try {
    const out = cleanupOrphanBlobs(root, { dryRun: false });
    assert.equal(out.removed, 1);
    assert.ok(!fs.existsSync(path.join(root, 'blobs', 'sha256-orphan')));
    assert.ok(fs.existsSync(path.join(root, 'blobs', 'sha256-aaa')), '有引用的不能删');
    const after = analyzeModelDir(root);
    assert.equal(after.models.length, 1, '删完模型清单还在');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

/* ------------------------------------------------------------ 诊断报告 */

test('诊断报告会去掉用户名和令牌', () => {
  const text = buildReport({
    cfg: { model: 'qwen3:8b', apiKey: 'sk-should-not-appear' },
    logText: 'C:\\Users\\someone\\AppData\\Local\\Temp\\x.log\napi_key = hunter2',
  });
  assert.ok(!text.includes('someone'), '不该出现用户名');
  assert.ok(!text.includes('hunter2'), '不该出现令牌');
  assert.ok(!text.includes('sk-should-not-appear'), '不该出现密钥');
  assert.ok(text.includes('qwen3:8b'), '模型名应该保留');
});

/* ------------------------------------------------------------ 本地存储 */

test('本地存储能存能取，坏文件不会让读取失败', () => {
  const dir = tmp('localai-store-');
  const old = process.env.LOCAL_AI_DATA_DIR;
  process.env.LOCAL_AI_DATA_DIR = dir;
  try {
    assert.deepEqual(readList('health'), []);
    appendItem('health', { at: 1, rate: 0.9 });
    appendItem('health', { at: 2, rate: 0.8 });
    assert.equal(readList('health').length, 2);
    assert.equal(readList('health')[1].rate, 0.8);

    // 超过上限就丢最旧的
    for (let i = 0; i < 100; i++) appendItem('health', { at: i });
    assert.ok(readList('health').length <= 60);

    // 覆盖与清空
    writeList('health', [{ at: 1 }]);
    assert.equal(readList('health').length, 1);
    clearList('health');
    assert.equal(readList('health').length, 0);

    // 文件写坏了也不能让读取失败
    fs.writeFileSync(path.join(dir, 'store.json'), '{ broken');
    assert.deepEqual(readList('health'), []);
  } finally {
    if (old === undefined) delete process.env.LOCAL_AI_DATA_DIR;
    else process.env.LOCAL_AI_DATA_DIR = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
