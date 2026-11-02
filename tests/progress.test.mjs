/**
 * 启动进度模型的行为约束。
 *
 * 这里钉的是三条最容易在改代码时被破坏的性质：
 *   1. 没真正就绪之前永远不到 100（否则用户看到 100% 却打不开工作台）
 *   2. 数字只进不退（轮询抖动、日志尚未落盘都不该让进度条往回跳）
 *   3. 阶段只能靠真实信号推进，等得久不算（否则慢机器会一直显示「已经好了」）
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { STARTUP_STEPS, computeStartupProgress, parseStartupMarkers } from '../scripts/progress.mjs';

const T0 = 1_700_000_000_000;

test('日志里程碑按顺序累进', () => {
  const empty = parseStartupMarkers('');
  assert.equal(empty.weights, false);
  assert.equal(empty.ready, false);

  const weights = parseStartupMarkers('[strata] starting the engine: reading the model\'s weights ...');
  assert.equal(weights.weights, true);
  assert.equal(weights.experts, false);

  const ready = parseStartupMarkers('ready: http://127.0.0.1:8080/v1  (OpenAI: /v1/chat/completions');
  assert.equal(ready.ready, true);
  assert.equal(ready.almostReady, true, '后面的里程碑出现时，前面的应当一起补齐');
  assert.equal(ready.experts, true);
  assert.equal(ready.weights, true);
});

test('引擎和界面都在线才是完成态', () => {
  const done = computeStartupProgress({ startedAt: T0, now: T0 + 42000, engineOnline: true, dshOnline: true });
  assert.equal(done.percent, 100);
  assert.equal(done.done, true);
  assert.equal(done.failed, false);
  assert.equal(done.etaSeconds, 0);

  const halfway = computeStartupProgress({ startedAt: T0, now: T0 + 42000, engineOnline: true, dshOnline: false });
  assert.ok(halfway.percent < 100, '只有引擎起来时不能算完成');
  assert.equal(halfway.done, false);
  assert.equal(halfway.step, 'dsh');
});

test('没就绪就永远不到 100，哪怕等十分钟', () => {
  const slow = computeStartupProgress({ startedAt: T0, now: T0 + 10 * 60 * 1000 });
  assert.ok(slow.percent <= 99, `等太久也不该给满分，实际 ${slow.percent}`);
  assert.equal(slow.done, false);
});

test('阶段内插值不会越过下一阶段的门口', () => {
  const weights = STARTUP_STEPS.find((s) => s.id === 'weights');
  const p = computeStartupProgress({
    startedAt: T0, now: T0 + 9 * 60 * 1000, markers: { weights: true },
  });
  assert.ok(p.percent <= weights.to, `${p.percent} 不该超过当前阶段上限 ${weights.to}`);
  assert.ok(p.percent >= weights.from);
});

test('数字只进不退', () => {
  const early = computeStartupProgress({ startedAt: T0, now: T0 + 3000 });
  const later = computeStartupProgress({ startedAt: T0, now: T0 + 2000, lastPercent: early.percent });
  assert.ok(later.percent >= early.percent, '时间回退（或轮询乱序）时也不能掉百分比');
});

test('失败时冻结在原地并保留原因', () => {
  const p = computeStartupProgress({
    startedAt: T0, now: T0 + 20000, lastPercent: 46, error: '显存检查未通过，引擎未启动。',
  });
  assert.equal(p.failed, true);
  assert.equal(p.done, false);
  assert.equal(p.percent, 46);
  assert.match(p.detail, /显存/);
  assert.equal(p.etaSeconds, 0);
});

test('ETA 随阶段推进而下降', () => {
  const start = computeStartupProgress({ startedAt: T0, now: T0 + 1000 });
  const later = computeStartupProgress({ startedAt: T0, now: T0 + 40000, markers: { experts: true } });
  assert.ok(start.etaSeconds > later.etaSeconds, `${start.etaSeconds} 应大于 ${later.etaSeconds}`);
  assert.ok(later.etaSeconds >= 0);
});
