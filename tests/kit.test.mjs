import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadConfig, saveConfig, sanitizeConfig, listBackups, backupConfig, mergeConfig,
} from '../scripts/config.mjs';
import { parseNvidiaSmi, parseRocmSmi, diskUsage } from '../scripts/metrics.mjs';
import { detectSystem } from '../scripts/detect.mjs';
import { analyzeModelDir, readManifest, normalizeDigest } from '../scripts/space.mjs';
import { createPullQueue } from '../scripts/pull-queue.mjs';
import { median, extractRates, referenceFor, makePrompt } from '../scripts/bench.mjs';
import { exportBundle, importBundle, validateBundle } from '../scripts/backup.mjs';
import { resolveStaticPath, createRateLimiter, createOriginGuard, tokenMatches } from '../scripts/local-http.mjs';
import { modelsForVram, pickContextWindow, estimateVramGB, contextFit } from '../scripts/models.mjs';
import { compareVersions } from '../scripts/version.mjs';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/* ------------------------------------------------------------------ 配置 */

test('配置字段会被夹到合法范围，未知字段保留', () => {
  const out = sanitizeConfig({
    contextWindow: 999999, maxTokens: -5, thresholdRatio: 3,
    enginePort: 70000, model: 123, myOwnKey: 'keep',
  });
  assert.equal(out.contextWindow, 262144);
  assert.equal('maxTokens' in out, false);
  assert.equal('thresholdRatio' in out, false);
  assert.equal('enginePort' in out, false);
  assert.equal('model' in out, false);
  assert.equal(out.myOwnKey, 'keep');
});

