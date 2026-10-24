/**
 * 部署清单的完整性。
 *
 * 安装向导会把 scripts/ 下的模块「按白名单」拷到一个扁平目录里（部署后没有 scripts/ 这层）。
 * 漏加一个文件，本地跑得好好的，装到用户机器上就是 `ERR_MODULE_NOT_FOUND`——
 * 而且只有在真正安装完才暴露。这个测试把这道检查前移到提交前。
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const kit = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scriptsDir = path.join(kit, 'scripts');
const { SCRIPT_FILES } = await import(pathToFileURL(path.join(scriptsDir, 'runtime-assets.mjs')).href);

/** 抓一个文件里所有 `from './xxx.mjs'` 的引用 */
function localImports(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = new Set();
  const re = /from\s+['"]\.\/([\w.-]+\.mjs)['"]/g;
  let m;
  while ((m = re.exec(text))) out.add(m[1]);
  return out;
}

/** 从入口开始广度遍历，拿到实际会被加载的模块集合 */
function reachable(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    const full = path.join(scriptsDir, name);
    if (!fs.existsSync(full)) continue;
    seen.add(name);
    for (const dep of localImports(full)) queue.push(dep);
  }
  return seen;
}

test('所有会被加载的模块都在部署清单里', () => {
  // 只查 console.mjs：它是装完之后长期运行的入口，依赖必须齐全。
  // installer.mjs 是「安装时」跑的，装完不留在部署目录，不在清单里是对的。
  const used = reachable(['console.mjs']);
  const listed = new Set(SCRIPT_FILES);
  const missing = [...used].filter((f) => !listed.has(f));
  assert.deepEqual(missing, [], `这些模块没进 SCRIPT_FILES，装完会 ERR_MODULE_NOT_FOUND：${missing.join(', ')}`);
});

test('清单里的文件都真实存在', () => {
  const missing = SCRIPT_FILES.filter((f) => !fs.existsSync(path.join(scriptsDir, f)));
  assert.deepEqual(missing, [], `清单里有不存在的文件：${missing.join(', ')}`);
});

test('清单里没有重复项', () => {
  const seen = new Set();
  const dup = [];
  for (const f of SCRIPT_FILES) {
    if (seen.has(f)) dup.push(f);
    seen.add(f);
  }
  assert.deepEqual(dup, [], `重复列出：${dup.join(', ')}`);
});

test('部署清单是纯平铺的（不能带子目录）', () => {
  // copyRuntime 用的是 path.join(root, file)，带子目录会直接抛错
  const nested = SCRIPT_FILES.filter((f) => f.includes('/') || f.includes('\\'));
  assert.deepEqual(nested, [], `清单里不能有子目录：${nested.join(', ')}`);
});
