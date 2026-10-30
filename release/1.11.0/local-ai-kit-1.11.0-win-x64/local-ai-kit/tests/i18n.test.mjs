/**
 * 界面文案的英文翻译必须齐全。
 *
 * 英文界面是 v1.8.0 就有的功能，但新加的中文文案经常忘了补翻译 ——
 * 后果不是报错，而是英文界面里突然冒出一句中文，看起来像没做完。
 * CI 里那条 shell 检查只在 windows-latest 上跑，这里补一条不依赖平台的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const kit = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('界面文案没有漏翻的条目', () => {
  const out = execFileSync(process.execPath, [path.join(kit, 'scripts', 'extract-i18n.mjs')], {
    cwd: kit, encoding: 'utf8', timeout: 60000,
  });
  const m = out.match(/待翻译 (\d+) 条/);
  assert.ok(m, `没能从输出里读到统计：${out.slice(0, 200)}`);
  assert.equal(Number(m[1]), 0, `有 ${m[1]} 条界面文案还没翻译：\n${out}`);
});
