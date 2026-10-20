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
      const tone = it.tone ? ` ${it.tone}` : '';
      return `<g class="bar-row">
        <text x="0" y="${y + rowH / 2 + 4}" class="bar-label">${esc(it.label)}</text>
        <rect x="${labelW}" y="${y + 5}" width="${barW}" height="${rowH - 12}" rx="4" class="bar-track" />
        <rect x="${labelW}" y="${y + 5}" width="${w.toFixed(1)}" height="${rowH - 12}" rx="4" class="bar-fill${tone}"${color} />
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

  /* ----------------------------------------------------- 全局悬浮提示
   * 任何带 data-tip 属性的 SVG 元素，鼠标移上去都会浮现一个跟随光标的提示框。
   * 用事件委托，所以新加的图表只要挂上 data-tip 就能用，不用逐个接事件。
   */
  const Tip = (() => {
    let el = null;
    function ensure() {
      if (el) return el;
      if (typeof document === 'undefined' || !document.body) return null;
      el = document.createElement('div');
      el.className = 'chart-tip';
      el.setAttribute('role', 'tooltip');
      el.hidden = true;
      document.body.appendChild(el);
      document.addEventListener('mouseover', (e) => {
        const t = e.target.closest && e.target.closest('[data-tip]');
        if (t) { el.innerHTML = t.getAttribute('data-tip'); el.hidden = false; }
      });
      document.addEventListener('mousemove', (e) => {
        if (el.hidden) return;
        let x = e.clientX + 14, y = e.clientY + 14;
        const w = el.offsetWidth || 160, h = el.offsetHeight || 40;
        if (x + w > window.innerWidth - 8) x = e.clientX - w - 14;
        if (y + h > window.innerHeight - 8) y = e.clientY - h - 14;
        el.style.left = x + 'px';
        el.style.top = y + 'px';
      });
      document.addEventListener('mouseout', (e) => {
        const t = e.target.closest && e.target.closest('[data-tip]');
        if (t) el.hidden = true;
      });
      return el;
    }
    return { ensure };
  })();

  /**
   * 多序列面积图（叠加）—— 把几条「随时间变化」的线叠在一起看相关性。
   * 首页系统负载（显存 / CPU / 内存历史）就是用它。
   *
   * @param {{labels:string[], series:{name:string,color?:string,data:(number|null)[]}[]}} series
   */
  function areaMulti(series, opts = {}) {
    const labels = series.labels || [];
    const list = series.series || [];
    if (!labels.length || !list.length) return '<div class="chart-empty">还没有数据</div>';
    const width = opts.width || 480;
    const height = opts.height || 180;
    const padL = 42, padR = 12, padT = 14, padB = 26;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;
    const all = [];
    for (const s of list) for (const v of (s.data || [])) { const n = num(v); if (n != null) all.push(n); }
    if (!all.length) return '<div class="chart-empty">还没有数据</div>';
    const rawMin = opts.min != null ? opts.min : Math.min(...all);
    const rawMax = opts.max != null ? opts.max : Math.max(...all);
    const min = rawMin - (rawMax - rawMin) * 0.08;
    const max = rawMax + (rawMax - rawMin) * 0.08;
    const span = (max - min) || 1;
    const n = labels.length;
    const X = (i) => padL + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
    const Y = (v) => padT + plotH - ((num(v) - min) / span) * plotH;

    const ticks = [0, 0.5, 1].map((t) => {
      const v = min + span * t;
      const yy = Y(v);
      return `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${width - padR}" y2="${yy.toFixed(1)}" class="am-grid" />
        <text x="${padL - 6}" y="${(yy + 4).toFixed(1)}" class="am-tick" text-anchor="end">${formatTick(v, opts.unit)}</text>`;
    }).join('');

    const drawn = list.map((s, si) => {
      const color = s.color || `var(--chart-${(si % 6) + 1})`;
      const segs = []; let cur = [];
      s.data.forEach((v, i) => {
        const nn = num(v);
        if (nn == null) { if (cur.length) segs.push(cur); cur = []; return; }
        cur.push([X(i), Y(nn)]);
      });
      if (cur.length) segs.push(cur);
      const linePath = segs.filter((x) => x.length > 1)
        .map((x) => `M${x.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join('L')}`).join(' ');
      const areaPath = segs.filter((x) => x.length > 1).map((x) =>
        `M${x[0][0].toFixed(1)},${(padT + plotH).toFixed(1)}`
        + x.map(([px, py]) => `L${px.toFixed(1)},${py.toFixed(1)}`).join('')
        + `L${x[x.length - 1][0].toFixed(1)},${(padT + plotH).toFixed(1)}Z`).join(' ');
      const dots = s.data.map((v, i) => {
        const nn = num(v); if (nn == null) return '';
        return `<circle cx="${X(i).toFixed(1)}" cy="${Y(nn).toFixed(1)}" r="2.6" class="am-dot" style="--seg:${esc(color)}"
          data-tip="${esc(s.name)} · ${esc(labels[i] || '')}：${esc(v)}${opts.unit || ''}" />`;
      }).join('');
      return `<path d="${areaPath}" class="am-area" style="--seg:${esc(color)}" />
        <path d="${linePath}" class="am-line" style="--seg:${esc(color)}" fill="none" />${dots}`;
    }).join('');

    const step = Math.max(1, Math.ceil(n / 5));
    const xl = labels.map((lb, i) =>
      (i % step === 0 || i === n - 1)
        ? `<text x="${X(i).toFixed(1)}" y="${height - 8}" class="am-tick" text-anchor="middle">${esc(lb)}</text>` : '').join('');

    const legend = list.map((s, si) =>
      `<span class="am-lg"><i style="background:${esc(s.color || `var(--chart-${(si % 6) + 1})`)}"></i>${esc(s.name)}</span>`).join('');

    return `<div class="chart-am"><svg class="chart-area" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">
      ${ticks}${drawn}${xl}</svg><div class="am-legend">${legend}</div></div>`;
  }

  /**
   * 气泡图 —— 二维 + 半径三维。用来一眼看出「体积 / 速度 / 参数量」的关系。
   * 模型对比页的适配度气泡图就是用这个。
   *
   * @param {{x:number,y:number,r:number,label?:string,color?:string}[]} items
   */
  function bubble(items, opts = {}) {
    const list = items || [];
    if (!list.length) return '<div class="chart-empty">还没有数据</div>';
    const width = opts.width || 460, height = opts.height || 280;
    const padL = 46, padR = 14, padT = 16, padB = 34;
    const plotW = width - padL - padR, plotH = height - padT - padB;
    const xs = list.map((i) => num(i.x)).filter((v) => v != null);
    const ys = list.map((i) => num(i.y)).filter((v) => v != null);
    const rs = list.map((i) => num(i.r)).filter((v) => v != null);
    if (!xs.length || !ys.length) return '<div class="chart-empty">还没有数据</div>';
    const xmin = opts.xmin != null ? opts.xmin : Math.min(...xs);
    const xmax = opts.xmax != null ? opts.xmax : Math.max(...xs);
    const ymin = opts.ymin != null ? opts.ymin : Math.min(...ys);
    const ymax = opts.ymax != null ? opts.ymax : Math.max(...ys);
    const rmax = Math.max(1, ...rs);
    const xspan = (xmax - xmin) || 1, yspan = (ymax - ymin) || 1;
    const X = (v) => padL + ((num(v) - xmin) / xspan) * plotW;
    const Y = (v) => padT + plotH - ((num(v) - ymin) / yspan) * plotH;
    const R = (v) => 6 + (num(v) / rmax) * 28;

    const yTicks = [0, 0.5, 1].map((t) => {
      const v = ymin + yspan * t, yy = Y(v);
      return `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${width - padR}" y2="${yy.toFixed(1)}" class="am-grid" />
        <text x="${padL - 6}" y="${(yy + 4).toFixed(1)}" class="am-tick" text-anchor="end">${formatTick(v, opts.yunit)}</text>`;
    }).join('');
    const xTicks = [0, 0.5, 1].map((t) => {
      const v = xmin + xspan * t, xx = X(v);
      return `<line x1="${xx.toFixed(1)}" y1="${padT}" x2="${xx.toFixed(1)}" y2="${padT + plotH}" class="am-grid-v" />
        <text x="${xx.toFixed(1)}" y="${height - 12}" class="am-tick" text-anchor="middle">${formatTick(v, opts.xunit)}</text>`;
    }).join('');

    const circles = list.map((it, i) => {
      const c = it.color || `var(--chart-${(i % 6) + 1})`;
      const rr = R(it.r);
      const cx = X(it.x).toFixed(1), cy = Y(it.y).toFixed(1);
      return `<circle cx="${cx}" cy="${cy}" r="${rr.toFixed(1)}" class="bb-circle" style="--seg:${esc(c)}"
          data-tip="${esc(it.label || '')} · ${esc(opts.xLabel || 'X')}:${esc(it.x)}${opts.xunit || ''} · ${esc(opts.yLabel || 'Y')}:${esc(it.y)}${opts.yunit || ''} · ${esc(opts.rLabel || 'R')}:${esc(it.r)}" />
        ${it.label ? `<text x="${cx}" y="${(Y(it.y) + rr + 11).toFixed(1)}" class="bb-label" text-anchor="middle">${esc(it.label)}</text>` : ''}`;
    }).join('');

    return `<svg class="chart-bubble" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">
      ${yTicks}${xTicks}${circles}
      <text x="${padL}" y="11" class="bb-axis">${esc(opts.yLabel || '')} ↑</text>
      <text x="${width - padR}" y="${height - 1}" class="bb-axis" text-anchor="end">${esc(opts.xLabel || '')} →</text>
    </svg>`;
  }

  /**
   * 矩形树图（一维切片）—— 按数值比例把空间切成一条条。
   * 模型管理页的「磁盘占用」用这个，比环形图更能看出谁最占地方。
   *
   * @param {{label:string,value:number,color?:string}[]} items
   */
  function treemap(items, opts = {}) {
    const list = (items || []).filter((i) => Math.max(0, Number(i.value) || 0) > 0);
    if (!list.length) return '<div class="chart-empty">还没有数据</div>';
    const width = opts.width || 420, height = opts.height || 64;
    const total = list.reduce((n, i) => n + Number(i.value), 0);
    let x = 0; const gap = 2;
    const rects = list.map((it, i) => {
      const w = (Number(it.value) / total) * width;
      const rx = x.toFixed(1);
      const c = it.color || `var(--chart-${(i % 6) + 1})`;
      const r = `<g><rect x="${rx}" y="0" width="${Math.max(0, w - gap).toFixed(1)}" height="${height}" rx="3" class="tm-rect"
          style="--seg:${esc(c)}" data-tip="${esc(it.label)} · ${esc(it.value)}${opts.unit || ''}（${Math.round((Number(it.value) / total) * 100)}%）" />
        ${w > 56 ? `<text x="${(x + w / 2).toFixed(1)}" y="${height / 2 + 4}" class="tm-label" text-anchor="middle">${esc(it.label)}</text>` : ''}</g>`;
      x += w;
      return r;
    }).join('');
    return `<svg class="chart-treemap" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">${rects}</svg>`;
  }

  /**
   * 直方图 —— 把连续量切成几档看分布。模型体积分布就是用这个。
   *
   * @param {{label:string,value:number,color?:string}[]} buckets
   */
  function histogram(buckets, opts = {}) {
    const list = buckets || [];
    if (!list.length) return '<div class="chart-empty">还没有数据</div>';
    const width = opts.width || 420, height = opts.height || 180;
    const padB = 28, padT = 14, padL = 10;
    const plotH = height - padB - padT;
    const max = maxOf(list.map((i) => i.value), 1);
    const n = list.length;
    const slot = width / n;
    const bw = Math.min(slot * 0.7, 42);
    const bars = list.map((b, i) => {
      const v = Math.max(0, Number(b.value) || 0);
      const h = max > 0 ? (v / max) * plotH : 0;
      const x = i * slot + (slot - bw) / 2;
      const y = padT + plotH - h;
      const c = b.color || `var(--chart-${(i % 6) + 1})`;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3" class="hm-bar"
          style="--seg:${esc(c)}" data-tip="${esc(b.label)}：${esc(v)}${opts.unit || ''}" />
        <text x="${(x + bw / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" class="hm-bar-v" text-anchor="middle">${esc(v)}</text>
        <text x="${(x + bw / 2).toFixed(1)}" y="${height - 10}" class="hm-tick" text-anchor="middle">${esc(b.label)}</text>`;
    }).join('');
    return `<svg class="chart-hist" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">${bars}</svg>`;
  }

  /**
   * 分组柱状图 —— 每个类目下并排摆几根柱子。
   * 性能基准「本次 vs 历史最佳 vs 平均」、模型体检「各类通过率」都用它。
   *
   * @param {{label:string, bars:{value:number,color?:string,text?:string,tone?:string}[]}[]} groups
   */
  function barGrouped(groups, opts = {}) {
    const list = groups || [];
    if (!list.length) return '<div class="chart-empty">还没有数据</div>';
    const width = opts.width || 460, height = opts.height || 200;
    const padB = 30, padT = 14, padL = 10;
    const plotH = height - padB - padT;
    const max = maxOf(list.flatMap((g) => (g.bars || []).map((b) => Number(b.value) || 0)), 1);
    const n = list.length;
    const groupW = width / n;
    const barsPerGroup = Math.max(1, ...list.map((g) => (g.bars || []).length));
    const bw = Math.min((groupW * 0.8) / barsPerGroup, 34);
    const gap = 4;
    const drawn = list.map((g, gi) => {
      const bars = g.bars || [];
      const totalBarsW = bars.length * bw + (bars.length - 1) * gap;
      const gx = gi * groupW + (groupW - totalBarsW) / 2;
      const inner = bars.map((b, bi) => {
        const v = Math.max(0, Number(b.value) || 0);
        const h = max > 0 ? (v / max) * plotH : 0;
        const x = gx + bi * (bw + gap);
        const y = padT + plotH - h;
        const c = b.color || `var(--chart-${(bi % 6) + 1})`;
        const tone = b.tone ? ` ${b.tone}` : '';
        return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3" class="gb-bar${tone}"
            style="--seg:${esc(c)}" data-tip="${esc(g.label)} · ${esc(b.text || b.label || '')}：${esc(v)}${opts.unit || ''}" />
          ${b.text != null ? `<text x="${(x + bw / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" class="gb-v" text-anchor="middle">${esc(b.text)}</text>` : ''}`;
      }).join('');
      const lbl = `<text x="${(gi * groupW + groupW / 2).toFixed(1)}" y="${height - 10}" class="gb-tick" text-anchor="middle">${esc(g.label)}</text>`;
      return inner + lbl;
    }).join('');
    return `<svg class="chart-grouped" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">${drawn}</svg>`;
  }

  /**
   * 雷达图（多数据集叠加）—— 把「当前」和「推荐」两套维度叠一起比。
   *
   * @param {string[]} axes 轴名
   * @param {{values:number[],color?:string,label?:string}[]} datasets
   */
  function radarMulti(axes, datasets, opts = {}) {
    const labels = axes || [];
    const size = opts.size || 220;
    const pad = opts.pad || 38;
    const cx = size / 2, cy = size / 2 + 6, r = size / 2 - 34;
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
    const polys = (datasets || []).map((ds, di) => {
      const color = ds.color || `var(--chart-${(di % 6) + 1})`;
      const vals = ds.values || [];
      const pts = labels.map((_, i) =>
        point(i, Math.max(0, Math.min(1, (Number(vals[i]) || 0) / 100))).map((v) => v.toFixed(1)).join(',')).join(' ');
      const dots = labels.map((_, i) => {
        const [x, y] = point(i, Math.max(0, Math.min(1, (Number(vals[i]) || 0) / 100)));
        return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.4" class="radar-dot" style="--seg:${esc(color)}" />`;
      }).join('');
      const cls = di === 0 ? 'radar-data' : 'radar-data2';
      return `<polygon points="${pts}" class="${cls}" style="--seg:${esc(color)}" data-tip="${esc(ds.label || '')}" />${dots}`;
    }).join('');
    const labelsSvg = labels.map((label, i) => {
      const [x, y] = point(i, 1.16);
      const anchor = Math.abs(x - cx) < 6 ? 'middle' : (x > cx ? 'start' : 'end');
      return `<text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" class="radar-label" text-anchor="${anchor}">${esc(label)}</text>`;
    }).join('');
    const legend = (datasets || []).length > 1
      ? `<div class="radar-legend">${(datasets || []).map((ds, di) =>
        `<span class="am-lg"><i style="background:${esc(ds.color || `var(--chart-${(di % 6) + 1})`)}"></i>${esc(ds.label || '')}</span>`).join('')}</div>`
      : '';
    return `<div class="chart-radar-wrap"><svg class="chart-radar" viewBox="${-pad} 0 ${size + pad * 2} ${size}" width="${size + pad * 2}" height="${size}" role="img">
      ${rings}${spokes}${polys}${labelsSvg}</svg>${legend}</div>`;
  }

  /**
   * 子弹图（bullet）—— 一根横条 + 目标刻度线 + 分段背景。
   *
   * 「实际值 vs 目标 vs 上限」一张图说完，比仪表盘更省地方。
   * 显存用量 vs 上限、上下文预算 vs 压力上限都用它。
   *
   * @param {{label:string, value:number, target?:number, max?:number, unit?:string, text?:string}[]} items
   */
  function bullet(items, opts = {}) {
    const list = (items || []).filter((i) => i && Number(i.value) >= 0);
    if (!list.length) return '<div class="chart-empty">还没有数据</div>';
    const width = opts.width || 460;
    const rowH = opts.rowH || 34, padL = opts.padL || 96, padR = 16, padT = 6;
    const height = padT * 2 + list.length * rowH;
    const gMax = maxOf(list.map((i) => Math.max(Number(i.value) || 0, Number(i.target) || 0, Number(i.max) || 0)), 1);
    const scale = (v) => (gMax > 0 ? (Number(v) / gMax) * (width - padL - padR) : 0);
    const rows = list.map((it, i) => {
      const y = padT + i * rowH;
      const barH = 16;
      const by = y + (rowH - barH) / 2;
      const w = scale(it.value);
      const c = it.color || `var(--chart-${(i % 6) + 1})`;
      const over = it.max != null && Number(it.value) > Number(it.max);
      const tgtX = it.target != null ? padL + scale(it.target) : null;
      const segs = [40, 70, 100].map((p) => {
        const x0 = padL + scale((gMax * p) / 100);
        const cls = p === 40 ? 'bl-lo' : p === 70 ? 'bl-mid' : 'bl-hi';
        return `<rect x="${x0.toFixed(1)}" y="${by.toFixed(1)}" width="${(scale((gMax * 30) / 100)).toFixed(1)}" height="${barH}" class="bl-band ${cls}" />`;
      }).join('');
      const label = `<text x="${padL - 10}" y="${by + barH / 2 + 4}" class="bl-label" text-anchor="end">${esc(it.label)}</text>`;
      const bar = `<rect x="${padL}" y="${by.toFixed(1)}" width="${w.toFixed(1)}" height="${barH}" rx="3" class="bl-bar${over ? ' over' : ''}"
          style="--seg:${esc(c)}" data-tip="${esc(it.label)}：${esc(it.text || it.value)}${esc(it.unit || opts.unit || '')}${it.target != null ? `（目标 ${it.target}${esc(it.unit || opts.unit || '')}）` : ''}" />`;
      const tgt = tgtX != null
        ? `<line x1="${tgtX.toFixed(1)}" y1="${(by - 3).toFixed(1)}" x2="${tgtX.toFixed(1)}" y2="${(by + barH + 3).toFixed(1)}" class="bl-target" />`
        : '';
      const val = `<text x="${(padL + w + 6).toFixed(1)}" y="${by + barH / 2 + 4}" class="bl-val">${esc(it.text || it.value)}${esc(it.unit || opts.unit || '')}</text>`;
      return label + segs + bar + tgt + val;
    }).join('');
    return `<svg class="chart-bullet" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">${rows}</svg>`;
  }

  /**
   * 堆叠横条 —— 一条条横着的 100% 占比条。
   * 「这块盘被谁占了」「各模型空间占比」用它最直观，比饼图好读。
   *
   * @param {{label:string, segments:{value:number,label?:string,color?:string}[]}[]} items
   */
  function stackedBar(items, opts = {}) {
    const list = items || [];
    if (!list.length) return '<div class="chart-empty">还没有数据</div>';
    const width = opts.width || 460;
    const rowH = opts.rowH || 30, padL = opts.padL || 96, padR = 14, padT = 4;
    const height = padT * 2 + list.length * rowH;
    const barH = opts.barH || 18;
    const rows = list.map((it, i) => {
      const segs = it.segments || [];
      const total = segs.reduce((n, s) => n + (Number(s.value) || 0), 0) || 1;
      const y = padT + i * rowH;
      const by = y + (rowH - barH) / 2;
      const avail = width - padL - padR;
      let x = padL;
      const bars = segs.map((s, si) => {
        const v = Number(s.value) || 0;
        const w = (v / total) * avail;
        const c = s.color || `var(--chart-${(si % 6) + 1})`;
        const rect = `<rect x="${x.toFixed(1)}" y="${by.toFixed(1)}" width="${Math.max(0, w).toFixed(1)}" height="${barH}" class="sb-seg"
            style="--seg:${esc(c)}" data-tip="${esc(it.label)} · ${esc(s.label || '')}：${esc(v)}（${Math.round((v / total) * 100)}%）" />`;
        x += w;
        return rect;
      }).join('');
      const label = `<text x="${padL - 10}" y="${by + barH / 2 + 4}" class="sb-label" text-anchor="end">${esc(it.label)}</text>`;
      const tot = `<text x="${width - padR}" y="${by + barH / 2 + 4}" class="sb-total" text-anchor="end">${esc(total)}${esc(opts.unit || '')}</text>`;
      return label + bars + tot;
    }).join('');
    const legend = opts.legend !== false && (list[0].segments || []).length > 1
      ? `<div class="am-legend">${(list[0].segments || []).map((s, si) =>
        `<span class="am-lg"><i style="background:${esc(s.color || `var(--chart-${(si % 6) + 1})`)}"></i>${esc(s.label || '')}</span>`).join('')}</div>`
      : '';
    return `<div class="chart-sb">${`<svg class="chart-stacked" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">${rows}</svg>`}${legend}</div>`;
  }

  /**
   * 漏斗图 —— 每一步一条居中横条，宽度按占首步的比例。
   * 「装完向导的人有多少走到最后一步」这类逐级流失的场景。
   *
   * @param {{label:string, value:number, text?:string}[]} steps
   */
  function funnel(steps, opts = {}) {
    const list = (steps || []).filter((s) => s && Number(s.value) > 0);
    if (!list.length) return '<div class="chart-empty">还没有数据</div>';
    const width = opts.width || 460;
    const rowH = opts.rowH || 34, padT = 6;
    const height = padT * 2 + list.length * rowH;
    const top = maxOf(list.map((s) => Number(s.value) || 0), 1);
    const rows = list.map((s, i) => {
      const v = Number(s.value) || 0;
      const w = (v / top) * (width - 20);
      const x = (width - w) / 2;
      const y = padT + i * rowH;
      const c = s.color || `var(--chart-${(i % 6) + 1})`;
      const pct = Math.round((v / top) * 100);
      const prev = i > 0 ? (Number(list[i - 1].value) || 0) : 0;
      const drop = i > 0 && prev > 0 ? Math.round(((prev - v) / prev) * 100) : 0;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${rowH - 10}" rx="4" class="fn-seg"
          style="--seg:${esc(c)}" data-tip="${esc(s.label)}：${esc(s.text || v)}${esc(opts.unit || '')}（${pct}%）${drop ? ` · 上一步流失 ${drop}%` : ''}" />
        <text x="${width / 2}" y="${(y + (rowH - 10) / 2 + 4).toFixed(1)}" class="fn-v" text-anchor="middle">${esc(s.label)} · ${esc(s.text || v)}</text>
        <text x="${width - 4}" y="${(y + (rowH - 10) / 2 + 4).toFixed(1)}" class="fn-pct" text-anchor="end">${pct}%</text>`;
    }).join('');
    return `<svg class="chart-funnel" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">${rows}</svg>`;
  }

  /**
   * 矩阵热力表 —— 行 × 列的网格，格子颜色深浅表示数值。
   * 「模型 × 能力」「磁盘 × 指标」这种二维对照。
   *
   * @param {{row:string, cells:{value:number, text?:string, tone?:string}[]}[]} rows
   */
  function matrix(rowsIn, opts = {}) {
    const rows = (rowsIn || []).filter((r) => r && r.cells && r.cells.length);
    if (!rows.length) return '<div class="chart-empty">还没有数据</div>';
    const width = opts.width || 460;
    const rowH = opts.rowH || 28, padL = opts.padL || 110, padT = 26, padR = 10;
    const cols = Math.max(...rows.map((r) => r.cells.length));
    const height = padT + rows.length * rowH + padR;
    const cellW = (width - padL - padR) / cols;
    const all = rows.flatMap((r) => r.cells.map((c) => Number(c.value) || 0));
    const mx = maxOf(all, 1), mn = minOf(all, 0);
    const alpha = (v) => (mx > mn ? 0.12 + ((v - mn) / (mx - mn)) * 0.88 : 0.5);
    const head = (opts.cols || []).slice(0, cols).map((c, i) =>
      `<text x="${(padL + i * cellW + cellW / 2).toFixed(1)}" y="${padT - 9}" class="mx-head" text-anchor="middle">${esc(c)}</text>`).join('');
    const body = rows.map((r, ri) => {
      const y = padT + ri * rowH;
      const cells = r.cells.slice(0, cols).map((c, ci) => {
        const v = Number(c.value) || 0;
        const x = padL + ci * cellW;
        const tone = c.tone ? ` ${c.tone}` : '';
        return `<rect x="${(x + 1).toFixed(1)}" y="${(y + 1).toFixed(1)}" width="${(cellW - 2).toFixed(1)}" height="${rowH - 2}" rx="3"
            class="mx-cell${tone}" style="--a:${alpha(v).toFixed(2)}" data-tip="${esc(r.row)} · ${esc((opts.cols || [])[ci] || '')}：${esc(c.text != null ? c.text : v)}" />
          <text x="${(x + cellW / 2).toFixed(1)}" y="${(y + rowH / 2 + 4).toFixed(1)}" class="mx-v" text-anchor="middle">${esc(c.text != null ? c.text : v)}</text>`;
      }).join('');
      return `<text x="${padL - 8}" y="${(y + rowH / 2 + 4).toFixed(1)}" class="mx-label" text-anchor="end">${esc(r.row)}</text>` + cells;
    }).join('');
    return `<svg class="chart-matrix" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">${head}${body}</svg>`;
  }

  /**
   * 时间轴 / 甘特 —— 每个条目一段起止横条。
   * 「下载队列谁在排队、各自等多久」「服务跑了多长时间」。
   *
   * @param {{label:string, start:number, end:number, color?:string, text?:string}[]} items
   */
  function timeline(items, opts = {}) {
    const list = (items || []).filter((i) => i && Number.isFinite(Number(i.start)));
    if (!list.length) return '<div class="chart-empty">还没有数据</div>';
    const width = opts.width || 460;
    const rowH = opts.rowH || 26, padL = opts.padL || 96, padR = 14, padT = 18, padB = 20;
    const height = padT + list.length * rowH + padB;
    const lo = minOf(list.map((i) => Number(i.start)), 0);
    const hi = maxOf(list.map((i) => Math.max(Number(i.end) || 0, Number(i.start))), 1);
    const span = hi - lo || 1;
    const avail = width - padL - padR;
    const px = (v) => padL + ((Number(v) - lo) / span) * avail;
    const ticks = 4;
    const axis = Array.from({ length: ticks + 1 }, (_, i) => {
      const v = lo + (span * i) / ticks;
      const x = px(v);
      return `<line x1="${x.toFixed(1)}" y1="${padT - 6}" x2="${x.toFixed(1)}" y2="${height - padB + 2}" class="tl-grid" />
        <text x="${x.toFixed(1)}" y="${height - 6}" class="tl-tick" text-anchor="middle">${esc(fmtDur(v - lo))}</text>`;
    }).join('');
    const rows = list.map((it, i) => {
      const s = Number(it.start), e = Math.max(Number(it.end) || s, s);
      const x0 = px(s), x1 = px(e);
      const y = padT + i * rowH;
      const c = it.color || `var(--chart-${(i % 6) + 1})`;
      const dur = fmtDur(e - s);
      return `<text x="${padL - 8}" y="${(y + rowH / 2 + 4).toFixed(1)}" class="tl-label" text-anchor="end">${esc(it.label)}</text>
        <rect x="${x0.toFixed(1)}" y="${(y + 3).toFixed(1)}" width="${Math.max(2, x1 - x0).toFixed(1)}" height="${rowH - 10}" rx="3" class="tl-bar"
          style="--seg:${esc(c)}" data-tip="${esc(it.label)}：${esc(it.text || dur)}" />`;
    }).join('');
    return `<svg class="chart-timeline" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">${axis}${rows}</svg>`;
  }

  function fmtDur(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}秒`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}分${s % 60 ? `${s % 60}秒` : ''}`;
    const h = Math.floor(m / 60);
    return `${h}时${m % 60 ? `${m % 60}分` : ''}`;
  }

  /**
   * KPI 卡片组 —— 一行数据卡，每张带大数字、副标题和迷你趋势线。
   * 概览页顶部放一排，比四个仪表盘更快读到重点。
   *
   * @param {{label:string, value:string|number, sub?:string, unit?:string, trend?:number[], tone?:string, icon?:string}[]} items
   */
  function kpiCards(items, opts = {}) {
    const list = (items || []).filter(Boolean);
    if (!list.length) return '<div class="chart-empty">还没有数据</div>';
    const cards = list.map((it, i) => {
      const tone = it.tone ? ` ${it.tone}` : '';
      const spark = Array.isArray(it.trend) && it.trend.length > 1
        ? `<div class="kpi-spark">${sparkline(it.trend, { width: 92, height: 26, color: it.color || `var(--chart-${(i % 6) + 1})` })}</div>`
        : '';
      const delta = Array.isArray(it.trend) && it.trend.length > 1
        ? (() => {
          const a = it.trend[0], b = it.trend[it.trend.length - 1];
          const d = b - a;
          if (!isFinite(d) || d === 0) return '';
          const cls = d > 0 ? 'up' : 'down';
          const arrow = d > 0 ? '▲' : '▼';
          return `<span class="kpi-delta ${cls}">${arrow} ${Math.abs(Math.round(d * 10) / 10)}</span>`;
        })()
        : '';
      return `<div class="kpi-card${tone}">
        <div class="kpi-top"><span class="kpi-label">${it.icon ? `${esc(it.icon)} ` : ''}${esc(it.label)}</span>${delta}</div>
        <div class="kpi-value">${esc(it.value)}${it.unit ? `<span class="kpi-unit">${esc(it.unit)}</span>` : ''}</div>
        ${it.sub ? `<div class="kpi-sub">${esc(it.sub)}</div>` : ''}
        ${spark}
      </div>`;
    }).join('');
    return `<div class="kpi-row${opts.compact ? ' compact' : ''}">${cards}</div>`;
  }

  /**
   * 斜率图 —— 左右两列各一个点，中间连线，一眼看出「涨了还是跌了」。
   * 「上次 vs 本次」这种两时点对比，比表格好懂得多。
   *
   * @param {{label:string, before:number, after:number, beforeText?:string, afterText?:string, invert?:boolean}[]} items
   */
  function slope(items, opts = {}) {
    const list = (items || []).filter((i) => i && Number.isFinite(Number(i.before)) && Number.isFinite(Number(i.after)));
    if (!list.length) return '<div class="chart-empty">还没有数据</div>';
    const width = opts.width || 460;
    const padT = 16, padB = 30, padL = 92, padR = 92;
    const plotH = opts.height || 200;
    const height = plotH + padT + padB;
    const all = list.flatMap((i) => [Number(i.before), Number(i.after)]);
    const mx = maxOf(all, 1), mn = minOf(all, 0);
    const span = mx - mn || 1;
    const y = (v) => padT + plotH - ((Number(v) - mn) / span) * plotH;
    const grid = [0, 0.5, 1].map((p) => {
      const gy = padT + plotH - p * plotH;
      return `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${width - padR}" y2="${gy.toFixed(1)}" class="sl-grid" />`;
    }).join('');
    const rows = list.map((it, i) => {
      const b = Number(it.before), a = Number(it.after);
      const better = it.invert ? b > a : a > b;
      const worse = it.invert ? a > b : b > a;
      const tone = better ? ' good' : worse ? ' bad' : '';
      const c = it.color || `var(--chart-${(i % 6) + 1})`;
      const y0 = y(b), y1 = y(a);
      return `<line x1="${padL}" y1="${y0.toFixed(1)}" x2="${width - padR}" y2="${y1.toFixed(1)}" class="sl-line${tone}" stroke="${esc(c)}"
          data-tip="${esc(it.label)}：${esc(it.beforeText || b)} → ${esc(it.afterText || a)}" />
        <circle cx="${padL}" cy="${y0.toFixed(1)}" r="4.5" fill="${esc(c)}" />
        <circle cx="${width - padR}" cy="${y1.toFixed(1)}" r="4.5" fill="${esc(c)}" />
        <text x="${padL - 8}" y="${(y0 + 4).toFixed(1)}" class="sl-v" text-anchor="end">${esc(it.beforeText || b)}</text>
        <text x="${width - padR + 8}" y="${(y1 + 4).toFixed(1)}" class="sl-v ${better ? 'good' : worse ? 'bad' : ''}">${esc(it.afterText || a)}</text>`;
    }).join('');
    const labels = list.map((it, i) => {
      const mid = (y(it.before) + y(it.after)) / 2;
      return `<text x="${width / 2}" y="${(mid + 4).toFixed(1)}" class="sl-label" text-anchor="middle">${esc(it.label)}</text>`;
    }).join('');
    const heads = `<text x="${padL}" y="10" class="mx-head" text-anchor="start">${esc(opts.beforeLabel || '之前')}</text>
      <text x="${width - padR}" y="10" class="mx-head" text-anchor="end">${esc(opts.afterLabel || '现在')}</text>`;
    return `<svg class="chart-slope" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">${grid}${heads}${rows}${labels}</svg>`;
  }

  Tip.ensure();

  return {
    sparkline, donut, gauge, bars, radar, radarMulti, waterfall, line, heatmap, ring,
    areaMulti, bubble, treemap, histogram, barGrouped,
    bullet, stackedBar, funnel, matrix, timeline, kpiCards, slope,
    tip: Tip.ensure, esc, fmtDur,
  };
})();

window.Chart = Chart;
