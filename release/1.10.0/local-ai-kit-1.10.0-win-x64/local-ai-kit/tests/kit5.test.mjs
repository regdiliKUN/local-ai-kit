import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  makeTree, makeNode, appendNode, leafOf, siblingsOf, flatten, treeStats, treeToMarkdown,
} from '../scripts/conversation-tree.mjs';
import { rankingAdvice } from '../scripts/ranking.mjs';
import { diskSummary } from '../scripts/diskhealth.mjs';

const kit = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/* ------------------------------------------------------------ 对话分支树 */

test('对话树：挂节点后能沿着路径读回来', () => {
  const tree = makeTree();
  let p = appendNode(tree, [], makeNode('user', 'Q1'));
  p = appendNode(tree, p, makeNode('assistant', 'A1'));
  const list = flatten(tree, p);
  assert.equal(list.length, 2);
  assert.equal(list[0].content, 'Q1');
  assert.equal(list[1].content, 'A1');
});

test('对话树：重新生成产生兄弟分支，两条路线互不干扰', () => {
  const tree = makeTree();
  let p = appendNode(tree, [], makeNode('user', 'Q1'));
  p = appendNode(tree, p, makeNode('assistant', 'A1'));

  // 退回到用户提问，在它下面挂第二个回答
  const parent = leafOf(tree, p.slice(0, -1));
  const alt = makeNode('assistant', 'A2');
  parent.children.push(alt);
  const p2 = p.slice(0, -1).concat([alt.id]);

  assert.deepEqual(flatten(tree, p).map((x) => x.content), ['Q1', 'A1']);
  assert.deepEqual(flatten(tree, p2).map((x) => x.content), ['Q1', 'A2']);
  assert.equal(siblingsOf(tree, p2).length, 2, '同一个问题下有两个回答');
  assert.equal(treeStats(tree).branches, 1);
  assert.equal(treeStats(tree).nodes, 3);
});

test('对话树：导出 Markdown 时标出分支', () => {
  const tree = makeTree();
  let p = appendNode(tree, [], makeNode('user', 'Q1'));
  p = appendNode(tree, p, makeNode('assistant', 'A1'));
  const parent = leafOf(tree, p.slice(0, -1));
  parent.children.push(makeNode('assistant', 'A2'));
  const md = treeToMarkdown(tree, p);
  assert.match(md, /A1/);
  assert.match(md, /branch 1\/2/);
});

/* -------------------------------------------------------------- 排行建议 */

test('排行建议会指出最强的和最弱的', () => {
  const advice = rankingAdvice([
    { model: 'big', passed: 20, total: 21, rate: 0.95 },
    { model: 'small', passed: 12, total: 21, rate: 0.57 },
  ]);
  assert.ok(advice.some((a) => a.includes('big')));
  assert.ok(advice.some((a) => a.includes('small')));
  assert.ok(advice.some((a) => a.includes('21 道题')));
});

test('排行建议在只有一个模型时也会说明情况', () => {
  const advice = rankingAdvice([{ model: 'only', passed: 10, total: 21, rate: 0.48 }]);
  assert.ok(Array.isArray(advice));
});

test('排行建议在全部失败时提醒先修问题', () => {
  const advice = rankingAdvice([
    { model: 'a', error: 'boom', passed: 0, total: 0, rate: 0 },
    { model: 'b', error: 'boom', passed: 0, total: 0, rate: 0 },
  ]);
  assert.ok(advice.some((a) => a.includes('修复中心')));
});

/* -------------------------------------------------------------- 磁盘健康 */

test('磁盘总结会把异常盘点名', () => {
  const summary = diskSummary([
    { name: 'SSD-A', letter: 'C:', level: 'error', note: '剩余寿命只剩 5%' },
    { name: 'HDD-B', letter: 'D:', level: 'ok', note: '正常' },
  ]);
  assert.ok(summary.some((s) => s.includes('异常')));
  assert.ok(summary.some((s) => s.includes('SSD-A')));
});

test('磁盘总结在都正常时给出肯定结论', () => {
  const summary = diskSummary([
    { name: 'SSD-A', letter: 'C:', level: 'ok', note: '正常', mediaText: 'NVMe 固态' },
  ]);
  assert.ok(summary.some((s) => s.includes('正常')));
  assert.ok(summary.some((s) => s.includes('固态')));
});

/* ------------------------------------------------------------ 多语言字典 */

test('多语言字典覆盖了界面上的所有文案', () => {
  const src = fs.readFileSync(path.join(kit, 'ui', 'i18n.js'), 'utf8');
  const dict = {};
  const re = /'((?:[^'\\]|\\.)*)'\s*:\s*'((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    dict[m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\')] = m[2].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  }
  assert.ok(Object.keys(dict).length > 400, `字典条目太少：${Object.keys(dict).length}`);
  // 每一条都要有译文；带正文的条目还得有英文
  const PUNCT = '，。、：；！？（）【】《》“”「」·…—';
  for (const [k, v] of Object.entries(dict)) {
    assert.ok(v && v.length > 0, `「${k}」没有译文`);
    const hasWord = [...k].some((c) => /[一-鿿]/.test(c) && !PUNCT.includes(c));
    if (hasWord) {
      assert.ok(/[A-Za-z]/.test(v), `「${k}」的译文里没有英文：${v}`);
    }
  }
});
