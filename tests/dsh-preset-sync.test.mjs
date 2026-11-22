// dsh 压缩参数自愈：YAML 改写正确，且每个本地模型的压缩预算真的「压得下来」
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCompactionConfig, renderManagedConfig, COMPACTION_POLICY, MODEL_POLICIES,
} from '../scripts/dsh-preset-sync.mjs';

const FIXTURE = [
  '        plugins:',
  '          - id: compaction-basic',
  '            config:',
  '              thresholdRatio: 0.45',
  '              headroomTokens: 8192',
  '              retainRatio: 0.3',
  '              # 摘要请求自己的输出上限',
  '              maxTokens: 6144',
  '              compactionRetries: 2',
  '              modelPolicies:',
  '                - provider: old-local',
  '                  model: old',
  '                  maxTokens: 999',
  '            name: \'@deepseek-ai/dsh-compaction-basic\'',
  '          - id: command-compact',
  '            name: \'@deepseek-ai/dsh-command-compact\'',
];

test('改写后旧的 modelPolicies 被整块换掉，其它键和注释保留', () => {
  const lines = [...FIXTURE];
  assert.equal(applyCompactionConfig(lines, 1), true);
  const text = lines.join('\n');
  assert.doesNotMatch(text, /old-local|maxTokens: 999/);
  assert.match(text, /compactionRetries: 2/);
  assert.match(text, /# 摘要请求自己的输出上限/);
  assert.match(text, /- provider: qwen35-local\n\s+model: Qwen3\.5-35B-A3B-Uncensored/);
  // 默认参数只出现一次（没有被重复追加）
  assert.equal(text.match(/^\s{14}thresholdRatio:/gm).length, 1);
  // 后面的插件条目没被吞掉
  assert.match(text, /- id: command-compact/);
});

test('幂等：再跑一次不再改动', () => {
  const lines = [...FIXTURE];
  applyCompactionConfig(lines, 1);
  const once = lines.join('\n');
  assert.equal(applyCompactionConfig(lines, 1), false);
  assert.equal(lines.join('\n'), once);
});

test('modelPolicies 里每一项的键不会被默认参数覆盖', () => {
  const lines = [...FIXTURE];
  applyCompactionConfig(lines, 1);
  applyCompactionConfig(lines, 1);
  const text = lines.join('\n');
  for (const p of MODEL_POLICIES) {
    assert.match(text, new RegExp(`retainTokens: ${p.retainTokens}`));
    assert.match(text, new RegExp(`headroomTokens: ${p.headroomTokens}`));
  }
});

test('能修复旧版脚本写坏的块（列表项里的键被挪到外层，YAML 报重复键）', () => {
  // 旧版按行替换键名，把 modelPolicies 里每一项的 thresholdRatio/headroomTokens
  // 改成了外层缩进的默认值 —— 工作台因此启动失败（duplicated mapping key）
  const broken = [
    '          - id: compaction-basic',
    '            config:',
    '              thresholdRatio: 0.45',
    '              headroomTokens: 8192',
    '              retainRatio: 0.3',
    '              maxTokens: 6144',
    '              modelPolicies:',
    '                - provider: qwen35-local',
    '                  model: Qwen3.5-35B-A3B-Uncensored',
    '              thresholdRatio: 0.45',
    '              headroomTokens: 8192',
    '                  retainTokens: 12288',
    '            name: \'@deepseek-ai/dsh-compaction-basic\'',
  ];
  applyCompactionConfig(broken, 0);
  const text = broken.join('\n');
  assert.equal(text.match(/^\s{14}thresholdRatio:/gm).length, 1, '外层只能有一个 thresholdRatio');
  assert.equal(text.match(/^\s{18}thresholdRatio: 0\.75/gm).length, MODEL_POLICIES.length);
});

test('没有 config 块时插入完整的一段', () => {
  const lines = ['  - id: compaction-basic', '    name: x', '  - id: next'];
  applyCompactionConfig(lines, 0);
  assert.equal(lines[2], '    config:');
  assert.deepEqual(lines.slice(3, 3 + renderManagedConfig('      ').length), renderManagedConfig('      '));
});

/*
 * 预算校验：照插件源码 resolveCompactSpec 的公式算，和工作台配置里的窗口 / 回复上限对上。
 * FIXED 是工作台每次请求自带的系统提示 + 工具清单（实测 21722 token，按 22K 算）。
 */
const FIXED = 22000;
const SUMMARY_MAX = Number(COMPACTION_POLICY.maxTokens);
const MODELS = {
  'qwen35-local': { contextWindow: 65536, maxTokens: 8192, engineWindow: 65536 },
  'strata-local': { contextWindow: 49152, maxTokens: 12288, engineWindow: 131072 },
};

for (const p of MODEL_POLICIES) {
  test(`${p.provider}：压缩预算能真正压下来，回复和摘要都放得进窗口`, () => {
    const m = MODELS[p.provider];
    assert.ok(m, `测试里缺少 ${p.provider} 的窗口信息`);
    const messageBudget = m.contextWindow - m.maxTokens;
    const threshold = Math.floor(Math.min(m.contextWindow * Number(p.thresholdRatio), messageBudget - Number(p.headroomTokens)));
    const retain = Number(p.retainTokens);
    assert.ok(retain < threshold, '保留量必须小于阈值（插件会直接报错）');
    // 压完：固定开销 + 最长摘要 + 逐字保留，必须回到阈值以下，否则会反复压缩
    assert.ok(FIXED + SUMMARY_MAX + retain < threshold, `压完 ${FIXED + SUMMARY_MAX + retain} 仍不低于阈值 ${threshold}`);
    // 到阈值时还要能放下一条完整回复：否则就是「已达到输出 token 上限」
    assert.ok(threshold + m.maxTokens <= m.engineWindow, '阈值 + 回复上限超过了引擎真实窗口');
    // 摘要请求本身（带着整段对话）也得放得进去
    assert.ok(threshold + SUMMARY_MAX <= m.engineWindow, '摘要请求放不进引擎窗口');
  });
}
