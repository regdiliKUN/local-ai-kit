import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const kit = fileURLToPath(new URL('../', import.meta.url));

test('新增界面文案必须有译文，提交前就能发现 CI 的翻译缺失', () => {
  const output = execFileSync(process.execPath, ['scripts/extract-i18n.mjs', '--missing'], {
    cwd: kit,
    encoding: 'utf8',
  });
  assert.match(output, /共 \d+ 条，待翻译 0 条/, output);
});

test('HTML 里的换行和缩进不影响整段文案翻译', () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(kit, 'ui/i18n.js'), 'utf8'), context);
  const i18n = context.window.I18n;
  i18n.setLang('en');
  const html = fs.readFileSync(path.join(kit, 'ui/console.html'), 'utf8');
  const raw = html.match(/<p[^>]*>(切模型要重启工作台才生效[\s\S]*?)<\/p>/)[1];
  const key = raw.replace(/\s+/g, ' ').trim();
  assert.equal(i18n.translateText(raw), i18n.DICT[key]);
  assert.equal(i18n.translateText('  清空记录\n'), '  Clear history\n');
});
