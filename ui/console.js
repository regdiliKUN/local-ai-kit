/* 本地 AI 控制台 —— 前端逻辑 */

const $ = (id) => document.getElementById(id);

async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-LocalAI-Token': window.__TOKEN__ || '' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await r.json(); } catch { /* 无内容 */ }
  if (r.status === 429) throw new Error('操作太频繁了，等几秒再试');
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${Math.round(n)} B`;
}

function fmtEta(sec) {
  const s = Math.round(sec);
  if (!Number.isFinite(s) || s <= 0) return '';
  if (s < 60) return `约 ${s} 秒`;
  if (s < 3600) return `约 ${Math.round(s / 60)} 分`;
  return `约 ${Math.floor(s / 3600)} 小时 ${Math.round((s % 3600) / 60)} 分`;
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
}

/** 常见模型的快捷按钮 */
const QUICK = ['qwen3:8b', 'qwen2.5:7b', 'qwen3:14b', 'qwen2.5:14b', 'qwen3:32b'];

let state = null;

/* ------------------------------------------------------------------ 标签 */

for (const li of document.querySelectorAll('#tabs li')) {
  li.addEventListener('click', () => {
    for (const x of document.querySelectorAll('#tabs li')) x.classList.toggle('active', x === li);
    for (const v of document.querySelectorAll('.view')) v.hidden = true;
    $(`view-${li.dataset.tab}`).hidden = false;
    if (location.hash !== `#${li.dataset.tab}`) history.replaceState(null, '', `#${li.dataset.tab}`);
    window.scrollTo(0, 0);
    // 概览页的数据是「按需拉」的，切过去才拉，省得后台一直跑 nvidia-smi
    if (li.dataset.tab === 'dashboard') loadDashboard().catch(() => {});
  });
}

// 支持 #context / #settings 这种深链，刷新后停在同一个页
{
  const want = (location.hash || '').replace('#', '');
  const hit = want && document.querySelector(`#tabs li[data-tab="${want}"]`);
  if (hit) hit.click();
}

/* ------------------------------------------------------------------ 主题 */

/**
 * 主题：深色 / 浅色 / 跟随系统。
 *
 * 之前只有「跟随系统」，用户在深色系统里被迫看浅色界面（或反过来），
 * 而且每次打开都恢复原样。现在可以手动切，并且记在 localStorage 里。
 */
const THEME_KEY = 'localai-theme';

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'auto') {
    root.removeAttribute('data-theme');
    try { localStorage.removeItem(THEME_KEY); } catch { /* ignore */ }
  } else {
    root.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
  }
}

function currentTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch { return 'auto'; }
}

(function initTheme() {
  const saved = currentTheme();
  if (saved !== 'auto') document.documentElement.setAttribute('data-theme', saved);
})();

/* ------------------------------------------------------- 键盘与无障碍 */

/**
 * 快捷键。
 *   1..8  切换左侧标签页
 *   r     刷新状态
 *   /     聚焦模型搜索框
 *   ?     显示快捷键说明
 */
const KEYMAP = {
  '1': 'dashboard', '2': 'models', '3': 'play', '4': 'bench',
  '5': 'context', '6': 'health', '7': 'fix', '8': 'settings',
};

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

  if (KEYMAP[e.key]) {
    const li = document.querySelector(`#tabs li[data-tab="${KEYMAP[e.key]}"]`);
    if (li) { li.click(); e.preventDefault(); }
    return;
  }
  if (e.key === 'r' || e.key === 'R') { loadState().catch(() => {}); e.preventDefault(); }
  if (e.key === '/') { const s = $('modelSearch'); if (s) { s.focus(); e.preventDefault(); } }
  if (e.key === '?') { toast('快捷键：1-8 切换页面 · R 刷新 · / 搜索'); }
});

/* ------------------------------------------------------------------ 状态 */

async function loadState() {
  state = await (await fetch('/api/state')).json();
  renderStatus();
  renderModels();
  renderSettings();
  renderConfig();
  await loadContext();
  renderQueue(state.queue);
  playModels();
  benchModels();
  // 测速结果也放在 /api/state 里 —— SSE 断了也能拿到结果，界面不会卡在「测速中」
  if (state.bench && state.bench.verdict && (!benchShownAt || state.bench.at !== benchShownAt)) {
    benchShownAt = state.bench.at;
    renderBench(state.bench);
    $('benchWrap').hidden = true;
  }
  if (state.health && state.health.verdicts && (!healthShownAt || state.health.at !== healthShownAt)) {
    healthShownAt = state.health.at;
    renderHealthResult(state.health, (state.health.verdicts || []).every((v) => v.ok));
  }
  // 空间统计和能力标签比较重，不要每 5 秒都重算一遍
  if (Date.now() - lastHeavyAt > 30000) {
    lastHeavyAt = Date.now();
    loadSpace().catch(() => {});
    loadCaps();
  }
}

let lastHeavyAt = 0;
let benchShownAt = 0;
let healthShownAt = 0;

/* ------------------------------------------------------------- 系统概览 */

let dashTimer = null;
let dashOn = true;

