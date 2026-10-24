/*
 * 对话分支树。
 *
 * 「重新生成」之后，上一个回答并没有白费 —— 它变成了这条分支上的一个节点。
 * 整段对话因此是一棵树，而不是一条线：
 *
 *   我：介绍一下显存
 *     ├─ 模型：A（第一次）
 *     └─ 模型：B（重新生成的）
 *
 * 想看哪个版本点一下就切过去。往下接着聊时，新消息会挂在当前选中的那个节点下面，
 * 于是两条路线互不干扰。
 *
 * 数据结构就是一棵普通的树，节点长这样：
 *   { id, role, content, children: [] }
 *
 * 同时给浏览器和 Node（测试）用，所以写成 UMD 形式。
 */
(function (factory) {
  var g = typeof globalThis !== 'undefined' ? globalThis : this;
  if (typeof module === 'object' && module && module.exports) module.exports = factory();
  else g.ConversationTree = factory();
}(function () {
  /** 造一个新节点 */
  function makeNode(role, content, id) {
    return {
      id: id || 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      role: role,
      content: content || '',
      children: [],
      createdAt: Date.now(),
    };
  }

  /** 造一棵空树（根节点是虚拟的，不显示） */
  function makeTree() {
    return makeNode('root', '', 'root');
  }

  /** 顺着 children 找子节点 */
  function childOf(node, id) {
    if (!node || !node.children) return null;
    for (const c of node.children) if (c.id === id) return c;
    return null;
  }

  /** 沿着路径从根走到某个节点 */
  function nodeAt(tree, path) {
    let cur = tree;
    for (const id of path) {
      const next = childOf(cur, id);
      if (!next) return null;
      cur = next;
    }
    return cur;
  }

  /** 当前路径上的最后一个节点（也就是「现在停在哪儿」） */
  function leafOf(tree, path) {
    return nodeAt(tree, path) || tree;
  }

  /**
   * 往树上挂一个新节点。
   * @returns {string[]} 新的路径
   */
  function appendNode(tree, path, node) {
    const parent = leafOf(tree, path);
    if (!parent) return path;
    parent.children.push(node);
    return path.concat([node.id]);
  }

  /**
   * 重新生成时用：当前这个回答的兄弟节点（同一个问题下的其它回答）。
   */
  function siblingsOf(tree, path) {
    if (!path || path.length < 2) return [];
    const parent = leafOf(tree, path.slice(0, -1));
    if (!parent) return [];
    return parent.children.slice();
  }

  /**
   * 把树摊平成「当前路径上的消息列表」。
   */
  function flatten(tree, path) {
    const out = [];
    let cur = tree;
    for (const id of path || []) {
      const next = childOf(cur, id);
      if (!next) break;
      out.push({ id: next.id, role: next.role, content: next.content });
      cur = next;
    }
    return out;
  }

  /**
   * 统计一棵树：有多少个节点、多少个分支。
   */
  function treeStats(tree) {
    let nodes = 0;
    let branches = 0;
    const walk = (n) => {
      if (!n) return;
      if (n.id !== 'root') nodes += 1;
      if (n.children.length > 1) branches += n.children.length - 1;
      for (const c of n.children) walk(c);
    };
    walk(tree);
    return { nodes: nodes, branches: branches };
  }

  /**
   * 导出成 Markdown（带分支标注）。
   */
  function treeToMarkdown(tree, path) {
    const lines = [];
    const walk = (node, depth) => {
      for (let i = 0; i < node.children.length; i++) {
        const c = node.children[i];
        const mark = node.children.length > 1 ? ' [branch ' + (i + 1) + '/' + node.children.length + ']' : '';
        if (c.role !== 'root') {
          const who = c.role === 'user' ? '我' : '模型';
          lines.push('  '.repeat(depth) + who + mark);
          lines.push('  '.repeat(depth) + c.content);
          lines.push('');
        }
        walk(c, c.role === 'root' ? depth : depth + 1);
      }
    };
    walk(tree, 0);
    return lines.join('\n');
  }

  return {
    makeNode: makeNode, makeTree: makeTree, childOf: childOf, nodeAt: nodeAt,
    leafOf: leafOf, appendNode: appendNode, siblingsOf: siblingsOf,
    flatten: flatten, treeStats: treeStats, treeToMarkdown: treeToMarkdown,
  };
}));
