/**
 * 指标历史环形缓冲。
 *
 * 概览页要画「最近 N 分钟的曲线」，但没有必要把历史落盘 ——
 * 控制台一关，这些数据就没意义了。所以只在内存里留一个定长环。
 */

/**
 * @param {number} size 最多留多少个采样点
 */
export function createHistory(size = 120) {
  const items = [];
  return {
    /** 追加一个采样点（超出容量就丢最旧的） */
    push(point) {
      items.push(point);
      while (items.length > size) items.shift();
      return point;
    },
    /** 最近 n 个点；n 省略时返回全部 */
    tail(n) {
      if (n == null) return items.slice();
      return items.slice(Math.max(0, items.length - n));
    },
    /** 某个字段的时间序列，直接给图表用 */
    series(key, n) {
      return this.tail(n).map((it) => {
        const value = key.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), it);
        return typeof value === 'number' ? value : null;
      });
    },
    get length() { return items.length; },
    clear() { items.length = 0; },
  };
}