function fmtGB(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n} GB`;
}

async function loadDashboard() {
  let data;
  try {
    data = await (await fetch('/api/metrics')).json();
  } catch (e) {
    $('dashStamp').textContent = `读取失败：${e.message}`;
    return;
  }
  const m = data.current || {};
  const h = data.history || {};
  $('dashStamp').textContent = `更新于 ${new Date(m.at || Date.now()).toLocaleTimeString()}`;

  /* ---- 四个仪表盘 ---- */
  const gpu0 = (m.gpu || [])[0];
  const vramPct = gpu0 ? gpu0.memoryPercent : null;
  $('gVram').innerHTML = vramPct == null ? '—' : `${vramPct}<span class="unit">%</span>`;
  $('gVramSub').textContent = gpu0
    ? `${(gpu0.memoryUsedMB / 1024).toFixed(1)} / ${(gpu0.memoryTotalMB / 1024).toFixed(1)} GB`
    : '没有检测到独立显卡';
  $('gVramSpark').innerHTML = Chart.sparkline(h.vram || [], { width: 150, height: 34, min: 0, max: 100 });

  const cpuPct = m.cpu ? m.cpu.usage : null;
  $('gCpu').innerHTML = cpuPct == null ? '—' : `${cpuPct}<span class="unit">%</span>`;
  $('gCpuSub').textContent = m.cpu ? `${m.cpu.model} · ${m.cpu.cores} 核` : '未知';
  $('gCpuSpark').innerHTML = Chart.sparkline(h.cpu || [], { width: 150, height: 34, min: 0, max: 100 });

  const memPct = m.memory ? m.memory.percent : null;
  $('gMem').innerHTML = memPct == null ? '—' : `${memPct}<span class="unit">%</span>`;
  $('gMemSub').textContent = m.memory ? `${fmtGB(m.memory.usedGB)} / ${fmtGB(m.memory.totalGB)}` : '未知';
  $('gMemSpark').innerHTML = Chart.sparkline(h.memory || [], { width: 150, height: 34, min: 0, max: 100 });

  const diskPct = m.disk ? m.disk.usedPercent : null;
  $('gDisk').innerHTML = diskPct == null ? '—' : `${diskPct}<span class="unit">%</span>`;
  $('gDiskSub').textContent = m.disk ? `${m.disk.path} 剩余 ${fmtGB(m.disk.freeGB)} / ${fmtGB(m.disk.totalGB)}` : '未知';
  $('gDiskSpark').innerHTML = Chart.sparkline(h.disk || [], { width: 150, height: 34, min: 0, max: 100 });

  /* ---- 显卡详情 ---- */
  if (!gpu0) {
    $('dashGpu').innerHTML = '<div class="chart-empty">没有检测到独立显卡 —— 模型会跑在 CPU 上，速度会很慢。</div>';
  } else {
    const rows = [
      ['型号', gpu0.name],
      ['驱动', gpu0.driver || '—'],
      ['显存占用', `${(gpu0.memoryUsedMB / 1024).toFixed(1)} / ${(gpu0.memoryTotalMB / 1024).toFixed(1)} GB`],
      ['GPU 占用', gpu0.utilization == null ? '—' : `${gpu0.utilization}%`],
      ['温度', gpu0.temperature == null ? '—' : `${gpu0.temperature} °C`],
      ['功耗', gpu0.powerWatts == null ? '—' : `${gpu0.powerWatts} W`],
    ];
    $('dashGpu').innerHTML =
      `<div class="gpu-head">${Chart.gauge(vramPct || 0, { label: '显存占用' })}</div>` +
      rows.map(([k, v]) => `<div class="row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('');
  }

  /* ---- 正在跑的模型 ---- */
  const running = (m.ollama && m.ollama.models) || [];
  if (!running.length) {
    $('dashModels').innerHTML = '<div class="chart-empty">现在没有模型驻留显存。<br>这说明显存已经全部还给游戏 / 渲染软件了。</div>';
  } else {
    const totalVram = running.reduce((n, r) => n + (r.sizeVramGB || 0), 0);
    $('dashModels').innerHTML = running.map((r) => `
      <div class="mrow">
        <div class="mi">
          <div class="mn">${esc(r.name)}</div>
          <div class="ms">${r.processor ? esc(r.processor) : 'GPU'} · 上下文 ${r.contextLength || '—'}</div>
        </div>
        <div class="mz">${r.sizeVramGB != null ? `${r.sizeVramGB} GB 显存` : `${r.sizeGB} GB`}</div>
      </div>`).join('') +
      `<div class="row" style="padding-top:10px"><span class="k">显存合计</span><span class="v">${totalVram.toFixed(1)} GB</span></div>`;
  }

  /* ---- 机器信息 ---- */
  $('dashSystem').innerHTML = [
    ['CPU', m.cpu ? `${m.cpu.model}（${m.cpu.cores} 核${m.cpu.speedMHz ? ` / ${m.cpu.speedMHz} GHz` : ''}）` : '—'],
    ['内存', m.memory ? `${fmtGB(m.memory.totalGB)} 总 / ${fmtGB(m.memory.freeGB)} 可用` : '—'],
    ['系统盘', m.disk ? `${m.disk.path} · 总 ${fmtGB(m.disk.totalGB)} · 剩余 ${fmtGB(m.disk.freeGB)}` : '—'],
    ['Ollama', m.ollama && m.ollama.up ? `运行中（${m.ollama.version || '版本未知'}）` : '未运行'],
    ['Node.js', m.node ? `${m.node.version} · ${m.node.platform}` : '—'],
  ].map(([k, v]) => `<div class="row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('');
}

function startDashTimer() {
  if (dashTimer) clearInterval(dashTimer);
  dashTimer = null;
  if (dashOn) dashTimer = setInterval(() => loadDashboard().catch(() => {}), 2000);
}

/* 页面在后台时不轮询 —— 省 CPU，也省得把限流器打满 */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (dashTimer) { clearInterval(dashTimer); dashTimer = null; }
  } else {
    startDashTimer();
    loadState().catch(() => {});
  }
});

if ($('dashAuto')) {
  $('dashAuto').addEventListener('change', (e) => {
    dashOn = e.target.checked;
    startDashTimer();
    if (dashOn) loadDashboard();
  });
}
if ($('btnDashRefresh')) $('btnDashRefresh').addEventListener('click', () => loadDashboard());

function renderStatus() {
  const s = state;
  const dot = s.running ? 'ok' : 'warn';
  const free = s.modelDirFreeGB;
  $('statusStrip').innerHTML = `
    <div class="st ${dot}">
      <div class="k">Ollama 服务</div>
      <div class="v">${s.running ? '运行中' : '未运行'}</div>
      <div class="s">${s.running ? '可以正常管理模型' : '加装 / 删除模型时会自动帮你启动'}</div>
    </div>
    <div class="st">
      <div class="k">模型目录</div>
      <div class="v">${esc(s.modelDir || '（未配置）')}</div>
      <div class="s">${free != null ? `剩余 ${free} GB` : '空间未知'}</div>
    </div>
    <div class="st">
      <div class="k">已装模型</div>
      <div class="v">${s.models.length} 个</div>
      <div class="s">共 ${s.models.reduce((n, m) => n + m.sizeGB, 0).toFixed(1)} GB</div>
    </div>`;

  $('sideInfo').innerHTML = s.running
    ? `<b>Ollama 运行中</b><br>${s.models.length} 个模型`
    : '<b>Ollama 未运行</b><br>管理模型时会自动启动';
}

function renderModels() {
  const all = state.models || [];
  const q = ($('modelSearch') && $('modelSearch').value || '').trim().toLowerCase();
  const sort = ($('modelSort') && $('modelSort').value) || 'size';

  let list = all;
  if (q) list = list.filter((m) => m.name.toLowerCase().includes(q));
  list = list.slice().sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name);
    if (sort === 'date') return String(b.modified || '').localeCompare(String(a.modified || ''));
    return b.sizeGB - a.sizeGB;
  });

  const totalSize = all.reduce((n, m) => n + m.sizeGB, 0);
  $('modelCount').textContent = all.length
    ? `（${all.length} 个，共 ${totalSize.toFixed(1)} GB）` : '';
  $('modelFilterCount').textContent = q ? `筛选出 ${list.length} / ${all.length} 个` : '';

  if (!all.length) {
    $('modelList').innerHTML = `<div class="empty">
      <b>还没有装任何模型。</b>
      用下面的「加装新模型」下一个吧 —— 也可以回到安装向导里选。
    </div>`;
    return;
  }
  if (!list.length) {
    $('modelList').innerHTML = `<div class="empty"><b>没有匹配「${esc(q)}」的模型。</b>换个关键字试试。</div>`;
    return;
  }

  $('modelList').innerHTML = list.map((m) => {
    const caps = (state.caps || {})[m.name] || [];
    const tags = [];
    if (caps.includes('vision')) tags.push('看图');
    if (caps.includes('tools')) tags.push('工具调用');
    if (caps.includes('thinking')) tags.push('深度思考');
    return `
    <div class="mrow" data-model="${esc(m.name)}">
      <div class="mi">
        <div class="mn">${esc(m.name)}${tags.map((t) => `<span class="tag">${t}</span>`).join('')}</div>
        <div class="ms">${esc(m.params || '')} ${esc(m.quant || '')}${m.modified ? ' · ' + esc(String(m.modified).slice(0, 10)) : ''}</div>
      </div>
      <div class="mz">${m.sizeGB} GB</div>
      <div class="ma"><button class="btn ghost small danger" data-del="${esc(m.name)}">删除</button></div>
    </div>`;
  }).join('');

  for (const b of document.querySelectorAll('[data-del]')) {
    b.addEventListener('click', () => askDelete(b.dataset.del, b));
  }
}

/** 删除前先在原地确认一次，不用浏览器自带的弹窗 */
function askDelete(model, btn) {
  const row = btn.closest('.mrow');
  const backup = row.innerHTML;
  row.classList.add('confirming');
  row.innerHTML = `
    <div class="mi"><div class="mn">删除 ${esc(model)}？</div>
      <div class="ms">会释放磁盘空间，以后想用需要重新下载。</div></div>
    <div class="ma">
      <button class="btn primary small" id="delYes">确认删除</button>
      <button class="btn ghost small" id="delNo">取消</button>
    </div>`;
  $('delNo').addEventListener('click', () => { row.classList.remove('confirming'); row.innerHTML = backup; renderModels(); });
  $('delYes').addEventListener('click', async () => {
    try {
      showLog(true);
      await post('/api/delete', { model });
    } catch (e) { toast(e.message); }
  });
}

if ($('modelSearch')) {
  $('modelSearch').addEventListener('input', () => renderModels());
}
if ($('modelSort')) {
  $('modelSort').addEventListener('change', () => renderModels());
}

/** 模型能力标签：单独拉一次，失败就不显示标签（不影响主流程） */
async function loadCaps() {
  try {
    const caps = await (await fetch('/api/model-caps')).json();
    state.caps = caps;
    renderModels();
  } catch { /* 拿不到就算了 */ }
}

function renderSettings() {
  $('swAutostart').checked = !!state.settings.autostart;
  $('swLan').checked = !!state.settings.lanShare;
}

/* ------------------------------------------------------------- 空间分析 */

async function loadSpace() {
  const panel = $('spacePanel');
  if (!panel) return;
  let data;
  try {
    data = await (await fetch('/api/space')).json();
  } catch (e) {
    panel.innerHTML = `<div class="issue error">读取失败：${esc(e.message)}</div>`;
    return;
  }
  const p = data.primary || {};
  if (!p.exists) {
    panel.innerHTML = `<div class="empty"><b>还没找到模型目录。</b>${p.dir ? `配置里写的是 <code>${esc(p.dir)}</code>，但这个目录不存在。` : '装好第一个模型后这里会有统计。'}</div>`;
    return;
  }
  if (!p.models.length) {
    panel.innerHTML = `<div class="empty"><b>目录是空的。</b>模型还没下到 <code>${esc(p.dir)}</code>。</div>`;
    return;
  }

  const total = p.models.reduce((n, m) => n + m.sizeGB, 0);
  const segments = p.models.slice(0, 8).map((m, i) => ({
    label: m.name, value: m.sizeGB, color: `var(--chart-${(i % 6) + 1})`,
  }));
  if (p.models.length > 8) {
    segments.push({
      label: `其它 ${p.models.length - 8} 个`,
      value: p.models.slice(8).reduce((n, m) => n + m.sizeGB, 0),
      color: 'var(--chart-6)',
    });
  }

  const legend = p.models.slice(0, 8).map((m, i) => `
    <li><i style="background:var(--chart-${(i % 6) + 1})"></i>
      <span class="lg-name">${esc(m.name)}</span>
      <span class="lg-size">${m.sizeGB} GB</span></li>`).join('');

  const notes = [];
  if (p.orphanGB > 0.05) {
    notes.push(`<div class="issue warn"><div class="issue-main">有 ${p.orphanGB} GB 没有被任何模型引用</div>
      <div class="issue-hint">多半是下载中断留下的碎片。删掉不影响已装的模型，删之前可以先确认一下。</div></div>`);
  }
  if (p.sharedGB > 0.05) {
    notes.push(`<div class="issue info"><div class="issue-main">有 ${p.sharedGB} GB 被多个模型共用</div>
      <div class="issue-hint">这是正常的：微调模型会复用基础模型的部分层，删掉其中一个不会释放这部分空间。</div></div>`);
  }

  const others = (data.others || []).filter((d) => d.models.length);
  const othersHtml = others.length ? `
    <h3 class="space-sub">其它盘上还有</h3>
    <div class="summary">
    ${others.map((d) => `<div class="row"><span class="k">${esc(d.dir)}</span>
      <span class="v">${d.models.length} 个模型 · ${d.totalGB} GB</span></div>`).join('')}
    </div>` : '';

  panel.innerHTML = `
    <div class="space-body">
      <div class="space-chart">${Chart.donut(segments, { size: 168, centerText: `${total.toFixed(1)}`, centerSub: 'GB' })}</div>
      <div class="space-side">
        <ul class="legend">${legend}</ul>
        ${notes.join('')}
      </div>
    </div>
    <div class="summary" style="margin-top:14px">
      <div class="row"><span class="k">模型目录</span><span class="v">${esc(p.dir)}</span></div>
      <div class="row"><span class="k">实际占用（去重后）</span><span class="v">${p.totalGB} GB</span></div>
      <div class="row"><span class="k">模型数量</span><span class="v">${p.models.length} 个</span></div>
      <div class="row"><span class="k">分片文件数</span><span class="v">${p.blobCount}</span></div>
    </div>
    ${othersHtml}`;
}

function renderConfig() {
  $('cfgSummary').innerHTML = `
    <div class="row"><span class="k">当前模型</span><span class="v">${esc(state.model || '（未设置）')}</span></div>
    <div class="row"><span class="k">模型目录</span><span class="v">${esc(state.modelDir || '（未设置）')}</span></div>
    <div class="row"><span class="k">上下文长度</span><span class="v">${state.contextWindow}</span></div>
    <div class="row"><span class="k">安装目录</span><span class="v">${esc(state.root)}</span></div>`;
}

/* ------------------------------------------------------- 上下文与模型 */

let ctxState = null;

/** 与 install.mjs 的 outputBudget / compactionBudget 保持一致（前端只用来实时预览） */
const autoOut = (ctx) => Math.max(512, Math.min(8192, Math.floor(ctx / 4)));
const autoHead = (ctx) => Math.max(512, Math.min(8192, Math.floor(ctx / 8)));

async function loadContext() {
  ctxState = await (await fetch('/api/config')).json();
  renderContext();
}

function ctxForm() {
  return {
    model: $('ctxModel').value,
    contextWindow: $('ctxWindow').value,
    maxTokens: $('ctxMaxTokens').value.trim(),
    headroomTokens: $('ctxHeadroom').value.trim(),
    thresholdRatio: $('ctxThreshold').value.trim(),
    retainRatio: $('ctxRetain').value.trim(),
  };
}

function renderBudget() {
  if (!ctxState) return;
  const f = ctxForm();
  const ctx = Math.max(2048, Number(f.contextWindow) || ctxState.contextWindow);
  const out = f.maxTokens === '' ? autoOut(ctx) : Number(f.maxTokens);
  const head = f.headroomTokens === '' ? autoHead(ctx) : Number(f.headroomTokens);
  const ratio = f.thresholdRatio === '' ? 0.6 : Number(f.thresholdRatio);
  const budget = ctx - out - head;
  const ok = budget > 0;
  const trigger = Math.round(ctx * (Number.isFinite(ratio) ? ratio : 0.6));

  $('ctxBudget').innerHTML = `
    <div class="row"><span class="k">压力预算</span>
      <span class="v">${ctx} − ${out} − ${head} =
        <b class="${ok ? 'ctx-good' : 'ctx-bad'}">${budget}</b></span></div>
    <div class="row"><span class="k">判读</span>
      <span class="v">${ok
        ? `可用。会话涨到约 ${trigger} tokens 时触发压缩，压到 ${Math.round(ctx * 0.25)} 左右`
        : '负数 —— 压缩会被静默禁用，表现是「聊久了回答越来越短」。必须调小输出上限或压缩余量'}</span></div>
    <div class="row"><span class="k">实际生效</span>
      <span class="v">窗口 ${ctx} · 输出 ${out} · 余量 ${head}</span></div>`;

  renderWaterfall(ctx, out, head, budget, ok);
  renderDiff(ctx, out, head, ratio);
}

/** 窗口分配瀑布图：输出 + 余量 + 剩余，三块拼起来正好是整个窗口 */
function renderWaterfall(ctx, out, head, budget, ok) {
  const box = $('ctxWaterfall');
  if (!box) return;
  const parts = [
    { label: '输出预算', value: Math.max(0, out), text: `${out}`, tone: 'good' },
    { label: '压缩余量', value: Math.max(0, head), text: `${head}`, tone: 'warn' },
    {
      label: budget >= 0 ? '可用余量' : '超支',
      value: Math.max(0, budget),
      text: `${budget}`,
      tone: budget >= 0 ? '' : 'bad',
    },
  ];
  box.innerHTML = Chart.waterfall(parts, { width: 380, labelW: 84, valueW: 60 })
    + `<p class="row-hint" style="margin-top:10px">${ok
      ? '绿色那段就是留给对话的余量 —— 会话涨满它的时候就会触发压缩。'
      : '余量为负：压缩不会触发，等于被静默禁用。'}</p>`;
}

function renderDiff(ctx, out, head, ratio) {
  const s = ctxState;
  const f = ctxForm();
  const rows = [];
  const add = (k, from, to) => {
    if (String(from) !== String(to)) {
      rows.push(`<div class="row"><span class="k">${k}</span>
        <span class="v">${esc(from)} → <b>${esc(to)}</b></span></div>`);
    }
  };
  add('模型', s.model, f.model);
  add('上下文长度', s.contextWindow, ctx);
  add('输出上限', s.maxTokens, out);
  add('压缩余量', s.headroomTokens, head);
  add('压缩阈值', s.thresholdRatio, f.thresholdRatio === '' ? s.thresholdRatio : ratio);
  add('保留比例', s.retainRatio, f.retainRatio === '' ? s.retainRatio : f.retainRatio);

  $('ctxDiff').innerHTML = rows.length
    ? rows.join('')
    : '<div class="row"><span class="k">—</span><span class="v">没有改动</span></div>';
}

function renderContext() {
  const s = ctxState;
  const names = Array.from(new Set([...(s.models || []), s.model].filter(Boolean)));
  $('ctxModel').innerHTML = names.length
    ? names.map((n) => `<option value="${esc(n)}"${n === s.model ? ' selected' : ''}>${esc(n)}${n === s.model ? '（当前）' : ''}</option>`).join('')
    : '<option value="">（没有可用模型）</option>';

  $('ctxWindow').value = s.contextWindow;
  // 高级项：只有被显式改过才填值，留空表示「按窗口自动」
  $('ctxMaxTokens').value = s.overridden.maxTokens ? s.maxTokens : '';
  $('ctxHeadroom').value = s.overridden.headroomTokens ? s.headroomTokens : '';
  $('ctxThreshold').value = s.overridden.thresholdRatio ? s.thresholdRatio : '';
  $('ctxRetain').value = s.overridden.retainRatio ? s.retainRatio : '';
  $('ctxMaxTokens').placeholder = `自动 ${s.auto.maxTokens}`;
  $('ctxHeadroom').placeholder = `自动 ${s.auto.headroomTokens}`;
  $('ctxThreshold').placeholder = '自动 0.6';
  $('ctxRetain').placeholder = '自动 0.25';

  $('ctxPresets').innerHTML = (s.presets || [])
    .map((n) => `<button class="chip" type="button" data-ctx="${n}">${n >= 1024 ? n / 1024 + 'K' : n}</button>`)
    .join('');
  for (const b of document.querySelectorAll('#ctxPresets .chip')) {
    b.addEventListener('click', () => { $('ctxWindow').value = b.dataset.ctx; renderBudget(); });
  }

  renderBudget();
}

for (const id of ['ctxModel', 'ctxWindow', 'ctxMaxTokens', 'ctxHeadroom', 'ctxThreshold', 'ctxRetain']) {
  const el = $(id);
  if (el) el.addEventListener('input', renderBudget);
  if (el) el.addEventListener('change', renderBudget);
}

if ($('btnReloadCtx')) {
  $('btnReloadCtx').addEventListener('click', async () => {
    await loadContext();
    toast('已重新读取配置');
  });
}

if ($('btnResetCtx')) {
  $('btnResetCtx').addEventListener('click', () => {
    $('ctxMaxTokens').value = '';
    $('ctxHeadroom').value = '';
    $('ctxThreshold').value = '';
    $('ctxRetain').value = '';
    renderBudget();
    toast('已清空高级项，将按窗口自动推导（记得点「应用配置」）');
  });
}

if ($('btnApplyCtx')) {
  $('btnApplyCtx').addEventListener('click', async () => {
    const f = ctxForm();
    const body = {
      model: f.model,
      contextWindow: Number(f.contextWindow),
      maxTokens: f.maxTokens === '' ? null : Number(f.maxTokens),
      headroomTokens: f.headroomTokens === '' ? null : Number(f.headroomTokens),
      thresholdRatio: f.thresholdRatio === '' ? null : Number(f.thresholdRatio),
      retainRatio: f.retainRatio === '' ? null : Number(f.retainRatio),
    };
    $('btnApplyCtx').disabled = true;
    try {
      const out = await post('/api/config', body);
      ctxState = { ...ctxState, ...out.config, ...out.budgets, models: ctxState.models };
      // 用后端返回的夹取结果回填，避免界面显示与真实写入不一致
      $('ctxWindow').value = out.budgets.contextWindow;
      $('ctxMaxTokens').value = out.budgets.overridden.maxTokens ? out.budgets.maxTokens : '';
      $('ctxHeadroom').value = out.budgets.overridden.headroomTokens ? out.budgets.headroomTokens : '';
      $('ctxThreshold').value = out.budgets.overridden.thresholdRatio ? out.budgets.thresholdRatio : '';
      $('ctxRetain').value = out.budgets.overridden.retainRatio ? out.budgets.retainRatio : '';
      await loadContext();
      await loadState();
      $('ctxApplyHint').innerHTML =
        `已写入。${out.notes.join('；')}。<b>重启工作台后生效</b>` +
        (out.backups.length ? `（已备份 ${out.backups.length} 个文件）` : '');
      toast('配置已应用，重启工作台后生效');
    } catch (e) {
      $('ctxApplyHint').innerHTML = `<span class="ctx-bad">${esc(e.message)}</span>`;
      toast('没有写入：' + e.message);
    } finally {
      $('btnApplyCtx').disabled = false;
    }
  });
}

/* ------------------------------------------------------------------ 队列 */

const QUEUE_STATUS = {
  queued: { text: '排队中', cls: 'queued' },
  running: { text: '下载中', cls: 'running' },
  cancelling: { text: '正在取消', cls: 'warn' },
  done: { text: '已完成', cls: 'done' },
  error: { text: '失败', cls: 'error' },
  cancelled: { text: '已取消', cls: 'warn' },
};

function renderQueue(state) {
  const panel = $('queuePanel');
  if (!panel) return;
  const items = (state && state.items) || [];
  panel.hidden = items.length === 0;
  if (!items.length) return;

  const done = items.filter((it) => it.status === 'done').length;
  $('queueCount').textContent = `${items.length} 个任务 · 已完成 ${done}`;

  $('queueList').innerHTML = items.map((it) => {
    const meta = QUEUE_STATUS[it.status] || { text: it.status, cls: '' };
    const stats = [];
    if (it.total > 0) stats.push(`${fmtBytes(it.got)} / ${fmtBytes(it.total)}`);
    if (it.speed > 0) stats.push(`${fmtBytes(it.speed)}/s`);
    if (it.eta > 0) stats.push(`剩余 ${fmtEta(it.eta)}`);
    const canCancel = ['queued', 'running'].includes(it.status);
    return `
      <div class="qitem ${meta.cls}">
        <div class="qi">
          <div class="qn">${esc(it.model)}</div>
          <div class="qs">${esc(meta.text)}${it.error ? ` · ${esc(it.error)}` : (stats.length ? ' · ' + esc(stats.join(' · ')) : '')}</div>
        </div>
        <div class="qbar"><div class="bar" style="width:${Math.max(0, Math.min(100, it.percent || 0))}%"></div></div>
        <div class="qp">${it.status === 'running' ? `${Math.round(it.percent || 0)}%` : ''}</div>
        <div class="qa">${canCancel ? `<button class="btn ghost small danger" data-qcancel="${esc(it.model)}">取消</button>` : ''}</div>
      </div>`;
  }).join('');

  for (const b of document.querySelectorAll('[data-qcancel]')) {
    b.addEventListener('click', async () => {
      try { await post('/api/queue/cancel', { model: b.dataset.qcancel }); }
      catch (e) { toast(e.message); }
    });
  }
}

if ($('btnQueueClear')) {
  $('btnQueueClear').addEventListener('click', async () => {
    try { await post('/api/queue/clear', {}); } catch (e) { toast(e.message); }
  });
}

/* ------------------------------------------------------------------ 试用 */

const playHistory = [];        // 完整对话（发给模型）
let playController = null;     // 用来「停止」

function playRender() {
  const box = $('chatBox');
  if (!playHistory.length) {
    box.innerHTML = '<div class="chat-empty" id="chatEmpty">还没开始。问点什么试试 —— 比如「用一句话解释什么是显存」。</div>';
    return;
  }
  box.innerHTML = playHistory.map((m) => `
    <div class="msg ${m.role}">
      <div class="msg-role">${m.role === 'user' ? '我' : '模型'}</div>
      <div class="msg-body">${m.pending ? '<span class="typing">正在思考…</span>' : esc(m.content)}</div>
    </div>`).join('');
  box.scrollTop = box.scrollHeight;
}

function playModels() {
  const sel = $('playModel');
  if (!sel) return;
  const names = (state.models || []).map((m) => m.name);
  if (!names.length) {
    sel.innerHTML = '<option value="">（没有已安装的模型）</option>';
    return;
  }
  const cur = sel.value || (state && state.model) || names[0];
  sel.innerHTML = names.map((n) => `<option value="${esc(n)}"${n === cur ? ' selected' : ''}>${esc(n)}</option>`).join('');
}

async function playSend() {
  playModels();
  const input = $('playInput');
  const text = input.value.trim();
  if (!text) return;
  const model = $('playModel').value;
  if (!model) { toast('先装一个模型再来聊天'); return; }

  const system = $('playSystem').value.trim();
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push(...playHistory.filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content })));
  messages.push({ role: 'user', content: text });

  playHistory.push({ role: 'user', content: text });
  playHistory.push({ role: 'assistant', content: '', pending: true });
  input.value = '';
  playRender();

  $('btnPlay').disabled = true;
  $('btnPlayStop').hidden = false;
  $('chatStats').innerHTML = '';

  playController = new AbortController();
  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-LocalAI-Token': window.__TOKEN__ || '' },
      body: JSON.stringify({
        model,
        messages,
        options: { temperature: Number($('playTemp').value), numPredict: Number($('playMax').value) },
      }),
      signal: playController.signal,
    });
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { msg = (await r.json()).error || msg; } catch { /* ignore */ }
      throw new Error(msg);
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const last = playHistory[playHistory.length - 1];
    last.pending = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let ev;
        try { ev = JSON.parse(payload); } catch { continue; }
        if (ev.type === 'chunk') {
          last.content += ev.content;
          const body = document.querySelector('.msg.assistant:last-of-type .msg-body');
          if (body) body.textContent = last.content;
          $('chatBox').scrollTop = $('chatBox').scrollHeight;
        } else if (ev.type === 'error') {
          last.content = `（出错：${ev.text}）`;
          toast(ev.text);
        } else if (ev.type === 'done' && ev.stats) {
          const s = ev.stats;
          $('chatStats').innerHTML = [
            ['生成', `${s.tokens} tokens`],
            ['速度', s.tokensPerSec ? `${s.tokensPerSec} tokens/s` : '—'],
            ['提示词', `${s.promptTokens} tokens`],
            ['总耗时', `${(s.totalMs / 1000).toFixed(1)} 秒`],
          ].map(([k, v]) => `<div class="stat"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`).join('');
        }
      }
    }
    if (!last.content) last.content = '（模型没有返回内容）';
  } catch (e) {
    const last = playHistory[playHistory.length - 1];
    if (last) { last.pending = false; if (!last.content) last.content = `（出错：${e.message}）`; }
    if (e.name !== 'AbortError') toast(e.message);
  } finally {
    playController = null;
    $('btnPlay').disabled = false;
    $('btnPlayStop').hidden = true;
    playRender();
  }
}

if ($('btnPlay')) $('btnPlay').addEventListener('click', () => playSend());
if ($('btnPlayStop')) {
  $('btnPlayStop').addEventListener('click', () => { if (playController) playController.abort(); });
}
if ($('playInput')) {
  $('playInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); playSend(); }
  });
}

/* ---------------------------------------------------------------- 基准 */

function benchModels() {
  const sel = $('benchModel');
  if (!sel) return;
  const names = (state.models || []).map((m) => m.name);
  if (!names.length) { sel.innerHTML = '<option value="">（没有已安装的模型）</option>'; return; }
  const cur = sel.value || (state && state.model) || names[0];
  sel.innerHTML = names.map((n) => `<option value="${esc(n)}"${n === cur ? ' selected' : ''}>${esc(n)}</option>`).join('');
}

const BENCH_PHASE = { warmup: '预热（把模型读进显存）', generation: '测生成速度', prompt: '测读长提示词的速度', done: '完成', error: '出错' };

function renderBench(r) {
  const v = r.verdict || {};
  const levelCls = { good: 'ctx-good', ok: '', slow: 'ctx-bad', verySlow: 'ctx-bad', unknown: '' };
  $('benchResult').innerHTML = [
    ['模型', r.model],
    ['生成速度', v.genTokensPerSec ? `${v.genTokensPerSec} tokens/秒` : '—'],
    ['读提示词速度', v.promptTokensPerSec ? `${v.promptTokensPerSec} tokens/秒` : '—'],
    ['单次耗时', v.avgLoadMs ? `${(v.avgLoadMs / 1000).toFixed(1)} 秒` : '—'],
    ['同档显卡参考', v.reference ? `${v.reference.gen} tokens/秒` : '—'],
  ].map(([k, val]) => `<div class="row"><span class="k">${esc(k)}</span><span class="v ${levelCls[v.genLevel] || ''}">${esc(val)}</span></div>`).join('');

  const items = [
    { label: '生成速度', value: v.genTokensPerSec || 0, text: `${v.genTokensPerSec || 0} t/s`, color: 'var(--chart-1)' },
    { label: '同档参考', value: v.reference ? v.reference.gen : 0, text: `${v.reference ? v.reference.gen : 0} t/s`, color: 'var(--chart-3)' },
    { label: '读提示词', value: v.promptTokensPerSec || 0, text: `${v.promptTokensPerSec || 0} t/s`, color: 'var(--chart-2)' },
    { label: '读提示词参考', value: v.reference ? v.reference.prompt : 0, text: `${v.reference ? v.reference.prompt : 0} t/s`, color: 'var(--chart-3)' },
  ];
  $('benchChart').innerHTML = Chart.bars(items, { width: 420, labelW: 108, valueW: 74 });

  $('benchAdvice').innerHTML = (v.advice || []).map((t) =>
    `<div class="row"><span class="k">·</span><span class="v">${esc(t)}</span></div>`).join('')
    || '<div class="row"><span class="k">—</span><span class="v">没有建议</span></div>';
}

async function startBench() {
  // 先把下拉框刷新一遍：用户可能页面还没加载完就来点了
  benchModels();
  const model = $('benchModel').value;
  if (!model) { toast('先装一个模型再来测速'); return; }
  $('benchWrap').hidden = false;
  $('benchBar').style.width = '0%';
  $('benchPct').textContent = '0%';
  $('benchTitle').textContent = '准备中…';
  $('benchHint').textContent = '正在测速…';
  try {
    await post('/api/bench', { model, runs: Number($('benchRuns').value) || 3 });
  } catch (e) {
    toast(e.message);
    $('benchWrap').hidden = true;
  }
}

if ($('btnBench')) $('btnBench').addEventListener('click', startBench);

/* ---------------------------------------------------------------- 修复中心 */

const FIX_LEVEL = { ok: { text: '正常', cls: 'ok' }, warn: { text: '注意', cls: 'warn' }, error: { text: '有问题', cls: 'error' } };

function renderFix(report) {
  const list = $('fixList');
  const summary = $('fixSummary');
  if (!report) {
    list.innerHTML = '<div class="empty">没有拿到检查结果</div>';
    return;
  }
  const problems = (report.checks || []).filter((c) => c.level !== 'ok');
  const level = FIX_LEVEL[report.level] || FIX_LEVEL.ok;
  summary.className = `fix-summary ${level.cls}`;
  summary.innerHTML = problems.length
    ? `<b>发现 ${problems.length} 个问题</b><span>${esc(problems.map((c) => c.label).join('、'))}</span>`
    : '<b>一切正常</b><span>这套配置现在是可以用的。</span>';

  list.innerHTML = (report.checks || []).map((c) => {
    const meta = FIX_LEVEL[c.level] || FIX_LEVEL.ok;
    return `<div class="fixrow ${meta.cls}">
      <div class="fx">
        <div class="fx-t">${esc(c.label)}<span class="fixbadge ${meta.cls}">${meta.text}</span></div>
        <div class="fx-d">${esc(c.detail)}</div>
      </div>
      <div class="fa">${c.fixable ? `<button class="btn ghost small" data-fix="${esc(c.fixable)}">修复</button>` : ''}</div>
    </div>`;
  }).join('');

  for (const b of document.querySelectorAll('[data-fix]')) {
    b.addEventListener('click', async () => {
      b.disabled = true;
      b.textContent = '修复中…';
      try {
        const out = await post('/api/repair', { action: b.dataset.fix });
        toast(out.message || '已修复');
        renderFix(out.report);
        loadState().catch(() => {});
      } catch (e) {
        toast(e.message);
        b.disabled = false;
        b.textContent = '修复';
      }
    });
  }
}

async function runDiagnose() {
  $('fixStamp').textContent = '检查中…';
  try {
    const report = await (await fetch('/api/diagnose')).json();
    renderFix(report);
    $('fixStamp').textContent = `检查于 ${new Date(report.at).toLocaleTimeString()}`;
  } catch (e) {
    $('fixStamp').textContent = `检查失败：${e.message}`;
  }
}

if ($('btnDiagnose')) $('btnDiagnose').addEventListener('click', runDiagnose);

/* ------------------------------------------------------------------ 体检 */

let healthDone = 0;
const HEALTH_TOTAL = 21;

function appendHealthLog(t) {
  const pre = $('healthLog');
  $('healthLogBox').hidden = false;
  const lines = (pre.textContent + t + '\n').split('\n');
  pre.textContent = lines.slice(-300).join('\n');
  pre.scrollTop = pre.scrollHeight;
}

function healthReset() {
  healthDone = 0;
  $('healthLog').textContent = '';
  $('healthLogBox').hidden = true;
  $('healthWrap').hidden = false;
  $('healthBar').style.width = '0%';
  $('healthPct').textContent = '0%';
  $('healthTitle').textContent = '体检中…';
  $('healthStats').innerHTML = '';
  $('healthResult').innerHTML = '<div class="row"><span class="k">—</span><span class="v">正在跑，别关这个窗口…</span></div>';
}

function renderHealthResult(s, ok) {
  const rows = ((s && s.verdicts) || []).map((v) =>
    `<div class="row"><span class="k">${v.ok ? '✅' : '❌'} ${esc(v.name)}</span>` +
    `<span class="v">${esc(v.detail)}</span></div>`);
  const fails = (s && s.eval && s.eval.fails) || [];
  if (fails.length) {
    rows.push(`<div class="row"><span class="k">未通过的题</span><span class="v">${esc(fails.join(', '))}</span></div>`);
  }
  if (s && s.elapsed_s) {
    rows.push(`<div class="row"><span class="k">耗时</span><span class="v">${s.elapsed_s} 秒</span></div>`);
  }
  $('healthResult').innerHTML = rows.join('')
    || '<div class="row"><span class="k">—</span><span class="v">没有拿到结果</span></div>';

  // 各分类通过率：条形图 + 总分仪表盘
  const cats = (s && s.categories) || [];
  const box = $('healthChart');
  if (box) {
    if (!cats.length) {
      box.innerHTML = '<div class="chart-empty">没有拿到分类明细</div>';
    } else {
      const overall = Math.round(cats.reduce((n, c) => n + c.rate, 0) / cats.length * 100);
      const items = cats.map((c) => ({
        label: c.cat,
        value: Math.round(c.rate * 100),
        text: `${c.passed}/${c.total}`,
        color: c.rate >= 0.9 ? 'var(--ok)' : c.rate >= 0.6 ? 'var(--warn)' : 'var(--err)',
      }));
      box.innerHTML = `
        <div class="health-gauge">${Chart.gauge(overall, { label: '总体通过率' })}</div>
        <div class="health-bars">${Chart.bars(items, { width: 340, labelW: 78, valueW: 52 })}</div>`;
    }
  }
  toast(ok ? '体检全部达标' : '体检有不达标项，看下面的判据');
}

async function startHealth(quick) {
  healthReset();
  try {
    await post('/api/health', { quick: !!quick });
  } catch (e) {
    $('healthResult').innerHTML =
      `<div class="row"><span class="k">失败</span><span class="v">${esc(e.message)}</span></div>`;
    $('healthWrap').hidden = true;
  }
}

if ($('btnHealth')) $('btnHealth').addEventListener('click', () => startHealth(false));
if ($('btnHealthQuick')) $('btnHealthQuick').addEventListener('click', () => startHealth(true));

/* ------------------------------------------------------------------ 下载 */

function showLog(on) {
  $('logBox').hidden = !on;
}

function appendLog(t) {
  const pre = $('log');
  pre.textContent += t + '\n';
  pre.scrollTop = pre.scrollHeight;
}

let sseRetry = 0;
let sseTimer = null;

function connectSSE() {
  // 页面跳走时必须显式关掉 SSE：浏览器对同一个源最多只开 6 条 HTTP/1.1 连接，
  // 留几条僵尸连接下来，后面的 SSE 就会被浏览器排队，页面从此收不到任何事件。
  if (window.__sse) { try { window.__sse.close(); } catch { /* ignore */ } }
  const es = new EventSource('/api/events');
  window.__sse = es;
  es.onopen = () => { sseRetry = 0; };
  es.onmessage = (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    if (ev.type === 'progress') {
      $('progressWrap').hidden = false;
      const pct = Math.max(0, Math.min(100, Math.round(ev.percent || 0)));
      $('progressBar').style.width = `${pct}%`;
      $('progressPct').textContent = `${pct}%`;
      const stats = [];
      if (ev.total > 0) stats.push(['已下载', `${fmtBytes(ev.got)} / ${fmtBytes(ev.total)}`]);
      if (ev.speed > 0) stats.push(['速度', `${fmtBytes(ev.speed)}/s`]);
      if (ev.eta > 0) stats.push(['剩余', fmtEta(ev.eta)]);
      $('progressStats').innerHTML = stats
        .map(([k, v]) => `<div class="stat"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`)
        .join('');
    } else if (ev.type === 'log') {
      appendLog(ev.text);
    } else if (ev.type === 'error') {
      appendLog('错误：' + ev.text);
      $('progressWrap').hidden = true;
      toast('操作失败：' + ev.text);
      setBusy(false);
    } else if (ev.type === 'done') {
      $('progressWrap').hidden = true;
      toast(ev.action === 'delete' ? `${ev.model} 已删除` : `${ev.model} 下载完成`);
      setBusy(false);
      setTimeout(loadState, 400);
    } else if (ev.type === 'bench') {
      $('benchWrap').hidden = false;
      const pct = Math.max(0, Math.min(100, ev.percent || 0));
      $('benchBar').style.width = `${pct}%`;
      $('benchPct').textContent = `${pct}%`;
      $('benchTitle').textContent = BENCH_PHASE[ev.phase] || '测速中…';
    } else if (ev.type === 'bench-done') {
      $('benchWrap').hidden = true;
      $('benchHint').textContent = '测完了。';
      renderBench(ev.result || {});
    } else if (ev.type === 'queue') {
      renderQueue(ev.state);
    } else if (ev.type === 'health-item') {
      healthDone++;
      const pct = Math.min(100, Math.round((healthDone / HEALTH_TOTAL) * 100));
      $('healthBar').style.width = `${pct}%`;
      $('healthPct').textContent = `${pct}%`;
      $('healthTitle').textContent = `体检中… 第 ${healthDone}/${HEALTH_TOTAL} 题`;
    } else if (ev.type === 'health-log') {
      appendHealthLog(ev.text);
    } else if (ev.type === 'health-done') {
      renderHealthResult(ev.summary, ev.ok);
      $('healthWrap').hidden = true;
    } else if (ev.type === 'health-error') {
      appendHealthLog('错误：' + ev.text);
      $('healthResult').innerHTML =
        `<div class="row"><span class="k">失败</span><span class="v">${esc(ev.text)}</span></div>`;
      $('healthWrap').hidden = true;
      toast('体检失败：' + ev.text);
    } else if (ev.type === 'idle') {
      setBusy(false);
    }
  };
  es.onerror = () => {
    // EventSource 自己会重连，但那只在连接「正常断开」时可靠。
    // 有时连接会被半死不活地卡住（readyState 一直停在 CONNECTING），
    // 这时自己重建一条更可靠 —— 退避时间逐次拉长，避免把服务打满。
    if (es.readyState === EventSource.CONNECTING && sseRetry > 2) {
      sseRetry += 1;
      clearTimeout(sseTimer);
      sseTimer = setTimeout(() => connectSSE(), Math.min(15000, 1000 * sseRetry));
      try { es.close(); } catch { /* ignore */ }
      return;
    }
    if (es.readyState === EventSource.CLOSED) {
      sseRetry += 1;
      clearTimeout(sseTimer);
      sseTimer = setTimeout(() => connectSSE(), Math.min(15000, 1000 * sseRetry));
    }
  };
}

// 页面离开前主动关掉连接，别给浏览器留下僵尸连接
window.addEventListener('pagehide', () => { if (window.__sse) { try { window.__sse.close(); } catch { /* ignore */ } } });
window.addEventListener('beforeunload', () => { if (window.__sse) { try { window.__sse.close(); } catch { /* ignore */ } } });

function setBusy(on) {
  $('btnPull').disabled = on;
  $('btnPull').textContent = on ? '处理中…' : '下载';
  if (!on) $('progressWrap').hidden = true;
}

/* ------------------------------------------------------------------ 按钮 */

function setupButtons() {
  $('quickModels').innerHTML = QUICK.map((m) => `<button class="chip" type="button" data-m="${m}">${m}</button>`).join('');
  for (const b of document.querySelectorAll('#quickModels .chip')) {
    b.addEventListener('click', () => { $('newModel').value = b.dataset.m; $('newModelErr').hidden = true; });
  }

  $('newModel').addEventListener('input', (e) => {
    const v = e.target.value.trim();
    $('newModelErr').hidden = !v || /^[a-z0-9][a-z0-9._\-/]*(:[a-z0-9._\-]+)?$/i.test(v);
  });

  $('btnPull').addEventListener('click', async () => {
    const model = $('newModel').value.trim();
    if (!model) { toast('先填一个模型名'); return; }
    try {
      const out = await post('/api/queue', { model });
      renderQueue(out.state);
      $('newModel').value = '';
      toast(`「${model}」已加入下载队列`);
    } catch (e) { toast(e.message); }
  });

  $('swAutostart').addEventListener('change', async (e) => {
    const on = e.target.checked;
    try {
      const r = await post('/api/settings', { autostart: on });
      if (r.autostart && !r.autostart.ok) throw new Error(r.autostart.error || '设置失败');
      toast(on ? '已开启开机自启' : '已关闭开机自启');
      renderSettings();
    } catch (err) {
      toast(err.message);
      e.target.checked = !on;
    }
  });

  // 局域网共享：必须先在警告里打勾确认，才允许打开
  $('swLan').addEventListener('change', (e) => {
    if (e.target.checked) {
      e.target.checked = false;
      $('lanWarn').hidden = false;
      $('lanAgree').checked = false;
      $('lanOk').disabled = true;
      $('lanWarn').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      applyLan(false);
    }
  });
  $('lanAgree').addEventListener('change', (e) => { $('lanOk').disabled = !e.target.checked; });
  $('lanCancel').addEventListener('click', () => { $('lanWarn').hidden = true; });
  $('lanOk').addEventListener('click', () => applyLan(true));

  $('btnStartSvc').addEventListener('click', async () => {
    try {
      const r = await post('/api/service', { action: 'start' });
      if (!r.ok) throw new Error(r.error || '启动失败');
      $('svcHint').textContent = '已经启动 —— 看新弹出的黑色窗口，浏览器会自动打开工作台。';
    } catch (e) { toast(e.message); }
  });

  $('btnStopSvc').addEventListener('click', async () => {
    try {
      await post('/api/service', { action: 'stop' });
      $('svcHint').textContent = '已停止服务，显存已经还给游戏和渲染软件。';
      setTimeout(loadState, 800);
    } catch (e) { toast(e.message); }
  });

  $('btnOpenInstall').addEventListener('click', async () => {
    try { await post('/api/open-folder', { which: 'install' }); } catch (e) { toast(e.message); }
  });
  $('btnOpenModels').addEventListener('click', async () => {
    try { await post('/api/open-folder', { which: 'models' }); } catch (e) { toast(e.message); }
  });
  $('btnReload').addEventListener('click', async () => {
    await loadState();
    toast('已刷新');
  });

  $('btnUninstall').addEventListener('click', async () => {
    try {
      const r = await post('/api/service', { action: 'uninstall' });
      if (!r.ok) throw new Error(r.error || '打开失败');
      toast('已在新窗口打开卸载程序，按它的提示操作即可');
    } catch (e) { toast(e.message); }
  });

  /* ---- 日志 / 版本 / 主题 ---- */
  if ($('btnShowLog')) {
    $('btnShowLog').addEventListener('click', async () => {
      try {
        const r = await (await fetch('/api/logs?lines=200')).json();
        $('consoleLogBox').hidden = false;
        $('consoleLog').textContent = r.text || '（日志是空的）';
        $('logPathHint').textContent = `日志位置：${r.path}`;
      } catch (e) { toast(e.message); }
    });
  }

  if ($('btnDownloadLog')) {
    $('btnDownloadLog').addEventListener('click', () => {
      window.open('/api/logs/download', '_blank');
    });
  }

  if ($('btnCheckVersion')) {
    $('btnCheckVersion').addEventListener('click', async () => {
      const btn = $('btnCheckVersion');
      btn.disabled = true;
      btn.textContent = '检查中…';
      try {
        const v = await (await fetch('/api/version-check')).json();
        if (v.update) toast(`有新版本：${v.latest}（当前 ${v.current}）`);
        else if (v.latest) toast(`已经是最新版本（${v.current}）`);
        else toast(`检查失败：${v.note || '未知原因'}`);
      } catch (e) { toast(e.message); }
      btn.disabled = false;
      btn.textContent = '检查更新';
    });
  }

  if ($('btnTheme')) {
    $('btnTheme').addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme');
      const next = cur === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      toast(next === 'dark' ? '已切换到深色' : '已切换到浅色');
    });
  }

  /* ---- 配置导出 / 导入 ---- */
  $('btnExportCfg').addEventListener('click', async () => {
    try {
      const r = await fetch('/api/config/export');
      if (!r.ok) throw new Error(`导出失败（HTTP ${r.status}）`);
      const text = await r.text();
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `local-ai-config-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('已导出到「下载」目录');
    } catch (e) { toast(e.message); }
  });

  $('btnImportCfg').addEventListener('click', () => $('fileImportCfg').click());

  $('fileImportCfg').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const bundle = JSON.parse(await file.text());
      const out = await post('/api/config/import', bundle);
      const warn = (out.warnings || []).map((w) => `· ${w}`).join('<br>');
      $('importHint').innerHTML = `已导入：${esc(out.config.model || '（未设置模型）')} · 窗口 ${out.config.contextWindow || 8192}`
        + (warn ? `<br><span class="ctx-bad">${warn}</span>` : '')
        + '<br>重启工作台后生效。';
      toast('配置已导入');
      await loadState();
    } catch (err) {
      $('importHint').innerHTML = `<span class="ctx-bad">导入失败：${esc(err.message)}</span>`;
      toast('导入失败：' + err.message);
    }
  });
}

async function applyLan(on) {
  try {
    const r = await post('/api/settings', { lanShare: on });
    $('lanWarn').hidden = true;
    renderSettings();
    toast(on
      ? '已开启局域网共享 —— 同网络的设备可以用 http://你的IP:11434 访问'
      : '已关闭局域网共享，Ollama 只监听本机');
    return r;
  } catch (e) {
    toast(e.message);
    renderSettings();
  }
}

/* ------------------------------------------------------------------ 启动 */

setupButtons();
connectSSE();
loadState().catch((e) => {
  $('modelList').innerHTML = `<div class="issue error">读取状态失败：${esc(e.message)}</div>`;
});
startDashTimer();

// 每 5 秒刷新一次状态（服务启停、模型增删后自动跟上）
setInterval(() => { loadState().catch(() => {}); }, 5000);
