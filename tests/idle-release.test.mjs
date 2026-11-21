import test from 'node:test';
import assert from 'node:assert/strict';
import { countClientConnections } from '../scripts/idle-release.mjs';

const SAMPLE = `
活动连接

  协议  本地地址          外部地址        状态           PID
  TCP    0.0.0.0:3080           0.0.0.0:0              LISTENING       100
  TCP    127.0.0.1:2862         127.0.0.1:3080         ESTABLISHED     200
  TCP    127.0.0.1:3080         127.0.0.1:2862         ESTABLISHED     100
  TCP    127.0.0.1:2900         127.0.0.1:8123         ESTABLISHED     999
  TCP    127.0.0.1:2901         127.0.0.1:8123         TIME_WAIT       0
  TCP    127.0.0.1:2902         127.0.0.1:443          ESTABLISHED     200
`;

test('只数连到目标端口的客户端侧 ESTABLISHED 连接', () => {
  assert.equal(countClientConnections(SAMPLE, [3080, 8123]), 2);
});

test('控制台自己的探活连接不算活动', () => {
  assert.equal(countClientConnections(SAMPLE, [3080, 8123], [999]), 1);
  assert.equal(countClientConnections(SAMPLE, [3080, 8123], [999, 200]), 0);
});

test('netstat 拿不到内容时为 0', () => {
  assert.equal(countClientConnections('', [3080]), 0);
  assert.equal(countClientConnections(null, [3080]), 0);
});

import { createPresence } from '../scripts/idle-release.mjs';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('最后一个工作台页面关掉、宽限期内没重连，才释放', async () => {
  let fired = 0;
  const p = createPresence({ graceMs: 40, onEmpty: () => { fired += 1; } });
  p.join(); p.join();
  p.leave();
  await wait(60);
  assert.equal(fired, 0, '还有一个页面开着，不能释放');
  p.leave();
  await wait(60);
  assert.equal(fired, 1);
});

test('刷新页面（断开后马上重连）不释放', async () => {
  let fired = 0;
  const p = createPresence({ graceMs: 40, onEmpty: () => { fired += 1; } });
  p.join();
  p.leave();
  await wait(10);
  p.join();
  await wait(60);
  assert.equal(fired, 0);
  assert.equal(p.count, 1);
});
