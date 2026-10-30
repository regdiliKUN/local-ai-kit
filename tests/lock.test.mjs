/**
 * 并发锁（busy）的回归测试。
 *
 * 这类 bug 很难在界面上发现：控制台看起来正常，直到某次请求体畸形、
 * 或者用户手快点了两下，才变成「所有按钮都提示正在忙，只能重启进程」。
 * 所以这里直接对着真的控制台进程发请求。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyRuntime, copyTree } from '../scripts/runtime-assets.mjs';

const kit = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 起一个「平铺安装」形态的控制台，返回地址和令牌 */
async function bootConsole() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-lock-'));
  copyRuntime(kit, root);
  copyTree(path.join(kit, 'ui'), path.join(root, 'ui'));
  const child = spawn(process.execPath, [path.join(root, 'console.mjs')], {
    windowsHide: true,
    env: { ...process.env, LOCALAI_NO_BROWSER: '1', DSH_HOME: path.join(root, 'state') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';
  child.stderr.on('data', (c) => { errors += c; });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`控制台没起来：${errors}`)), 15000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`控制台退出 ${code}：${errors}`)); });
    child.stdout.on('data', (c) => {
      output += c;
      const m = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    });
  });
  const html = await (await fetch(base)).text();
  const token = html.match(/window\.__TOKEN__='([^']+)'/)[1];
  const stop = async () => {
    if (child.exitCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { base, token, stop };
}

test('畸形请求体不会把并发锁永久占住', async () => {
  const { base, token, stop } = await bootConsole();
  try {
    const post = (body) => fetch(base + 'api/health', {
      method: 'POST',
      headers: { 'X-LocalAI-Token': token, 'Content-Type': 'application/json' },
      body,
    });
    // 第一次：请求体不是合法 JSON。readBody 会 reject，锁必须跟着放掉。
    const first = await post('{');
    assert.equal(first.status, 400, '畸形请求体应当回 400');
    // 第二次：如果锁泄漏了，这里会是 409「正在忙：health」
    const second = await post('{');
    assert.equal(second.status, 400, '第二次仍然应该是 400，而不是 409（锁泄漏）');
    // 正常请求要能真的开工
    const ok = await post(JSON.stringify({ quick: true }));
    assert.equal(ok.status, 202, '锁放掉之后正常请求应当被受理');
  } finally { await stop(); }
});

test('没有排行在跑时，「停止」不会假装在停', async () => {
  const { base, token, stop } = await bootConsole();
  try {
    const r = await fetch(base + 'api/ranking/stop', {
      method: 'POST',
      headers: { 'X-LocalAI-Token': token, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).running, false, '空跑时的停止请求应如实回 running:false');
  } finally { await stop(); }
});