test('配置写坏了会自动回退到备份，文件名本身缺失时不会凭空造配置', () => {
  const root = tmp('localai-cfg-');
  try {
    fs.writeFileSync(path.join(root, '配置.json'), '{"model":"good"}');
    saveConfig(root, { model: 'better' });
    assert.equal(loadConfig(root).model, 'better');
    // 人为写坏
    fs.writeFileSync(path.join(root, '配置.json'), '{ this is not json');
    // 回退到最近一份备份 —— 备份是「上一次写入之前」的状态，所以是 good
    assert.equal(loadConfig(root).model, 'good', '应该回退到备份');
    // 文件整个没了 → 不该回退
    fs.rmSync(path.join(root, '配置.json'), { force: true });
    assert.equal(loadConfig(root), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('备份会滚动保留，且合并配置会覆盖单个字段', () => {
  const root = tmp('localai-bak-');
  try {
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(path.join(root, '配置.json'), JSON.stringify({ model: `m${i}` }));
      backupConfig(root);
    }
    assert.ok(listBackups(root).length <= 3, '备份最多留 3 份');
    fs.writeFileSync(path.join(root, '配置.json'), JSON.stringify({ model: 'a', contextWindow: 4096 }));
    const next = mergeConfig(root, { contextWindow: 8192 });
    assert.equal(next.model, 'a');
    assert.equal(next.contextWindow, 8192);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

/* ------------------------------------------------------------------ 指标 */

test('nvidia-smi 输出能被正确解析', () => {
  const text = [
    'NVIDIA GeForce RTX 4090, 617.42, 24564, 23945, 40, 48, 130.55',
    'NVIDIA GeForce RTX 3080, 552.22, 10240, 1024, 15, 40, 55.10',
  ].join('\n');
  const gpus = parseNvidiaSmi(text);
  assert.equal(gpus.length, 2);
  assert.equal(gpus[0].name, 'NVIDIA GeForce RTX 4090');
  assert.equal(gpus[0].memoryTotalMB, 24564);
  assert.equal(gpus[0].utilization, 40);
  assert.equal(gpus[1].memoryTotalMB, 10240);
  assert.deepEqual(parseNvidiaSmi(''), []);
  assert.deepEqual(parseNvidiaSmi('garbage'), []);
});

test('rocm-smi 的 json 输出能被正确解析', () => {
  const json = JSON.stringify({
    card0: {
      'Card series': 'RDNA2', 'VRAM Total Memory (B)': 25753026560,
      'VRAM Total Used Memory (B)': 1073741824, 'GPU use (%)': 22,
    },
  });
  const gpus = parseRocmSmi(json);
  assert.equal(gpus.length, 1);
  assert.equal(gpus[0].vendor, 'amd');
  assert.equal(gpus[0].memoryTotalMB, 24560);
  assert.equal(gpus[0].utilization, 22);
  assert.deepEqual(parseRocmSmi('not json'), []);
});

test('磁盘用量能算出来', () => {
  const d = diskUsage(os.tmpdir());
  assert.ok(d && d.totalGB > 0);
  assert.ok(d.freeGB <= d.totalGB);
  // 只有「根目录本身取不到」时才会是 null。
  // Windows 上是「不存在的盘」；Linux 上根目录总是存在，所以这条只在 Windows 上验。
  if (process.platform === 'win32') {
    assert.equal(diskUsage('Z:\\definitely-not-a-drive'), null);
  }
});

test('系统信息能读到 CPU 核数和内存', () => {
  const s = detectSystem();
  assert.ok(s.cores > 0);
  assert.ok(s.memoryGB > 0);
});

/* ------------------------------------------------------------ 空间分析 */

test('manifest 里的 digest 要和 blob 文件名对得上（sha256: 与 sha256-）', () => {
  assert.equal(normalizeDigest('sha256:abc'), 'sha256-abc');
  const root = tmp('localai-space-');
  try {
    const blobs = path.join(root, 'blobs');
    // 真实布局：manifests/<registry>/<namespace>/<模型名>/<标签>（标签是文件）
    const manifest = path.join(root, 'manifests', 'registry.ollama.ai', 'library', 'demo');
    fs.mkdirSync(blobs, { recursive: true });
    fs.mkdirSync(manifest, { recursive: true });
    fs.writeFileSync(path.join(blobs, 'sha256-aaa'), Buffer.alloc(1024));
    fs.writeFileSync(path.join(blobs, 'sha256-bbb'), Buffer.alloc(2048));
    fs.writeFileSync(path.join(manifest, 'latest'), JSON.stringify({
      config: { digest: 'sha256:aaa', size: 1024 },
      layers: [{ digest: 'sha256:bbb', size: 2048 }],
    }));
    const info = analyzeModelDir(root);
    assert.equal(info.models.length, 1);
    assert.equal(info.models[0].name, 'demo:latest');
    assert.equal(info.models[0].blobs, 2);
    assert.equal(info.models[0].sizeGB, 0);
    assert.equal(info.orphanGB, 0, '所有 blob 都应该被引用到');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('没有被任何 manifest 引用的 blob 会被算成残留', () => {
  const root = tmp('localai-orphan-');
  try {
    const blobs = path.join(root, 'blobs');
    fs.mkdirSync(blobs, { recursive: true });
    fs.writeFileSync(path.join(blobs, 'sha256-zzz'), Buffer.alloc(1024 * 1024 * 10));
    const info = analyzeModelDir(root);
    assert.ok(info.orphanGB > 0, '应该有残留');
    assert.equal(info.models.length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('manifest 解析失败时返回空数组而不是抛异常', () => {
  const root = tmp('localai-bad-');
  try {
    const file = path.join(root, 'x');
    fs.writeFileSync(file, 'not json');
    assert.deepEqual(readManifest(file), []);
    assert.deepEqual(readManifest(path.join(root, 'missing')), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

/* ------------------------------------------------------------ 下载队列 */

test('下载队列能加任务、拒绝重复、清理已完成项', () => {
  const events = [];
  // 注入假的下载动作：不会真的去连 Ollama
  const q = createPullQueue({
    emit: (e) => events.push(e),
    pull: async (model, onUpdate) => { onUpdate({ got: 100, total: 100 }); },
  });
  assert.equal(q.add('qwen3:8b').ok, true);
  assert.equal(q.add('qwen3:8b').ok, false, '同一个模型不该重复入队');
  assert.equal(q.add('').ok, false);
  const snap = q.snapshot();
  assert.equal(snap.items.length, 1);
  assert.equal(snap.items[0].model, 'qwen3:8b');
  assert.ok(events.some((e) => e.type === 'queue'));
  q.clearFinished();
  assert.equal(q.snapshot().items.length, 1, '还没完成的不能被清掉');
});

test('下载队列会依次下载，并记录每个任务的状态', async () => {
  const started = [];
  const q = createPullQueue({
    pull: async (model, onUpdate) => {
      started.push(model);
      onUpdate({ got: 50, total: 100 });
      onUpdate({ got: 100, total: 100 });
    },
  });
  q.add('a:1');
  q.add('b:2');
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(started, ['a:1', 'b:2'], '应该按顺序下');
  const items = q.snapshot().items;
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => i.status === 'done'), '两个都该完成');
  assert.ok(items.every((i) => i.percent === 100));
});

test('下载失败会被记成 error 而不是让队列卡住', async () => {
  const q = createPullQueue({
    pull: async () => { throw new Error('boom'); },
  });
  q.add('bad:1');
  await new Promise((r) => setTimeout(r, 120));
  const item = q.snapshot().items[0];
  assert.equal(item.status, 'error');
  assert.match(item.error, /boom/);
  assert.equal(q.isBusy(), false, '失败之后不该还占着「忙」');
});

/* ---------------------------------------------------------------- 测速 */

test('测速用中位数，不会被偶发卡顿带偏', () => {
  assert.equal(median([10, 20, 30]), 20);
  assert.equal(median([10, 20, 30, 40]), 25);
  assert.equal(median([]), null);
  assert.equal(median([null, 5, 5]), 5);
});

test('从 Ollama 的完成事件里能算出速度', () => {
  const r = extractRates({
    eval_count: 100, eval_duration: 1e9,
    prompt_eval_count: 200, prompt_eval_duration: 2e9,
    total_duration: 3e9,
  });
  assert.equal(r.tokens, 100);
  assert.equal(r.genTokensPerSec, 100);
  assert.equal(r.promptTokensPerSec, 100);
  assert.equal(r.totalMs, 3000);
});

test('参考值按显存档位往下取', () => {
  assert.equal(referenceFor(24).gen, referenceFor(30).gen);
  assert.ok(referenceFor(24).gen > referenceFor(8).gen);
  assert.ok(referenceFor(0).gen <= referenceFor(8).gen);
});

test('长提示词会真的长到指定长度', () => {
  assert.ok(makePrompt(2000).length > 500);
  assert.ok(makePrompt(200).length > 50);
});

/* ------------------------------------------------------------ 配置备份 */

test('配置导出后再导入能还原，坏包会被拒绝', () => {
  const root = tmp('localai-bundle-');
  const home = tmp('localai-dsh-');
  try {
    fs.writeFileSync(path.join(root, '配置.json'), JSON.stringify({ model: 'qwen3:8b', contextWindow: 16384 }));
    fs.mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true });
    fs.writeFileSync(path.join(home, 'profiles', 'web', 'cordis.patch.yml'), '# patch\nmodel: qwen3:8b\n');
    const bundle = exportBundle(root, { dshHome: home });
    assert.equal(bundle.kind, 'local-ai-kit/config-bundle');
    assert.equal(bundle.config.model, 'qwen3:8b');
    assert.match(bundle.profiles.web, /qwen3:8b/);

    const out = importBundle(root, bundle, { dshHome: home });
    assert.equal(out.applied, true);
    assert.equal(loadConfig(root).model, 'qwen3:8b');
    assert.equal(loadConfig(root).contextWindow, 16384);

    assert.throws(() => validateBundle({ kind: 'wrong' }), /格式不对/);
    assert.throws(() => validateBundle(null), /有效/);
    assert.throws(() => validateBundle({ kind: 'local-ai-kit/config-bundle', version: 999, config: {} }), /版本太新/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------- HTTP 层 */

test('静态文件路径不能跳出 UI 目录', () => {
  const ui = path.join(os.tmpdir(), 'ui-test');
  assert.equal(resolveStaticPath(ui, 'console.html'), path.join(ui, 'console.html'));
  assert.equal(resolveStaticPath(ui, '../secret.txt'), null);
  assert.equal(resolveStaticPath(ui, 'a/../../b'), null);
  assert.equal(resolveStaticPath(ui, '..\\..\\windows\\system32'), null);
  assert.equal(resolveStaticPath(ui, ''), null);
});

test('限流器会放行正常请求、拦住刷屏的请求', () => {
  const limiter = createRateLimiter({ getLimit: 3, postLimit: 1, windowMs: 60000 });
  const get = () => ({ method: 'GET', socket: { remoteAddress: '127.0.0.1' } });
  const post = () => ({ method: 'POST', socket: { remoteAddress: '127.0.0.1' } });
  assert.equal(limiter(get()).ok, true);
  assert.equal(limiter(get()).ok, true);
  assert.equal(limiter(get()).ok, true);
  assert.equal(limiter(get()).ok, false, '超过额度就该拦住');
  assert.equal(limiter(post()).ok, true);
  assert.equal(limiter(post()).ok, false);
});

test('来源守卫会挡住伪造的 Host 和错误的令牌', () => {
  const guard = createOriginGuard({ port: 7790, token: 'abc' });
  assert.equal(guard.hostOk({ headers: { host: '127.0.0.1:7790' } }), true);
  assert.equal(guard.hostOk({ headers: { host: 'evil.com' } }), false);
  assert.equal(guard.postOk({ headers: { origin: 'http://127.0.0.1:7790', 'x-localai-token': 'abc' } }), true);
  assert.equal(guard.postOk({ headers: { origin: 'http://evil.com', 'x-localai-token': 'abc' } }), false);
  assert.equal(guard.postOk({ headers: { origin: 'http://127.0.0.1:7790', 'x-localai-token': 'wrong' } }), false);
});

test('令牌比较不会因长度或编码不同而误判', () => {
  assert.equal(tokenMatches('abc', 'abc'), true);
  assert.equal(tokenMatches('abc', 'abcd'), false);
  assert.equal(tokenMatches('é'.repeat(48), 'a'.repeat(48)), false);
});

/* ---------------------------------------------------------------- 模型 */

test('按显存过滤模型，没有独显时只给最小的', () => {
  assert.equal(modelsForVram(24)[0].tag, 'qwen3:32b');
  assert.ok(modelsForVram(0).every((m) => m.needGB <= 4));
  assert.ok(modelsForVram(8).every((m) => m.needGB <= 8));
});

test('上下文长度按显存余量推导', () => {
  // 24G 显存跑 20G 的模型，余量 4G → 16K；余量够大才上 64K
  assert.equal(pickContextWindow(24, 20), 16384);
  assert.equal(pickContextWindow(31, 20), 65536);
  assert.equal(pickContextWindow(16, 9.3), 32768);
  assert.ok(pickContextWindow(8, 5.2) <= 16384);
});

test('显存估算会随上下文变大', () => {
  const small = estimateVramGB('qwen3:32b', 4096);
  const big = estimateVramGB('qwen3:32b', 65536);
  assert.ok(big > small);
  assert.ok(contextFit('qwen3:32b', 4096, 24).level !== 'over');
  assert.equal(contextFit('qwen3:32b', 262144, 24).level, 'over');
});

/* ---------------------------------------------------------------- 版本 */

test('版本比较能分出大小', () => {
  assert.equal(compareVersions('1.4.0', '1.3.9'), 1);
  assert.equal(compareVersions('1.3.9', '1.4.0'), -1);
  assert.equal(compareVersions('1.4', '1.4.0'), 0);
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
});
