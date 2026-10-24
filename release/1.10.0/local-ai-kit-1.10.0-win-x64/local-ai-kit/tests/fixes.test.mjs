/**
 * 回归测试：针对本轮修掉的具体缺陷。
 *
 * 每条都对应一个真实场景，不是「为了覆盖率」。改坏任何一条，对应的问题就会复现。
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const kit = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Windows 上动态 import 绝对路径必须转成 file:// URL，否则报 ERR_UNSUPPORTED_ESM_URL_SCHEME
const load = (rel) => import(pathToFileURL(path.join(kit, rel)).href);

const { mergeConfig, loadConfigSafe } = await load('scripts/config.mjs');
const { pipeFile } = await load('scripts/local-http.mjs');
const { handleStrata } = await load('scripts/strata.mjs');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'localai-fix-'));
}

/** 起一个临时 HTTP 服务，跑完自动关 */
function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({ base, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// ---------------------------------------------------------------- 配置合并
test('mergeConfig 保留它不认识的字段（Strata 部署的 backend/enginePort 不能被抹掉）', () => {
  const root = tmpRoot();
  try {
    // 先写一份带 Strata 字段的配置
    fs.writeFileSync(
      path.join(root, '配置.json'),
      JSON.stringify({ model: 'old', backend: 'strata', enginePort: 8080, strataHome: 'F:\\本地AI' }),
      'utf8',
    );
    // 模拟向导重新写配置：只关心 model / modelDir / contextWindow
    mergeConfig(root, { model: 'new-model', modelDir: 'D:\\models', contextWindow: 8192 });

    const cfg = loadConfigSafe(root);
    assert.equal(cfg.model, 'new-model');
    assert.equal(cfg.backend, 'strata', 'backend 被抹掉了，控制台会退回 ollama 模式');
    assert.equal(cfg.enginePort, 8080, 'enginePort 被抹掉了');
    assert.equal(cfg.strataHome, 'F:\\本地AI', 'strataHome 被抹掉了');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 静态流
test('pipeFile 在文件消失时返回 500 而不是让进程崩掉', async () => {
  const s = await serve((req, res) => {
    pipeFile(res, path.join(os.tmpdir(), 'localai-绝对不存在的文件.stl'), { 'Content-Type': 'text/plain' });
  });
  try {
    const res = await fetch(s.base + '/');
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.match(body.error, /读取文件失败/);
  } finally {
    await s.close();
  }
});

test('pipeFile 正常文件返回 200 且内容完整', async () => {
  const root = tmpRoot();
  const file = path.join(root, 'a.txt');
  fs.writeFileSync(file, 'hello-本地', 'utf8');
  const s = await serve((req, res) => pipeFile(res, file, { 'Content-Type': 'text/plain; charset=utf-8' }));
  try {
    const res = await fetch(s.base + '/');
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'hello-本地');
  } finally {
    await s.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- Strata 根路径
test('Strata 模式访问根路径返回页面而不是 404', async () => {
  const root = tmpRoot();
  const ui = path.join(kit, 'ui');
  const s = await serve((req, res) => handleStrata(req, res, {
    cfg: { backend: 'strata', deploymentRoot: 'F:\\本地AI', enginePort: 1, webPort: 2, dshPort: 3 },
    ui,
    token: 'example',
  }));
  try {
    // 用户从桌面快捷方式打开的就是根路径，这里 404 等于一进门就是错误页
    const res = await fetch(s.base + '/');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /window\.__TOKEN__="example"/);
  } finally {
    await s.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Strata 模式未知路径仍然 404（不要因为修根路径把兜底放开）', async () => {
  const s = await serve((req, res) => handleStrata(req, res, {
    cfg: { backend: 'strata', deploymentRoot: 'F:\\本地AI', enginePort: 1, webPort: 2, dshPort: 3 },
    ui: path.join(kit, 'ui'),
    token: 'example',
  }));
  try {
    assert.equal((await fetch(s.base + '/nope.html')).status, 404);
  } finally {
    await s.close();
  }
});
