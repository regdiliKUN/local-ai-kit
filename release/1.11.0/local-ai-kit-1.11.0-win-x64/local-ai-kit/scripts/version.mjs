/**
 * 版本号比较。
 *
 * 单独放一个文件是有原因的：console.mjs 一被 import 就会真的起一个 HTTP 服务，
 * 测试里没法直接 import 它（进程会一直不退出）。
 */

/** 比较两个版本号：a > b 返回 1，a < b 返回 -1，相等返回 0 */
export function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}
