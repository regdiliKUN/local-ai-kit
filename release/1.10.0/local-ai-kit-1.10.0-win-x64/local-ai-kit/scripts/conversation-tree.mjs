/**
 * 给 Node（测试）用的薄封装。
 *
 * 实现放在 ui/conversation-tree.js —— 那是浏览器要直接加载的经典脚本，
 * 这里只是把它当普通脚本求值一遍，好让测试也能用同一份实现。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'ui', 'conversation-tree.js'), 'utf8');

const fakeModule = { exports: {} };
new Function('module', 'exports', source)(fakeModule, fakeModule.exports);

export default fakeModule.exports;
export const {
  makeNode, makeTree, childOf, nodeAt, leafOf,
  appendNode, siblingsOf, flatten, treeStats, treeToMarkdown,
} = fakeModule.exports;
