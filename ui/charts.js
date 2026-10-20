/*
 * 轻量 SVG 图表。
 *
 * 为什么自己写而不引第三方库：整个项目承诺「零第三方依赖、只用 Node」，
 * 安装包要能被离线分发，一个 charting 库动辄几百 KB。
 * 这里用最朴素的办法：所有图表都吐 SVG 字符串，配色走 CSS 变量，
 * 这样深色模式自动跟随主题，不用在 JS 里判断。
 *
 * 用法：Chart.sparkline([1,2,3])  →  直接 innerHTML 进去
 */

const Chart = (() => {
  const NS = 'http://www.w3.org/2000/svg';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const num = (v) => (Number.isFinite(v) ? v : null);

  /** 取一组数里的最大值；全都不是数字时返回 1（避免除零） */
  function maxOf(values, fallback = 1) {
    const nums = values.map(num).filter((v) => v != null);
    if (!nums.length) return fallback;
    const m = Math.max(...nums);
    return m > 0 ? m : fallback;
  }

  function minOf(values, fallback = 0) {
    const nums = values.map(num).filter((v) => v != null);
    if (!nums.length) return fallback;
    return Math.min(...nums);
  }

  /**
   * 折线图（迷你趋势线）。
   * @param {number[]} values 数据点，可含 null（断点）
   */
  function sparkline(values, opts = {}) {
    const w = opts.width || 160;
    const h = opts.height || 40;
    const pad = opts.pad ?? 3;
    const cls = opts.className || 'spark';
    const points = (values || []).map(num);
    const finite = points.filter((v) => v != null);

    if (!finite.length) {
      return `<svg class="${cls}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="暂无数据">
        <line x1="0" y1="${h / 2}" x2="${w}" y2="${h / 2}" class="spark-base" /></svg>`;
    }

    const min = opts.min != null ? opts.min : Math.min(...finite);
    const max = opts.max != null ? opts.max : maxOf(finite);
    const span = max - min || 1;
    const stepX = points.length > 1 ? (w - pad * 2) / (points.length - 1) : 0;

    const coords = [];
    points.forEach((v, i) => {
      if (v == null) return;
      const x = pad + i * stepX;
      const y = h - pad - ((v - min) / span) * (h - pad * 2);
      coords.push([x, y]);
    });

    // 断点处不连线：按连续段分别生成 path
    const segments = [];
    let current = [];
    points.forEach((v, i) => {
      if (v == null) { if (current.length) segments.push(current); current = []; return; }
      current.push([pad + i * stepX, h - pad - ((v - min) / span) * (h - pad * 2)]);
    });
    if (current.length) segments.push(current);

    const linePath = segments
      .filter((s) => s.length > 1)
      .map((s) => `M${s.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L')}`)
      .join(' ');

    const areaPath = segments.length
      ? segments.filter((s) => s.length > 1).map((s) => {
        const up = `M${s[0][0].toFixed(1)},${h - pad}` +
          s.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join('') +
          `L${s[s.length - 1][0].toFixed(1)},${h - pad}Z`;
        return up;
      }).join(' ')
      : '';

    const last = coords[coords.length - 1];
    const dot = last ? `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.4" class="spark-dot" />` : '';

    return `<svg class="${cls}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none" role="img" aria-label="趋势">
      ${areaPath ? `<path d="${areaPath}" class="spark-area" />` : ''}
      ${linePath ? `<path d="${linePath}" class="spark-line" fill="none" />` : ''}
      ${dot}
    </svg>`;
  }

  /**
   * 环形图。
   * @param {{label:string,value:number,color?:string}[]} segments
   */
  function donut(segments, opts = {}) {
    const size = opts.size || 160;
    const thickness = opts.thickness || 22;
    const r = (size - thickness) / 2;
    const cx = size / 2;
    const cy = size / 2;
    const circumference = 2 * Math.PI * r;
    const total = (segments || []).reduce((n, s) => n + (Math.max(0, Number(s.value) || 0)), 0);

    if (!total) {
      return `<svg class="chart-donut" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="暂无数据">
        <circle cx="${cx}" cy="${cy}" r="${r}" class="donut-track" fill="none" stroke-width="${thickness}" />
        <text x="${cx}" y="${cy}" class="donut-center" text-anchor="middle" dominant-baseline="middle">0</text></svg>`;
    }

    let offset = 0;
    const arcs = (segments || []).map((s, i) => {
      const value = Math.max(0, Number(s.value) || 0);
      const frac = value / total;
      const len = frac * circumference;
      const dash = `${len.toFixed(2)} ${(circumference - len).toFixed(2)}`;
      const rot = -90 + (offset / circumference) * 360;
      offset += len;
      return `<circle cx="${cx}" cy="${cy}" r="${r}" class="donut-seg" fill="none" stroke-width="${thickness}"
        stroke-dasharray="${dash}" stroke-dashoffset="${(-offset + len).toFixed(2)}"
        transform="rotate(${rot.toFixed(2)} ${cx} ${cy})" style="--seg:${esc(s.color || `var(--chart-${(i % 6) + 1})`)}"
        data-label="${esc(s.label)}"><title>${esc(s.label)} ${value}</title></circle>`;
    }).join('');

    const centerText = opts.centerText != null ? esc(opts.centerText) : String(total);
    const centerSub = opts.centerSub ? `<text x="${cx}" y="${cy + 16}" class="donut-sub" text-anchor="middle">${esc(opts.centerSub)}</text>` : '';

    return `<svg class="chart-donut" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="占比">
      <circle cx="${cx}" cy="${cy}" r="${r}" class="donut-track" fill="none" stroke-width="${thickness}" />
      ${arcs}
      <text x="${cx}" y="${cy - (centerSub ? 6 : 0)}" class="donut-center" text-anchor="middle" dominant-baseline="middle">${centerText}</text>
      ${centerSub}
    </svg>`;
  }

  /**
   * 半环形仪表盘。
   * @param {number} percent 0~100
   */
  function gauge(percent, opts = {}) {
    const w = opts.width || 180;
    const h = opts.height || 104;
    const pct = Math.max(0, Math.min(100, Number(percent) || 0));
    const cx = w / 2;
    const cy = h - 12;
    const r = Math.min(w / 2 - 12, cy - 12);
    const circumference = Math.PI * r;      // 半圆
    const len = (pct / 100) * circumference;

    const level = pct >= 90 ? 'err' : pct >= 75 ? 'warn' : 'ok';

    return `<svg class="chart-gauge" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${pct}%">
      <path d="M${cx - r},${cy} A${r},${r} 0 0 1 ${cx + r},${cy}" class="gauge-track" fill="none" stroke-width="9" stroke-linecap="round" />
      <path d="M${cx - r},${cy} A${r},${r} 0 0 1 ${cx + r},${cy}" class="gauge-fill ${level}" fill="none" stroke-width="9"
        stroke-linecap="round" stroke-dasharray="${len.toFixed(1)} ${circumference.toFixed(1)}" />
      <text x="${cx}" y="${cy - 12}" class="gauge-value" text-anchor="middle">${Math.round(pct)}<tspan class="gauge-unit">%</tspan></text>
      ${opts.label ? `<text x="${cx}" y="${cy + 4}" class="gauge-label" text-anchor="middle">${esc(opts.label)}</text>` : ''}
    </svg>`;
  }

  /**
   * 横向条形图。
   * @param {{label:string,value:number,unit?:string,hint?:string}[]} items
   */
  function bars(items, opts = {}) {
    const list = items || [];
    if (!list.length) return '<div class="chart-empty">暂无数据</div>';
    const max = opts.max != null ? opts.max : maxOf(list.map((i) => i.value), 1);
    const width = opts.width || 260;
    const rowH = opts.rowH || 26;
    const labelW = opts.labelW || 78;
    const valueW = opts.valueW || 56;
    const barW = Math.max(20, width - labelW - valueW - 8);
    const height = list.length * rowH;

    const rows = list.map((it, i) => {
      const v = Math.max(0, Number(it.value) || 0);
      const w = max > 0 ? Math.min(barW, (v / max) * barW) : 0;
      const y = i * rowH;
      const color = it.color ? ` style="--seg:${esc(it.color)}"` : '';
      return `<g class="bar-row">
        <text x="0" y="${y + rowH / 2 + 4}" class="bar-label">${esc(it.label)}</text>
        <rect x="${labelW}" y="${y + 5}" width="${barW}" height="${rowH - 12}" rx="4" class="bar-track" />
        <rect x="${labelW}" y="${y + 5}" width="${w.toFixed(1)}" height="${rowH - 12}" rx="4" class="bar-fill"${color} />
        <text x="${width}" y="${y + rowH / 2 + 4}" class="bar-value" text-anchor="end">${esc(it.text != null ? it.text : `${v}${it.unit || ''}`)}</text>
        ${it.hint ? `<title>${esc(it.hint)}</title>` : ''}
      </g>`;
    }).join('');

    return `<svg class="chart-bars" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">${rows}</svg>`;
  }

  /**
   * 雷达图 —— 用来一眼看出「这台机器离推荐配置差多少」。
   * @param {string[]} axes 轴名
   * @param {number[]} values 每个轴的达成度 0~100
   */
  function radar(axes, values, opts = {}) {
    const labels = axes || [];
    const size = opts.size || 220;
    const pad = opts.pad || 38;          // 留给轴标签的空间
    const cx = size / 2;
    const cy = size / 2 + 6;
    const r = size / 2 - 34;
    const n = labels.length;
    if (!n) return '<div class="chart-empty">暂无数据</div>';

    const point = (i, ratio) => {
      const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
      return [cx + Math.cos(angle) * r * ratio, cy + Math.sin(angle) * r * ratio];
    };

    const rings = [0.25, 0.5, 0.75, 1].map((ratio) => {
      const pts = labels.map((_, i) => point(i, ratio).map((v) => v.toFixed(1)).join(',')).join(' ');
      return `<polygon points="${pts}" class="radar-ring" />`;
    }).join('');

    const spokes = labels.map((_, i) => {
      const [x, y] = point(i, 1);
      return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" class="radar-spoke" />`;
    }).join('');

    const dataPts = labels.map((_, i) => point(i, Math.max(0, Math.min(1, (Number(values[i]) || 0) / 100))).map((v) => v.toFixed(1)).join(',')).join(' ');
    const dots = labels.map((_, i) => {
      const [x, y] = point(i, Math.max(0, Math.min(1, (Number(values[i]) || 0) / 100)));
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" class="radar-dot" />`;
    }).join('');

    const labelsSvg = labels.map((label, i) => {
      const [x, y] = point(i, 1.16);
      const anchor = Math.abs(x - cx) < 6 ? 'middle' : (x > cx ? 'start' : 'end');
      return `<text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" class="radar-label" text-anchor="${anchor}">${esc(label)}</text>`;
    }).join('');

    // viewBox 左右各留出 pad，轴标签才不会被裁掉
    return `<svg class="chart-radar" viewBox="${-pad} 0 ${size + pad * 2} ${size}" width="${size + pad * 2}" height="${size}" role="img">
      ${rings}${spokes}
      <polygon points="${dataPts}" class="radar-data" />
      ${dots}${labelsSvg}
    </svg>`;
  }

  /**
   * 瀑布图：把一个总量拆成几块，看每块占多少、剩多少。
   * @param {{label:string,value:number,tone?:string}[]} parts
   */
  function waterfall(parts, opts = {}) {
    const list = parts || [];
    const width = opts.width || 320;
    const rowH = opts.rowH || 30;
    const labelW = opts.labelW || 96;
    const valueW = opts.valueW || 64;
    const barW = Math.max(20, width - labelW - valueW - 8);
    const height = list.length * rowH;
    const total = list.reduce((n, p) => n + Math.max(0, Number(p.value) || 0), 0);

    let cursor = 0;
    const rows = list.map((p, i) => {
      const v = Math.max(0, Number(p.value) || 0);
      const w = total > 0 ? (v / total) * barW : 0;
      const y = i * rowH;
      const tone = p.tone ? ` ${p.tone}` : '';
      const row = `<g class="wf-row">
        <text x="0" y="${y + rowH / 2 + 4}" class="bar-label">${esc(p.label)}</text>
        <rect x="${labelW}" y="${y + 6}" width="${barW}" height="${rowH - 14}" rx="4" class="bar-track" />
        <rect x="${(labelW + cursor).toFixed(1)}" y="${y + 6}" width="${w.toFixed(1)}" height="${rowH - 14}" rx="4" class="bar-fill${tone}" />
        <text x="${width}" y="${y + rowH / 2 + 4}" class="bar-value" text-anchor="end">${esc(p.text != null ? p.text : String(v))}</text>
      </g>`;
      cursor += w;
      return row;
    }).join('');

    return `<svg class="chart-wf" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">${rows}</svg>`;
  }

  /**
   * 折线图（带坐标轴与刻度）—— 用来画「随时间变化」的趋势。
   *
   * @param {{label:string, value:number|null, text?:string}[]} points
   * @param {object} opts { width, height, min, max, unit, color }
   */
  function line(points, opts = {}) {
    const list = points || [];
    const width = opts.width || 420;
    const height = opts.height || 150;
    const padL = 44;      // 左边留给数值刻度
    const padR = 10;
    const padT = 10;
    const padB = 24;      // 底下留给时间标签
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;
    const color = opts.color || 'var(--accent)';

    const values = list.map((p) => num(p.value)).filter((v) => v != null);
    if (!values.length) return '<div class="chart-empty">还没有数据</div>';

    const rawMin = opts.min != null ? opts.min : minOf(values);
    const rawMax = opts.max != null ? opts.max : maxOf(values);
    // 上下各留一点余量，线不要贴着边框
    const min = rawMin - (rawMax - rawMin) * 0.1;
    const max = rawMax + (rawMax - rawMin) * 0.1;
    const span = (max - min) || 1;

    const x = (i) => padL + (list.length > 1 ? (i / (list.length - 1)) * plotW : plotW / 2);
    const y = (v) => padT + plotH - ((v - min) / span) * plotH;

    // 刻度线
    const ticks = [0, 0.5, 1].map((t) => {
      const v = min + span * t;
      const yy = y(v);
      return `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${width - padR}" y2="${yy.toFixed(1)}" class="line-grid" />
        <text x="${padL - 6}" y="${(yy + 4).toFixed(1)}" class="line-tick" text-anchor="end">${formatTick(v, opts.unit)}</text>`;
    }).join('');

    // 折线（跳过 null 断点）
    const segs = [];
    let cur = [];
    list.forEach((p, i) => {
      const v = num(p.value);
      if (v == null) { if (cur.length) segs.push(cur); cur = []; return; }
      cur.push([x(i), y(v)]);
    });
    if (cur.length) segs.push(cur);

    const path = segs.filter((s) => s.length > 1)
      .map((s) => `M${s.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join('L')}`).join(' ');
    const area = segs.filter((s) => s.length > 1).map((s) => (
      `M${s[0][0].toFixed(1)},${(padT + plotH).toFixed(1)}`
      + s.map(([px, py]) => `L${px.toFixed(1)},${py.toFixed(1)}`).join('')
      + `L${s[s.length - 1][0].toFixed(1)},${(padT + plotH).toFixed(1)}Z`
    )).join(' ');

    const dots = list.map((p, i) => {
      const v = num(p.value);
      if (v == null) return '';
      return `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" class="line-dot" style="--seg:${esc(color)}">
        <title>${esc(p.label)}：${esc(p.text != null ? p.text : v)}</title></circle>`;
    }).join('');

    // 时间标签：最多显示 4 个，避免挤在一起
    const step = Math.max(1, Math.ceil(list.length / 4));
    const labels = list.map((p, i) => (i % step === 0 || i === list.length - 1)
      ? `<text x="${x(i).toFixed(1)}" y="${height - 6}" class="line-tick" text-anchor="middle">${esc(p.label)}</text>` : '').join('');

    return `<svg class="chart-line" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">
      ${ticks}
      ${area ? `<path d="${area}" class="line-area" style="--seg:${esc(color)}" />` : ''}
      ${path ? `<path d="${path}" class="line-path" style="--seg:${esc(color)}" fill="none" />` : ''}
      ${dots}${labels}
    </svg>`;
  }

  /** 刻度数值：太大了就用 k / M 缩写 */
  function formatTick(v, unit) {
    const n = Math.abs(v) >= 1000 ? Math.round(v) : Math.round(v * 10) / 10;
    return `${n}${unit || ''}`;
  }

  /**
   * 热力图（按日期的通过率）。
   *
   * @param {{date:string, value:number, text?:string}[]} items
   */
  function heatmap(items, opts = {}) {
    const list = items || [];
    if (!list.length) return '<div class="chart-empty">还没有数据</div>';
    const weeks = opts.weeks || 10;
    const cell = opts.cell || 15;
    const gap = opts.gap || 3;
    const padL = 30;
    const padT = 14;
    const width = padL + weeks * (cell + gap);
    const height = padT + 7 * (cell + gap);

    // 按周分组：从周一开始
    const byWeek = new Map();
    for (const it of list) {
      const d = new Date(it.date);
      if (Number.isNaN(d.getTime())) continue;
      const day = (d.getDay() + 6) % 7;             // 周一 = 0
      const week = Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 86400000 / 7);
      if (!byWeek.has(week)) byWeek.set(week, new Array(7).fill(null));
      byWeek.get(week)[day] = it;
    }
    const weeksList = [...byWeek.keys()].sort((a, b) => b - a).slice(0, weeks);
    const firstWeek = weeksList.length ? weeksList[weeksList.length - 1] : 0;

    let cells = '';
    let lastMonth = -1;
    weeksList.forEach((week, wi) => {
      const dayArr = byWeek.get(week) || [];
      for (let d = 0; d < 7; d++) {
        const it = dayArr[d];
        const x = padL + (weeks - 1 - wi) * (cell + gap);
        const y = padT + d * (cell + gap);
        if (!it) {
          cells += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3" class="hm-cell none" />`;
          continue;
        }
        const v = Math.max(0, Math.min(100, Number(it.value) || 0));
        const level = v >= 90 ? 4 : v >= 75 ? 3 : v >= 50 ? 2 : 1;
        const dt = new Date(it.date);
        const month = dt.getMonth();
        if (d === 0 && month !== lastMonth) {
          cells += `<text x="${x}" y="${padT - 4}" class="hm-month">${dt.getMonth() + 1}月</text>`;
          lastMonth = month;
        }
        cells += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3" class="hm-cell l${level}">
          <title>${esc((it.text || dt.toLocaleDateString()) + ' · ' + Math.round(v) + '%')}</title></rect>`;
      }
    });

    const legend = [0, 1, 2, 3, 4].map((l) => `<rect x="${padL + l * 16}" y="${height + 6}" width="12" height="12" rx="3" class="hm-cell l${l}" />`).join('');
    return `<svg class="chart-heat" viewBox="0 0 ${width} ${height + 24}" width="${width}" height="${height + 24}" role="img">
      ${cells}
      ${legend}
      <text x="${padL + 5 * 16 + 6}" y="${height + 16}" class="hm-legend-tx">低</text>
      <text x="${width - 6}" y="${height + 16}" class="hm-legend-tx" text-anchor="end">高</text>
    </svg>`;
  }

  /**
   * 环形进度（用在一个比例上）。
   */
  function ring(percent, opts = {}) {
    const size = opts.size || 120;
    const thickness = opts.thickness || 12;
    const pct = Math.max(0, Math.min(100, Number(percent) || 0));
    const r = (size - thickness) / 2;
    const cx = size / 2;
    const cy = size / 2;
    const c = 2 * Math.PI * r;
    const level = pct >= 90 ? 'err' : pct >= 70 ? 'warn' : '';
    return `<svg class="chart-ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${Math.round(pct)}%">
      <circle cx="${cx}" cy="${cy}" r="${r}" class="ring-track" fill="none" stroke-width="${thickness}" />
      <circle cx="${cx}" cy="${cy}" r="${r}" class="ring-fill ${level}" fill="none" stroke-width="${thickness}"
        stroke-linecap="round" stroke-dasharray="${(c * pct / 100).toFixed(1)} ${c.toFixed(1)}"
        transform="rotate(-90 ${cx} ${cy})" />
      <text x="${cx}" y="${cy - 2}" class="ring-value" text-anchor="middle">${Math.round(pct)}<tspan class="ring-unit">%</tspan></text>
      ${opts.label ? `<text x="${cx}" y="${cy + 16}" class="ring-label" text-anchor="middle">${esc(opts.label)}</text>` : ''}
    </svg>`;
  }

  return { sparkline, donut, gauge, bars, radar, waterfall, line, heatmap, ring, esc };
})();

window.Chart = Chart;
