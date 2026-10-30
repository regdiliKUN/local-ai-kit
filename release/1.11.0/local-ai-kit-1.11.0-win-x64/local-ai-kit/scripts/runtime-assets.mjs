/** Keep source and installed console dependencies in one manifest. */
import fs from 'node:fs';
import path from 'node:path';

export const SCRIPT_FILES = [
  'config.mjs', 'models.mjs', 'ollama.mjs', 'detect.mjs', 'idlist.mjs', 'make-lnk.mjs',
  'make-shortcuts.mjs', 'start-local-ai.mjs', 'stop-local-ai.mjs',
  'console.mjs', 'uninstall.mjs', 'install.mjs', 'yamlpatch.mjs',
  'preset-standard.patch.yml', 'local-http.mjs', 'runtime-assets.mjs', 'strata.mjs',
  'strata-process.ps1',
  // v1.4.0 新增
  'metrics.mjs', 'history.mjs', 'space.mjs', 'pull-queue.mjs',
  'chat.mjs', 'bench.mjs', 'backup.mjs', 'repair.mjs', 'version.mjs',
  // v1.5.0 新增
  'store.mjs', 'library.mjs', 'netcheck.mjs', 'report.mjs', 'package-offline.mjs',
  // v1.6.1 新增
  'zip.mjs',
  // v1.7.3 新增
  'usage.mjs',
  // v1.7.5 新增
  'configdiff.mjs',
  // v1.8.0 新增
  'diskhealth.mjs', 'ranking.mjs', 'conversation-tree.mjs',
  // v1.7.8 新增
  'probe.mjs',
  // v1.10.1 新增（.cmd 入口模板，快捷方式要靠它）
  'cmd-entries.mjs',
];

/**
 * 递归复制目录（自己实现，不用 `fs.cpSync`）。
 *
 * 两个原因：
 *   1. `fs.cpSync` 在某些 Node 22 的 Windows 构建上会**直接把进程带走**
 *      （exitCode 0xC0000409 / 无输出），连 try/catch 都拦不住 ——
 *      安装向导、体检复制、测试都会踩到。
 *   2. 这里只需要「普通文件 + 目录」，不需要符号链接 / 权限位那些语义。
 *
 * @param {string} src 源目录
 * @param {string} dst 目标目录（不存在会创建）
 * @param {(source: string) => boolean} [filter] 返回 false 的条目（含整个子目录）跳过
 */
export function copyTree(src, dst, filter = () => true) {
  if (!filter(src)) return;
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) copyTree(path.join(src, name), path.join(dst, name), filter);
    return;
  }
  if (st.isFile()) fs.copyFileSync(src, dst);
}

export function copyRuntime(kitDir, root) {
  fs.mkdirSync(root, { recursive: true });
  for (const file of SCRIPT_FILES) fs.copyFileSync(path.join(kitDir, 'scripts', file), path.join(root, file));
  // package.json 也要跟着走：install.mjs 的 KIT_VERSION 从它读版本号。
  // 少了这一份，装完之后版本恒为 0.0.0，控制台会一直提示「有新版本」。
  fs.copyFileSync(path.join(kitDir, 'package.json'), path.join(root, 'package.json'));
  copyTree(path.join(kitDir, 'healthcheck'), path.join(root, 'healthcheck'),
    (source) => !['check_out', 'probe_out', '__pycache__'].includes(path.basename(source)));
}
