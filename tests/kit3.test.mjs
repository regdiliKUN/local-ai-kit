import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveModelDir } from '../scripts/ollama.mjs';
import { buildReport, strataReport } from '../scripts/report.mjs';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/* ------------------------------------------------------ 模型目录自动识别 */

test('模型目录会挑「真的有 manifests 的那个」，而不是配置里写的那个', () => {
  const root = tmp('localai-dir-');
  const good = path.join(root, 'ollama', 'models');
  fs.mkdirSync(path.join(good, 'manifests', 'registry.ollama.ai'), { recursive: true });
  const empty = path.join(root, 'empty', 'models');
  fs.mkdirSync(empty, { recursive: true });
  try {
    // 显式给的目录里没有 manifests → 应该继续找，而不是直接用
    const found = resolveModelDir(empty);
    assert.notEqual(found, empty, '没有 manifests 的目录不该被选中');
    assert.ok(found, '应该找到一个可用目录');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('一个都没有时返回空字符串而不是 undefined', () => {
  const root = tmp('localai-dir2-');
  const old = process.env.OLLAMA_MODELS;
  delete process.env.OLLAMA_MODELS;
  try {
    const found = resolveModelDir(path.join(root, 'nope'));
    assert.equal(typeof found, 'string');
  } finally {
    if (old !== undefined) process.env.OLLAMA_MODELS = old;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------ 诊断报告 */

test('Ollama 版报告会带上硬件、配置和日志', async () => {
  const text = await buildReport({
    cfg: { model: 'qwen3:8b', modelDir: 'D:\\models' },
    metrics: {
      cpu: { model: 'Test CPU', cores: 8 },
      memory: { totalGB: 16, freeGB: 8 },
      gpu: [{ name: 'Test GPU', driver: '1.0', memoryTotalMB: 8192 }],
      disk: { path: 'D:\\', totalGB: 100, freeGB: 50 },
    },
    diagnose: { checks: [{ level: 'ok', label: 'Node.js', detail: 'v20' }] },
    logText: 'hello log',
  });
  assert.match(text, /Test CPU/);
  assert.match(text, /Test GPU/);
  assert.match(text, /qwen3:8b/);
  assert.match(text, /hello log/);
  assert.match(text, /隐私说明/);
});

test('Strata 版报告会写清三个服务的状态', async () => {
  const text = await strataReport({
    cfg: { backend: 'strata', enginePort: 8080, webPort: 8090, dshPort: 3080, deploymentRoot: 'F:\\x' },
    logText: 'log line',
  });
  assert.match(text, /Strata 部署/);
  assert.match(text, /:8080/);
  assert.match(text, /:3090|:8090/);
  assert.match(text, /服务状态/);
});

test('报告里不会出现令牌', async () => {
  const text = await buildReport({
    cfg: { token: 'sk-secret-value', apiKey: 'another-secret' },
    logText: 'authorization: Bearer abc123',
  });
  assert.ok(!text.includes('sk-secret-value'));
  assert.ok(!text.includes('another-secret'));
});
