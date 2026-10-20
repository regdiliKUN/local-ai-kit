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
    if (li.dataset.tab === 'health') { loadTrend('health').catch(() => {}); loadRanking().catch(() => {}); }
    if (li.dataset.tab === 'bench') loadTrend('bench').catch(() => {});
    if (li.dataset.tab === 'compare') renderFitRadar().catch(() => {});
    // 显存估算要调 nvidia-smi，只在切到这一页时算
    if (li.dataset.tab === 'context') loadVramPlan();
    if (li.dataset.tab === 'settings') { loadCheckpoints().catch(() => {}); renderShortcuts(); }
    if (li.dataset.tab === 'help') renderHelp();
  });
}

// 深链（#context / #settings / #palette）的处理放在文件末尾 ——
// 命令面板等定义在后面，提前调用会撞上 const 的暂时性死区。

/* ------------------------------------------------------------ 多语言 */

/** 界面语言：中文 / English */
function applyLanguage(id) {
  if (!window.I18n) return;
  I18n.setLang(id);
  I18n.applyI18n(document);
  // 动态生成的界面重新渲染一遍
  renderStatus();
  renderModels();
  renderSettings();
  renderConfig();
  if (ctxState) renderContext();
  renderQueue(state && state.queue);
  renderServices();
  renderHelp();
  renderShortcuts();
  // 标题也跟着变
  document.title = I18n.currentLang() === 'en' ? 'Local AI Console' : '本地 AI 控制台';
}

if ($('langSelect')) {
  $('langSelect').innerHTML = (window.I18n ? I18n.langs() : [])
    .map((l) => `<option value="${esc(l.id)}">${esc(l.label)}</option>`).join('');
  $('langSelect').value = window.I18n ? I18n.currentLang() : 'zh';
  $('langSelect').addEventListener('change', (e) => {
    applyLanguage(e.target.value);
    toast(I18n.currentLang() === 'en' ? 'Language: English' : '语言：简体中文');
  });
}

// 页面一进来就按用户上次的选择换语言
(function initLanguage() {
  if (!window.I18n) return;
  I18n.initI18n();
  I18n.applyI18n(document);
  I18n.observeI18n(document.body);
  document.documentElement.lang = I18n.currentLang() === 'en' ? 'en' : 'zh-CN';
})();

/* ------------------------------------------------------------------ 主题 */

/**
 * 主题：深色 / 浅色 / 跟随系统 / 按时段自动。
 *
 * 「按时段自动」是给夜里还在折腾的人准备的：白天浅色，晚上自动转深色。
 */
const THEME_KEY = 'localai-theme';
const THEMES = [
  { id: 'auto', label: '跟随系统' },
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
  { id: 'schedule', label: '按时段（白天浅 / 晚上深）' },
];

function scheduledTheme() {
  const h = new Date().getHours();
  return (h >= 19 || h < 7) ? 'dark' : 'light';
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'auto') {
    root.removeAttribute('data-theme');
    try { localStorage.removeItem(THEME_KEY); } catch { /* ignore */ }
  } else if (theme === 'schedule') {
    root.setAttribute('data-theme', scheduledTheme());
    try { localStorage.setItem(THEME_KEY, 'schedule'); } catch { /* ignore */ }
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
  if (saved === 'schedule') {
    document.documentElement.setAttribute('data-theme', scheduledTheme());
    // 每 5 分钟看一眼，天色变了自动切
    setInterval(() => {
      if (currentTheme() === 'schedule') {
        const want = scheduledTheme();
        if (document.documentElement.getAttribute('data-theme') !== want) {
          document.documentElement.setAttribute('data-theme', want);
        }
      }
    }, 300000);
  } else if (saved !== 'auto') {
    document.documentElement.setAttribute('data-theme', saved);
  }
})();

/* ------------------------------------------------------- 快捷键自定义 */

const SHORTCUT_KEY = 'localai-shortcuts';
const SHORTCUT_DEFS = [
  { id: 'palette', name: '打开命令面板', key: 'k', mod: 'ctrl', label: 'Ctrl+K' },
  { id: 'refresh', name: '刷新状态', key: 'r', mod: '', label: 'R' },
  { id: 'search', name: '聚焦模型搜索', key: '/', mod: '', label: '/' },
  { id: 'help', name: '显示快捷键说明', key: '?', mod: '', label: '?' },
  { id: 'overview', name: '去系统概览', key: '1', mod: '', label: '1' },
  { id: 'models', name: '去模型管理', key: '2', mod: '', label: '2' },
  { id: 'play', name: '去试用', key: '3', mod: '', label: '3' },
  { id: 'services', name: '去服务', key: '4', mod: '', label: '4' },
];

/** 读用户改过的快捷键；没改过的用默认值 */
function loadShortcuts() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SHORTCUT_KEY) || '{}'); } catch { saved = {}; }
  return SHORTCUT_DEFS.map((d) => {
    const s = saved[d.id] || {};
    const key = s.key || d.key;
    const mod = s.mod != null ? s.mod : d.mod;
    return { ...d, key, mod, label: formatShortcut(key, mod) };
  });
}

function formatShortcut(key, mod) {
  const parts = [];
  if (mod === 'ctrl') parts.push('Ctrl');
  if (mod === 'alt') parts.push('Alt');
  if (mod === 'shift') parts.push('Shift');
  parts.push(key === '/' ? '/' : key.toUpperCase());
  return parts.join('+');
}

function saveShortcuts(list) {
  const obj = {};
  for (const s of list) obj[s.id] = { key: s.key, mod: s.mod };
  try { localStorage.setItem(SHORTCUT_KEY, JSON.stringify(obj)); } catch { /* ignore */ }
}

let shortcutDefs = loadShortcuts();

function renderShortcuts() {
  const box = $('shortcutList');
  if (!box) return;
  box.innerHTML = shortcutDefs.map((s) => `
    <div class="mrow">
      <div class="mi"><div class="mn">${esc(s.name)}</div></div>
      <div class="mz"><kbd class="skbd" data-sk="${esc(s.id)}">${esc(s.label)}</kbd></div>
    </div>`).join('');
  for (const k of box.querySelectorAll('[data-sk]')) {
    k.addEventListener('click', () => {
      const id = k.dataset.sk;
      const def = shortcutDefs.find((s) => s.id === id);
      if (!def) return;
      const handler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const key = e.key.length === 1 ? e.key : e.key.toLowerCase();
        if (key === 'escape') { document.removeEventListener('keydown', handler, true); return; }
        // 功能键不绑定，免得和浏览器快捷键打架
        if (['control', 'shift', 'alt', 'meta'].includes(key)) return;
        def.key = key;
        def.mod = e.ctrlKey || e.metaKey ? 'ctrl' : (e.altKey ? 'alt' : (e.shiftKey ? 'shift' : ''));
        def.label = formatShortcut(def.key, def.mod);
        saveShortcuts(shortcutDefs);
        document.removeEventListener('keydown', handler, true);
        renderShortcuts();
        toast(`「${def.name}」改成了 ${def.label}`);
      };
      document.addEventListener('keydown', handler, true);
      k.textContent = '按下新键…（Esc 取消）';
    });
  }
}

/* ------------------------------------------------------- 上手清单 */

/**
 * 侧栏的五步清单。
 *
 * 判断依据全部来自已有状态，不额外存标记——这样用户换台机器、清缓存，
 * 清单也能正确反映「他到底做到哪一步了」。
 */
function renderChecklist() {
  const box = $('checklist');
  if (!box) return;
  const done = [];
  const st = state || {};
  done[0] = Array.isArray(st.models) ? st.models.length > 0 : false;
  done[1] = !!(st.history && (st.history.bench || []).length);
  done[2] = !!(st.history && (st.history.health || []).length);
  done[3] = localStorage.getItem('lak_chatted') === '1';
  done[4] = !!(st.settings && st.settings.autoStart);

  const items = [
    { label: '装一个模型', tab: 'models', done: done[0] },
    { label: '测一次速度', tab: 'bench', done: done[1] },
    { label: '跑一次体检', tab: 'health', done: done[2] },
    { label: '跟模型聊两句', tab: 'play', done: done[3] },
    { label: '设好开机自启', tab: 'settings', done: done[4] },
  ];
  const n = items.filter((i) => i.done).length;
  // 全部完成后就收起，别一直占着侧栏
  box.hidden = n === items.length && localStorage.getItem('lak_checklist_done') === '1';
  if (box.hidden) return;

  $('checklistCount').textContent = `${n}/${items.length}`;
  $('checklistBar').style.width = `${(n / items.length) * 100}%`;
  $('checklistItems').innerHTML = items.map((i) => `
    <div class="check-item ${i.done ? 'done' : ''}" data-check-tab="${i.tab}">
      <span class="check-dot">${i.done ? '✓' : ''}</span>
      <span class="check-label">${i.label}</span>
    </div>`).join('')
    + (n === items.length ? '<div class="checklist-finish">都做完了，可以正常用了</div>' : '');

  document.querySelectorAll('[data-check-tab]').forEach((el) => {
    el.addEventListener('click', () => gotoTab(el.dataset.checkTab));
  });
  if (n === items.length) localStorage.setItem('lak_checklist_done', '1');
}

/* ------------------------------------------------------- 键盘与无障碍 */

/**
 * 快捷键。
 *   1..8  切换左侧标签页
 *   r     刷新状态
 *   /     聚焦模型搜索框
 *   ?     显示快捷键说明
 */
const KEYMAP = {
  '1': 'dashboard', '2': 'models', '3': 'play', '4': 'compare', '5': 'bench',
  '6': 'context', '7': 'health', '8': 'fix', '9': 'tools', '0': 'services',
};

document.addEventListener('keydown', (e) => {
  // 用户自定义过的快捷键优先
  const custom = shortcutDefs.find((s) => {
    if (s.mod === 'ctrl' && !(e.ctrlKey || e.metaKey)) return false;
    if (s.mod === '' && (e.ctrlKey || e.metaKey || e.altKey)) return false;
    if (s.mod === 'alt' && !e.altKey) return false;
    if (s.mod === 'shift' && !e.shiftKey) return false;
    return s.key === (e.key.length === 1 ? e.key : e.key.toLowerCase());
  });
  if (custom && custom.id !== 'help') {
    e.preventDefault();
    if (custom.id === 'palette') paletteOpen();
    else if (custom.id === 'refresh') loadState();
    else if (custom.id === 'search') { const s = $('modelSearch'); if (s) s.focus(); }
    else if (custom.id === 'overview') gotoTab('dashboard');
    else if (custom.id === 'models') gotoTab('models');
    else if (custom.id === 'play') gotoTab('play');
    else if (custom.id === 'services') gotoTab('services');
    return;
  }

  if (e.ctrlKey || e.metaKey || e.altKey) {
    // Ctrl+K / Cmd+K 打开命令面板
    if (e.key === 'k' || e.key === 'K') {
      if ($('paletteMask') && $('paletteMask').hidden) { paletteOpen(); e.preventDefault(); }
    }
    return;
  }
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

  if (KEYMAP[e.key]) {
    const li = document.querySelector(`#tabs li[data-tab="${KEYMAP[e.key]}"]`);
    if (li) { li.click(); e.preventDefault(); }
    return;
  }
  if (e.key === 'r' || e.key === 'R') { loadState().catch(() => {}); e.preventDefault(); }
  if (e.key === '/') { const s = $('modelSearch'); if (s) { s.focus(); e.preventDefault(); } }
  if (e.key === '?') { toast('快捷键：Ctrl+K 命令面板 · 1-0 切换页面 · R 刷新 · / 搜索'); }
});

/* ------------------------------------------------------------ 引导助手 */

/**
 * 统一的空状态渲染。
 *
 * 界面上的「暂无数据」对用户没有任何价值 —— 要告诉他「现在该做什么」。
 */
function emptyBox(key, extra) {
  const g = (window.Guidance && Guidance.EMPTY[key]) || { title: '暂无数据', hint: '', action: null, where: null };
  const action = g.action
    ? `<button class="btn ghost small" data-goto="${esc(g.where || '')}">${esc(g.action)}</button>`
    : '';
  return `<div class="empty">
    <b>${esc(g.title)}</b>
    ${g.hint ? `<div class="ehint">${esc(g.hint)}</div>` : ''}
    ${extra || ''}
    ${action}
  </div>`;
}

/** 给页面里所有「跳到某页」的按钮接上事件 */
function bindGoto(root) {
  for (const b of (root || document).querySelectorAll('[data-goto]')) {
    b.addEventListener('click', () => {
      const tab = b.dataset.goto;
      if (tab) gotoTab(tab);
    });
  }
}

/** 把一段报错翻译成人话 + 修复动作 */
function explainError(text) {
  const e = (window.Guidance && Guidance.explain) ? Guidance.explain(text) : null;
  if (!e) return null;
  return `<div class="errcard">
    <div class="ec-title">${esc(e.title)}</div>
    <div class="ec-why">${esc(e.why)}</div>
    <div class="ec-fix">建议：${esc(e.fix)}</div>
    ${e.where ? `<button class="btn ghost small" data-goto="${esc(e.where)}">去处理</button>` : ''}
  </div>`;
}

/* ------------------------------------------------------------------ 状态 */

async function loadState() {
  // 首屏数据是服务端注入的（window.__BOOT__），先直接用，省一次往返也避免闪白
  if (window.__BOOT__ && window.__BOOT__.state && !state) {
    state = window.__BOOT__.state;
    ctxState = window.__BOOT__.config || null;
    renderStatus();
    renderModels();
    renderSettings();
    renderConfig();
    if (ctxState) renderContext();
    renderQueue(state.queue);
    playModels();
    benchModels();
    compareModels();
    renderServices();
    loadSpace().catch(() => {});
    loadCaps();
    if (window.__BOOT__.metrics) renderMetrics(window.__BOOT__.metrics);
    renderChecklist();
    loadModelUsage();
    return;
  }
  state = await (await fetch('/api/state')).json();
  renderStatus();
  renderModels();
  renderSettings();
  renderConfig();
  await loadContext();
  renderQueue(state.queue);
  playModels();
  benchModels();
  compareModels();
  renderServices();
  loadSessions().then(() => {
    // 打开页面就接着上次的对话
    if (playSessions.length) {
      const last = playSessions[playSessions.length - 1];
      if (!playMessages().length) { loadSession(last.id); const sel = $('playSession'); if (sel) sel.value = last.id; }
    }
  }).catch(() => {});
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
  loadRanking().catch(() => {});
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
  renderMetrics(data);
}

/** 把指标画出来（首屏注入和轮询共用） */
function renderMetrics(data) {
  const m = (data && data.current) || {};
  const h = (data && data.history) || {};
  $('dashStamp').textContent = `更新于 ${new Date(m.at || Date.now()).toLocaleTimeString()}`;

  /* ---- 四个仪表盘 ---- */
  const gpu0 = (m.gpu || [])[0];
  const vramPct = gpu0 ? gpu0.memoryPercent : null;
  $('gVram').innerHTML = vramPct == null ? '—' : `${vramPct}<span class="unit">%</span>`;
  $('gVramSub').textContent = gpu0
    ? `${(gpu0.memoryUsedMB / 1024).toFixed(1)} / ${(gpu0.memoryTotalMB / 1024).toFixed(1)} GB`
    : '没有检测到独立显卡';
  $('gVramSpark').innerHTML = Chart.sparkline(h.vram || [], { width: 150, height: 34, min: 0, max: 100 });

  // 温度 / 功耗告警：过热会掉速甚至崩，值得单独提醒
  const warn = gpuAlert(gpu0);
  if (warn) {
    $('dashStamp').innerHTML = `更新于 ${new Date(m.at || Date.now()).toLocaleTimeString()} <span class="alert-chip">${esc(warn)}</span>`;
  }

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

  renderVramBreakdown(m);
  loadUsage().catch(() => {});
  loadDisks().catch(() => {});

  /* ---- 正在跑的模型 ---- */
  const running = (m.ollama && m.ollama.models) || [];
  if (!running.length) {
    $('dashModels').innerHTML = emptyBox('modelsNoneRunning');
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

/** 给模型起个别名（不占额外磁盘） */
function askAlias(model) {
  const name = prompt(`给「${model}」起一个别名（例如 ${model.split(':')[0]}-fast）：`);
  if (!name) return;
  const to = name.trim();
  if (!to) return;
  if (!/^[a-z0-9][a-z0-9._\-/]*(:[a-z0-9._\-]+)?$/i.test(to)) {
    toast('名字只能用小写字母、数字和 . - _ / :');
    return;
  }
  post('/api/alias', { from: model, to }).then((out) => {
    toast(out.message || '已创建别名');
    loadState();
  }).catch((e) => toast(e.message));
}

/* 模型使用情况：哪些装完就没碰过。数据来自 /api/model-usage（落盘的使用记录） */
let usageMap = {};
async function loadModelUsage() {
  try {
    const r = await (await fetch('/api/model-usage')).json();
    const next = {};
    for (const row of r.rows || []) next[row.name] = row;
    usageMap = next;
    renderIdleSummary(r);
    renderModels();
  } catch { /* 拿不到就不显示，不影响列表本身 */ }
}

/**
 * 闲置统计：多少个体积被「装完没用过」占着。
 *
 * 模型管理页最容易犯的错是只列体积、不说总量——
 * 用户看到一排 5GB/17GB 也不知道加起来浪费了多少。
 */
function renderIdleSummary(rep) {
  const box = $('idleSummary');
  if (!box) return;
  const rows = rep.rows || [];
  if (!rows.length) { box.hidden = true; return; }

  const sizeOf = (name) => {
    const m = (state.models || []).find((x) => x.name === name);
    return m ? (m.sizeGB || 0) : 0;
  };
  const never = rows.filter((r) => r.never);
  const stale = rows.filter((r) => !r.never && r.stale);
  const used = rows.filter((r) => !r.never && !r.stale);
  const idleGB = [...never, ...stale].reduce((n, r) => n + sizeOf(r.name), 0);
  const totalGB = rows.reduce((n, r) => n + sizeOf(r.name), 0);

  box.hidden = false;
  if (!never.length && !stale.length) {
    box.innerHTML = `<div class="guide" style="margin-bottom:10px">
      <span class="guide-n">用量</span>
      <span>${rows.length} 个模型都在用，没有闲置的。</span></div>`;
    return;
  }

  const segments = [
    { label: '在用', value: used.length, color: 'var(--ok)' },
    { label: '闲置', value: stale.length, color: 'var(--warn)' },
    { label: '没用过', value: never.length, color: 'var(--text-dim)' },
  ].filter((x) => x.value > 0);

  box.innerHTML = `<div class="idle-sum">
    <div class="idle-chart">${Chart.donut(segments, {
      size: 116,
      centerText: `${idleGB.toFixed(1)}`,
      centerSub: 'GB 闲置',
    })}</div>
    <div class="idle-text">
      <b>${never.length + stale.length} 个模型可以清掉</b>
      <div class="idle-line">占 <b>${idleGB.toFixed(1)} GB</b>，总容量 ${totalGB.toFixed(1)} GB 的 ${totalGB ? Math.round((idleGB / totalGB) * 100) : 0}%</div>
      <div class="idle-line dim">
        ${never.length ? `装完没用过 ${never.length} 个` : ''}${never.length && stale.length ? ' · ' : ''}${stale.length ? `超过 ${rep.staleDays} 天没动 ${stale.length} 个` : ''}
      </div>
      <button class="btn ghost small" id="btnPickIdle2" style="margin-top:8px">勾选这些模型</button>
    </div>
  </div>`;
  const b = $('btnPickIdle2');
  if (b) b.addEventListener('click', pickIdleModels);
}

/** 勾选所有闲置模型，让用户自己按「批量删除」确认——不替用户做删除决定 */
function pickIdleModels() {
  const idle = new Set(
    Object.values(usageMap).filter((r) => r.stale).map((r) => r.name),
  );
  if (!idle.size) return;
  let n = 0;
  for (const c of document.querySelectorAll('[data-pick]')) {
    const on = idle.has(c.dataset.pick);
    c.checked = on;
    if (on) n++;
  }
  const btn = $('btnBatchDel');
  if (btn) {
    btn.disabled = n === 0;
    btn.textContent = n ? `批量删除（${n}）` : '批量删除';
  }
  if (typeof toast === 'function') toast(`已勾选 ${n} 个闲置模型，确认后点「批量删除」`);
}

function useText(name) {
  const u = usageMap[name];
  if (!u) return '';
  if (u.never) return ' · <span style="color:var(--warn)">装完没用过</span>';
  if (u.daysAgo === 0) return ' · 今天用过';
  if (u.daysAgo === 1) return ' · 昨天用过';
  return ` · ${u.daysAgo} 天前用过`;
}

function staleTag(name) {
  const u = usageMap[name];
  if (!u || !u.stale) return '';
  return `<span class="tag" style="color:var(--warn);border-color:var(--warn)">闲置</span>`;
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
    $('modelList').innerHTML = emptyBox('models');
    bindGoto($('modelList'));
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
    // 体积对比条：一眼看出哪个模型最占地方
    const maxSize = Math.max(1, ...all.map((x) => x.sizeGB || 0));
    const w = Math.max(3, Math.round(((m.sizeGB || 0) / maxSize) * 100));
    const isCurrent = state.model && state.model === m.name;
    return `
    <div class="mrow${isCurrent ? ' current' : ''}" data-model="${esc(m.name)}">
      <label class="mcheck"><input type="checkbox" data-pick="${esc(m.name)}"></label>
      <div class="mi">
        <div class="mn">${esc(m.name)}${isCurrent ? '<span class="tag current">使用中</span>' : ''}${tags.map((t) => `<span class="tag">${t}</span>`).join('')}${staleTag(m.name)}</div>
        <div class="ms">${esc(m.params || '')} ${esc(m.quant || '')}${m.modified ? ' · ' + esc(String(m.modified).slice(0, 10)) : ''}${useText(m.name)}</div>
        <div class="msize"><i style="width:${w}%"></i></div>
      </div>
      <div class="mz">${m.sizeGB} GB</div>
      <div class="ma">
        <button class="btn ghost small" data-alias="${esc(m.name)}">起别名</button>
        <button class="btn ghost small danger" data-del="${esc(m.name)}">删除</button>
      </div>
    </div>`;
  }).join('');

  for (const b of document.querySelectorAll('[data-del]')) {
    b.addEventListener('click', () => askDelete(b.dataset.del, b));
  }
  for (const b of document.querySelectorAll('[data-alias]')) {
    b.addEventListener('click', () => askAlias(b.dataset.alias));
  }
  for (const c of document.querySelectorAll('[data-pick]')) {
    c.addEventListener('change', () => {
      const picked = document.querySelectorAll('[data-pick]:checked');
      const btn = $('btnBatchDel');
      if (btn) {
        btn.disabled = picked.length === 0;
        btn.textContent = picked.length ? `批量删除（${picked.length}）` : '批量删除';
      }
    });
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
  if ($('swSelfHeal')) $('swSelfHeal').checked = !!(state && state.selfHeal);
}

if ($('swSelfHeal')) {
  $('swSelfHeal').addEventListener('change', async (e) => {
    const on = e.target.checked;
    try {
      const r = await post('/api/settings', { selfHeal: on });
      toast(on ? '已开启自愈：Ollama 掉了会自动重启' : '已关闭自愈');
      if (r.selfHeal !== undefined) state.selfHeal = r.selfHeal;
    } catch (err) {
      toast(err.message);
      e.target.checked = !on;
    }
  });
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
    panel.innerHTML = emptyBox('space', p.dir
      ? `<div class="ehint">配置里写的是 <code>${esc(p.dir)}</code>，但这个目录不存在。</div>` : '');
    bindGoto(panel);
    return;
  }
  if (!p.models.length) {
    panel.innerHTML = emptyBox('space', `<div class="ehint">模型还没下到 <code>${esc(p.dir)}</code>。</div>`);
    bindGoto(panel);
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

/**
 * 显存预算：当前模型在各上下文档位下要多少显存、够不够。
 *
 * 后端早就写好 estimateVramGB / contextFit，但一直没人调用——
 * 结果用户在控制台把 8K 拉到 128K 时没有任何提示，保存后才发现跑不动。
 */
async function loadVramPlan() {
  const box = $('vramPlan');
  if (!box) return;
  try {
    const d = await (await fetch('/api/vram-plan')).json();
    if (!d.vramGB) {
      box.hidden = false;
      box.innerHTML = `<div class="guide" style="margin-bottom:12px">
        <span class="guide-n">显存</span>
        <span>没识别到独立显卡，显存估算用不上。CPU 跑的话主要看内存。</span></div>`;
      return;
    }
    if (!d.plan.length) { box.hidden = true; return; }

    // 只看当前选中的模型，其他模型的选择没意义
    const cur = d.plan.find((x) => x.model === d.currentModel) || d.plan[0];
    const levels = { ok: 'ok', tight: 'warn', over: 'error', unknown: '' };
    const words = { ok: '够用', tight: '偏紧', over: '不够', unknown: '未知' };

    const cells = cur.options.map((o) => {
      const active = o.contextWindow === d.currentContext;
      return `<div class="vram-cell ${levels[o.level] || ''}${active ? ' active' : ''}"
                   title="${o.label}：需要 ${o.need == null ? '?' : o.need + ' GB'}">
        <div class="vc-k">${o.label}</div>
        <div class="vc-v">${o.need == null ? '—' : o.need.toFixed(1)}</div>
        <div class="vc-l">${words[o.level] || ''}</div>
      </div>`;
    }).join('');

    const active = cur.options.find((o) => o.contextWindow === d.currentContext);
    const bad = active && (active.level === 'over' || active.level === 'tight');
    box.hidden = false;
    box.innerHTML = `<div class="vram-box">
      <div class="vram-head">
        <b>显存预算</b>
        <span class="dim">${esc(cur.model)} · 显卡 ${d.vramGB} GB · 当前 ${Math.round(d.currentContext / 1024)}K</span>
      </div>
      <div class="vram-cells">${cells}</div>
      ${bad ? `<div class="vram-warn ${active.level === 'over' ? 'over' : ''}">
        ${active.level === 'over'
          ? `⚠ 当前设置需要约 <b>${active.need} GB</b>，超过显卡的 ${d.vramGB} GB。跑起来会退回 CPU（很慢）或直接失败——建议降到更低的上下文档位，或换个小一点的模型。`
          : `当前设置需要约 <b>${active.need} GB</b>，占显卡 ${d.vramGB} GB 的 ${Math.round((active.need / d.vramGB) * 100)}%，比较紧。如果同时开着别的程序（浏览器、游戏）可能会爆。`}
      </div>` : `<div class="vram-ok">当前设置需要约 ${active && active.need != null ? active.need + ' GB' : '—'}，在 ${d.vramGB} GB 显存内够用。</div>`}
    </div>`;
  } catch { box.hidden = true; }
}

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

/**
 * 试一下：用当前选中的模型发一句最短的话，确认它真的能出字。
 *
 * 为什么需要：切了模型要重启工作台才生效，用户重启完才发现这个模型跑不动，
 * 又得改回去再来一遍。这里先用 8 个 token 试一句，几秒钟就知道行不行。
 */
async function testCtxModel() {
  const sel = $('ctxModel');
  const model = sel && sel.value;
  if (!model) return toast('先选一个模型');
  const btn = $('btnTestCtx');
  const hint = $('ctxApplyHint');
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '测试中…';
  const t0 = performance.now();
  let firstAt = 0;
  let chars = 0;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-localai-token': window.__TOKEN__ || '' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '说「好」就行' }],
        options: { numPredict: 8 },
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }

    // 按 SSE 逐条读，记录首字时间和累计字数
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const obj = JSON.parse(payload);
          if (obj.error) throw new Error(obj.error);
          const piece = (obj.message && obj.message.content) || obj.response || '';
          if (piece) {
            if (!firstAt) firstAt = performance.now() - t0;
            chars += piece.length;
          }
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }

    const total = Math.round(performance.now() - t0);
    if (!chars) throw new Error('模型没有返回任何内容');
    if (hint) {
      hint.innerHTML = `<span style="color:var(--ok)">✓ 能正常出字</span> · `
        + `首字 ${Math.round(firstAt)} ms · 共 ${total} ms · ${chars} 字`;
    }
    toast(`${model} 可以正常使用`);
  } catch (e) {
    const msg = String(e.message || e);
    // 常见错误直接用引导里的话术翻译一下
    const g = window.Guidance && Guidance.explain ? Guidance.explain(msg) : null;
    if (hint) {
      hint.innerHTML = `<span style="color:var(--err)">✗ ${esc(msg)}</span>`
        + (g ? `<br><b>${esc(g.title)}</b>：${esc(g.fix)}`
             + (g.where ? ` <a href="#${esc(g.where)}">去处理</a>` : '') : '');
    }
    toast(`测试失败：${g ? g.title : msg}`);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

if ($('btnTestCtx')) $('btnTestCtx').addEventListener('click', testCtxModel);

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

/**
 * 对话是一棵树，不是一条线。
 *
 * 「重新生成」之后，上一个回答不会被丢掉 —— 它变成同一个问题下的另一个分支，
 * 点一下就能切回去比较。实现见 ui/conversation-tree.js。
 */
let playTree = (window.ConversationTree ? ConversationTree.makeTree() : { children: [] });
let playPath = [];               // 当前路径（节点 id 数组）
let playController = null;       // 用来「停止」
let playSessions = [];           // 存下来的历史对话
let playSessionId = '';
let playPending = null;          // 正在生成的那个节点

/** 当前这条路径上的消息（发给模型 / 渲染界面都用它） */
function playMessages() {
  if (!window.ConversationTree) return [];
  return ConversationTree.flatten(playTree, playPath);
}

/** 清空整棵树，开始新对话 */
function playReset() {
  playTree = window.ConversationTree ? ConversationTree.makeTree() : { children: [] };
  playPath = [];
  playPending = null;
}

/** 往树上挂一个节点，返回新路径 */
function playAppend(role, content) {
  if (!window.ConversationTree) return playPath;
  const node = ConversationTree.makeNode(role, content);
  playPath = ConversationTree.appendNode(playTree, playPath, node);
  return node;
}

/** 当前节点在同一问题下的兄弟（重新生成出来的那些回答） */
function playSiblings() {
  if (!window.ConversationTree || playPath.length < 2) return [];
  return ConversationTree.siblingsOf(playTree, playPath);
}

/** 切到某个兄弟分支 */
function playSwitchTo(nodeId) {
  if (!window.ConversationTree || playPath.length < 2) return;
  playPath = playPath.slice(0, -1).concat([nodeId]);
  playRender();
}

/** 拉历史对话列表并把最近一次载入 */
async function loadSessions() {
  try {
    const r = await (await fetch('/api/sessions')).json();
    playSessions = r.items || [];
  } catch { playSessions = []; }
  const sel = $('playSession');
  if (!sel) return;
  if (!playSessions.length) {
    sel.innerHTML = '<option value="">（还没有历史对话）</option>';
    return;
  }
  sel.innerHTML = playSessions.slice().reverse().map((s) =>
    `<option value="${esc(s.id)}">${esc(s.title || '（空对话）')} · ${new Date(s.at).toLocaleString()}</option>`).join('');
  if (playSessionId) sel.value = playSessionId;
}

/** 把当前对话存到磁盘 */
async function saveSession() {
  const messages = playMessages()
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }));
  if (!messages.length) return;
  try {
    const out = await post('/api/sessions', {
      id: playSessionId || `s${Date.now()}`,
      title: messages[0].content.slice(0, 60),
      model: $('playModel').value,
      messages,
    });
    playSessionId = out.session ? out.session.id : playSessionId;
    playSessions = out.items || playSessions;
    await loadSessions();
  } catch { /* 存不上也不影响聊天 */ }
}

/** 载入某次历史对话 */
function loadSession(id) {
  const s = playSessions.find((x) => x.id === id);
  if (!s) return;
  playSessionId = s.id;
  playReset();
  for (const m of s.messages || []) playAppend(m.role, m.content);
  playRender();
}

function playRender() {
  const box = $('chatBox');
  const list = playMessages();
  renderCtxUsage();
  renderBranches();
  if (!list.length) {
    box.innerHTML = '<div class="chat-empty" id="chatEmpty">还没开始。问点什么试试 —— 比如「用一句话解释什么是显存」。</div>';
    return;
  }
  box.innerHTML = list.map((m) => `
    <div class="msg ${m.role}">
      <div class="msg-role">${m.role === 'user' ? '我' : '模型'}</div>
      <div class="msg-body">${m.pending ? '<span class="typing">正在思考…</span>' : esc(m.content)}</div>
    </div>`).join('');
  box.scrollTop = box.scrollHeight;
}

/** 分支切换器：同一个问题下有几个回答就摆几个按钮 */
function renderBranches() {
  const box = $('playBranches');
  if (!box) return;
  const siblings = playSiblings();
  if (siblings.length < 2) { box.innerHTML = ''; box.hidden = true; return; }
  box.hidden = false;
  const current = playPath[playPath.length - 1];
  box.innerHTML = `<span class="br-label">这条问题有 ${siblings.length} 个回答：</span>`
    + siblings.map((s, i) => {
      const on = s.id === current;
      const text = (s.content || '').replace(/\s+/g, ' ').slice(0, 18) || '（空）';
      return `<button class="br-chip ${on ? 'on' : ''}" data-branch="${esc(s.id)}" title="${esc(text)}">${i + 1}. ${esc(text)}</button>`;
    }).join('');
  for (const b of box.querySelectorAll('[data-branch]')) {
    b.addEventListener('click', () => playSwitchTo(b.dataset.branch));
  }
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

/**
 * 发一条消息（或者重新生成）。
 *
 * reuseUser = true 时不再新建「用户提问」节点 —— 路径已经停在那个提问节点上，
 * 直接挂一个新的回答节点，于是它和上一个回答成了**兄弟分支**。
 */
async function playSend(opts = {}) {
  const reuseUser = !!opts.reuseUser;
  playModels();
  const input = $('playInput');
  const text = input.value.trim();
  if (!text && !reuseUser) return;
  const model = $('playModel').value;
  if (!model) { toast('先装一个模型再来聊天'); return; }

  const system = $('playSystem').value.trim();
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  // 当前路径上的历史（重新生成时已经包含那条提问了，别重复加）
  const history = playMessages().filter((m) => m.role === 'user' || m.role === 'assistant');
  messages.push(...history.map((m) => ({ role: m.role, content: m.content })));
  if (!reuseUser) messages.push({ role: 'user', content: text });

  if (!reuseUser) playAppend('user', text);
  const answerNode = playAppend('assistant', '');
  playPending = answerNode;
  if (!reuseUser) input.value = '';
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
          answerNode.content += ev.content;
          const body = document.querySelector('.msg.assistant:last-of-type .msg-body');
          if (body) body.textContent = answerNode.content;
          $('chatBox').scrollTop = $('chatBox').scrollHeight;
        } else if (ev.type === 'error') {
          answerNode.content = `（出错：${ev.text}）`;
          toast(ev.text);
        } else if (ev.type === 'done' && ev.stats) {
          const s = ev.stats;
          $('chatStats').innerHTML = [
            ['生成', `${s.tokens} tokens`],
            ['速度', s.tokensPerSec ? `${s.tokensPerSec} tokens/s` : '—'],
            ['提示词', `${s.promptTokens} tokens`],
            ['总耗时', `${(s.totalMs / 1000).toFixed(1)} 秒`],
          ].map(([k, v]) => `<div class="stat"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`).join('');
          // 记一笔用量，概览页能看到每天消耗了多少
          fetch('/api/usage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-LocalAI-Token': window.__TOKEN__ || '' },
            body: JSON.stringify({ tokens: (s.tokens || 0) + (s.promptTokens || 0), model: $('playModel').value }),
          }).catch(() => { /* 统计失败不影响聊天 */ });
        }
      }
    }
    if (!answerNode.content) answerNode.content = '（模型没有返回内容）';
  } catch (e) {
    if (answerNode && !answerNode.content) answerNode.content = `（出错：${e.message}）`;
    if (e.name !== 'AbortError') toast(e.message);
  } finally {
    playPending = null;
    playController = null;
    $('btnPlay').disabled = false;
    $('btnPlayStop').hidden = true;
    playRender();
    saveSession();
  }
}

if ($('btnPlay')) $('btnPlay').addEventListener('click', () => playSend());
if ($('btnPlayStop')) {
  $('btnPlayStop').addEventListener('click', () => { if (playController) playController.abort(); });
}
if ($('btnPlayRegen')) {
  $('btnPlayRegen').addEventListener('click', async () => {
    // 重新生成：在同一个问题下挂一个新的回答分支，原来的保留着可以切回去
    if (!window.ConversationTree || playPath.length < 2) { toast('没有可以重试的问题'); return; }
    const list = playMessages();
    const lastUser = [...list].reverse().find((m) => m.role === 'user');
    if (!lastUser) { toast('没有可以重试的问题'); return; }
    // 退回到「用户提问」那个节点 —— 新的回答会挂在它下面，和上一个回答成为兄弟
    playPath = playPath.slice(0, -1);
    playRender();
    $('playInput').value = lastUser.content;
    await playSend({ reuseUser: true });
  });
}
if ($('playSession')) {
  $('playSession').addEventListener('change', (e) => {
    if (e.target.value) loadSession(e.target.value);
  });
}
if ($('btnPlayNew')) {
  $('btnPlayNew').addEventListener('click', () => {
    playReset();
    playSessionId = '';
    playRender();
    $('playSession').value = '';
    toast('已开新对话');
  });
}
if ($('btnPlayDel')) {
  $('btnPlayDel').addEventListener('click', async () => {
    const id = $('playSession').value;
    if (!id) { toast('先选一段对话'); return; }
    try {
      await fetch(`/api/sessions?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (playSessionId === id) { playReset(); playSessionId = ''; playRender(); }
      await loadSessions();
      toast('已删除');
    } catch (e) { toast(e.message); }
  });
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

  // 和历史最好的一次比一比
  benchCompare(r);
}

/** 与历史最佳成绩对比 —— 换了配置之后是变快还是变慢，一眼就知道 */
async function benchCompare(r) {
  const box = $('benchCompare');
  if (!box) return;
  try {
    const res = await (await fetch('/api/history?kind=bench')).json();
    const items = (res.items || []).filter((x) => x.model === r.model && x.gen);
    if (items.length < 2) {
      box.innerHTML = '<div class="row"><span class="k">对比</span><span class="v">再测一次就能和上次比了</span></div>';
      return;
    }
    const best = Math.max(...items.map((x) => x.gen));
    const avg = Math.round(items.reduce((n, x) => n + x.gen, 0) / items.length);
    const now = r.verdict ? r.verdict.genTokensPerSec : 0;
    const diff = best > 0 ? Math.round(((now - best) / best) * 100) : 0;
    const tone = diff >= 0 ? 'ctx-good' : 'ctx-bad';
    box.innerHTML = [
      `<div class="row"><span class="k">历史最佳</span><span class="v">${best} t/s</span></div>`,
      `<div class="row"><span class="k">历史平均</span><span class="v">${avg} t/s（共 ${items.length} 次）</span></div>`,
      `<div class="row"><span class="k">这次</span><span class="v ${tone}">${now} t/s（比最佳${diff >= 0 ? '快' : '慢'} ${Math.abs(diff)}%）</span></div>`,
    ].join('');
  } catch { /* ignore */ }
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

/* ------------------------------------------------------------ 历史趋势 */

/** 加载历史并画趋势图 */
async function loadTrend(kind) {
  const box = $(kind === 'health' ? 'healthTrend' : 'benchTrend');
  if (!box) return;
  try {
    const r = await (await fetch(`/api/history?kind=${kind}`)).json();
    const items = r.items || [];
    const pathHint = $(kind === 'health' ? 'healthHistoryPath' : 'benchHistoryPath');
    if (pathHint) pathHint.textContent = `记录文件：${r.path || ''}`;
    if (!items.length) {
      box.innerHTML = emptyBox('trend');
      return;
    }
    if (kind === 'health') {
      const points = items.map((it) => ({
        label: new Date(it.at).toLocaleDateString(),
        value: it.rate == null ? null : Math.round(it.rate * 100),
        text: it.passed != null ? `${it.passed}/${it.total}` : '',
      }));
      box.innerHTML = Chart.line(points, { width: 460, height: 160, min: 0, max: 100, unit: '%' })
        + '<p class="row-hint" style="margin-top:8px">每次体检的成绩。曲线掉下来 = 换配置或换模型之后变差了。</p>'
        + '<h3 class="space-sub">日历热力图</h3>'
        + Chart.heatmap(items.map((it) => ({
          date: new Date(it.at).toISOString().slice(0, 10),
          value: it.rate == null ? 0 : Math.round(it.rate * 100),
          text: it.passed != null ? `${it.passed}/${it.total}` : '',
        })), { weeks: 12 })
        + '<p class="row-hint" style="margin-top:6px">颜色越绿说明当天体检成绩越好。</p>';
    } else {
      const points = items.map((it) => ({
        label: new Date(it.at).toLocaleDateString(),
        value: it.gen,
        text: `${it.gen} t/s`,
      }));
      box.innerHTML = Chart.line(points, { width: 460, height: 160, min: 0, unit: '' })
        + '<p class="row-hint" style="margin-top:8px">每次测速的生成速度。改了上下文或量化档之后跑一次，就能看出是变快还是变慢。</p>';
    }
  } catch (e) {
    box.innerHTML = `<div class="chart-empty">读取失败：${esc(e.message)}</div>`;
  }
}

if ($('btnClearHealth')) {
  $('btnClearHealth').addEventListener('click', async () => {
    try { await fetch('/api/history?kind=health', { method: 'DELETE' }); loadTrend('health'); toast('体检历史已清空'); }
    catch (e) { toast(e.message); }
  });
}
if ($('btnCsvHealth')) {
  $('btnCsvHealth').addEventListener('click', () => { window.open('/api/history.csv?kind=health', '_blank'); });
}
if ($('btnCsvBench')) {
  $('btnCsvBench').addEventListener('click', () => { window.open('/api/history.csv?kind=bench', '_blank'); });
}
if ($('btnMdHealth')) {
  $('btnMdHealth').addEventListener('click', () => { window.open('/api/history.md?kind=health', '_blank'); });
}
if ($('btnMdBench')) {
  $('btnMdBench').addEventListener('click', () => { window.open('/api/history.md?kind=bench', '_blank'); });
}
if ($('btnClearBench')) {
  $('btnClearBench').addEventListener('click', async () => {
    try { await fetch('/api/history?kind=bench', { method: 'DELETE' }); loadTrend('bench'); toast('测速历史已清空'); }
    catch (e) { toast(e.message); }
  });
}

/* -------------------------------------------------------- 官方模型库搜索 */

const CAP_TEXT = {
  tools: '工具调用', vision: '看图', thinking: '深度思考',
  embedding: '向量化', audio: '语音', cloud: '云端',
};

/** "603.2K" → 603200，用来排序 */
function pullNumber(text) {
  const m = /^([\d.]+)\s*([KMB])?$/i.exec(String(text || '').trim());
  if (!m) return 0;
  const n = Number(m[1]) || 0;
  const u = (m[2] || '').toUpperCase();
  return u === 'K' ? n * 1e3 : u === 'M' ? n * 1e6 : u === 'B' ? n * 1e9 : n;
}

let libItems = [];

/** 按界面上的筛选条件过滤 + 排序 */
function libFilter(items) {
  const caps = Array.from(document.querySelectorAll('[data-libcap]:checked')).map((i) => i.dataset.libcap);
  const sort = ($('libSort') && $('libSort').value) || 'pulls';
  let out = items;
  if (caps.length) out = out.filter((m) => caps.every((c) => (m.capabilities || []).includes(c)));
  out = out.slice().sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name);
    if (sort === 'sizes') return (b.sizes || []).length - (a.sizes || []).length;
    return pullNumber(b.pulls) - pullNumber(a.pulls);
  });
  return out;
}

function libRender() {
  const box = $('libResults');
  if (!box) return;
  const items = libFilter(libItems);
  if (!items.length) {
    box.innerHTML = libItems.length
      ? '<p class="row-hint">当前筛选条件下没有模型 —— 取消几个能力筛选试试。</p>'
      : '<p class="row-hint">没找到匹配的模型。</p>';
    return;
  }
  box.innerHTML = items.map((m) => `
    <div class="libitem">
      <div class="li">
        <div class="ln">${esc(m.name)}</div>
        <div class="ld">${esc((m.description || '').slice(0, 120))}</div>
        <div class="lt">${(m.capabilities || []).map((c) => `<span class="tag">${esc(CAP_TEXT[c] || c)}</span>`).join('')}
          ${(m.sizes || []).slice(0, 8).map((s) => `<span class="tag plain">${esc(s)}</span>`).join('')}</div>
      </div>
      <div class="la">
        ${m.pulls ? `<div class="lp">${esc(m.pulls)} 次下载</div>` : ''}
        <button class="btn ghost small" data-lib="${esc(m.name)}">下载</button>
      </div>
    </div>`).join('');

  for (const b of box.querySelectorAll('[data-lib]')) {
    b.addEventListener('click', async () => {
      const name = b.dataset.lib;
      b.disabled = true;
      b.textContent = '加入中…';
      try {
        const out = await post('/api/queue', { model: `${name}:latest` });
        renderQueue(out.state);
        toast(`「${name}:latest」已加入下载队列`);
      } catch (e) { toast(e.message); }
      b.disabled = false;
      b.textContent = '下载';
    });
  }
}

async function searchLibrary() {
  const q = $('libQuery').value.trim();
  const box = $('libResults');
  box.innerHTML = '<div class="loading"><span class="spinner"></span> 正在搜 ollama.com…</div>';
  try {
    const r = await (await fetch(`/api/library?q=${encodeURIComponent(q)}`)).json();
    if (r.error && !r.items.length) {
      box.innerHTML = `<p class="row-hint">${esc(r.error)}。离线时可以用下面的输入框直接写模型名。</p>`;
      libItems = [];
      return;
    }
    libItems = r.items || [];
    libRender();
  } catch (e) {
    box.innerHTML = `<p class="row-hint">搜索失败：${esc(e.message)}</p>`;
  }
}

if ($('btnLibSearch')) $('btnLibSearch').addEventListener('click', searchLibrary);
if ($('libQuery')) {
  $('libQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchLibrary(); });
}
for (const box of document.querySelectorAll('[data-libcap]')) {
  box.addEventListener('change', libRender);
}
if ($('libSort')) $('libSort').addEventListener('change', libRender);

/* ------------------------------------------------------------ 上下文占用 */

/**
 * 粗略估算一段文字占多少 token。
 *
 * 没有 token 器时也能给出「大概」：中文大约 1.5 字一个 token，
 * 英文大约 4 个字符一个 token，外加每条消息几 token 的格式开销。
 * 用途是让用户对「还能聊多久」有个直观感觉，不是精确计数。
 */
function estimateTokens(text) {
  const s = String(text || '');
  const cjk = (s.match(/[一-鿿　-〿]/g) || []).length;
  const rest = s.length - cjk;
  return Math.round(cjk / 1.5 + rest / 4);
}

function renderCtxUsage() {
  const box = $('ctxUsage');
  if (!box) return;
  const messages = playMessages().filter((m) => m.role === 'user' || m.role === 'assistant');
  if (!messages.length) { box.innerHTML = ''; return; }
  const tokens = messages.reduce((n, m) => n + estimateTokens(m.content) + 4, 0);
  const window_ = ctxState && ctxState.contextWindow ? ctxState.contextWindow : 8192;
  const pct = Math.min(100, Math.round((tokens / window_) * 100));
  const left = Math.max(0, window_ - tokens);
  const perTurn = Math.round(messages.reduce((n, m) => n + estimateTokens(m.content) + 4, 0) / messages.length);
  box.innerHTML = `
    <div class="ctx-ring">${Chart.ring(pct, { label: '上下文', size: 104, thickness: 10 })}</div>
    <div class="ctx-nums">
      <div class="stat"><span class="k">上下文占用</span><span class="v">约 ${tokens} / ${window_} tokens（${pct}%）</span></div>
      <div class="stat"><span class="k">还能聊</span><span class="v">大概还能再聊 ${Math.floor(left / Math.max(1, perTurn))} 轮</span></div>
      <div class="stat"><span class="k">提醒</span><span class="v">${pct > 85 ? '快满了 —— 再聊下去就该触发压缩了' : pct > 60 ? '用掉一半以上了' : '还很宽裕'}</span></div>
    </div>`;
}

const compareState = {};   // model -> { content, status, stats }

function compareModels() {
  const box = $('compareModels');
  if (!box) return;
  const names = (state.models || []).map((m) => m.name);
  if (!names.length) { box.innerHTML = '<span class="row-hint">（没有已安装的模型）</span>'; return; }
  // 记住上次勾选，页面刷新别丢
  const chosen = new Set(Array.from(box.querySelectorAll('input:checked')).map((i) => i.value));
  if (!chosen.size) { names.slice(0, 2).forEach((n) => chosen.add(n)); }
  box.innerHTML = names.map((n) => `
    <label class="check"><input type="checkbox" value="${esc(n)}"${chosen.has(n) ? ' checked' : ''}>
      <span>${esc(n)}</span></label>`).join('');
}

function renderCompare() {
  const box = $('compareResults');
  const models = Object.keys(compareState);
  if (!models.length) {
    box.innerHTML = emptyBox('compare');
    return;
  }
  box.innerHTML = models.map((m) => {
    const r = compareState[m];
    const body = r.status === 'running' ? '<span class="typing">正在思考…</span>'
      : r.status === 'error' ? `<span class="ctx-bad">${esc(r.content)}</span>`
        : esc(r.content || '（没有返回内容）');
    const s = r.stats;
    const meta = s
      ? `${s.tokens} tokens · ${s.tokensPerSec || '—'} t/s · ${(r.wallMs / 1000).toFixed(1)} 秒`
      : r.wallMs ? `${(r.wallMs / 1000).toFixed(1)} 秒` : '';
    return `<div class="cmpcard">
      <div class="cmp-head"><b>${esc(m)}</b><span class="cmp-meta">${esc(meta)}</span></div>
      <div class="cmp-body">${body}</div>
    </div>`;
  }).join('');
}

async function startCompare() {
  const models = Array.from($('compareModels').querySelectorAll('input:checked')).map((i) => i.value);
  if (!models.length) { toast('至少选一个模型'); return; }
  const prompt = $('comparePrompt').value.trim();
  if (!prompt) { toast('先写一个问题'); return; }

  for (const m of Object.keys(compareState)) delete compareState[m];
  for (const m of models) compareState[m] = { status: 'queued', content: '', stats: null };
  renderCompare();
  $('btnCompare').disabled = true;
  $('compareHint').textContent = '正在依次跑…';

  try {
    const r = await fetch('/api/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-LocalAI-Token': window.__TOKEN__ || '' },
      body: JSON.stringify({ models, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { msg = (await r.json()).error || msg; } catch { /* ignore */ }
      throw new Error(msg);
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
        const item = compareState[ev.model];
        if (!item) continue;
        if (ev.type === 'compare-item') {
          item.status = ev.status;
          if (ev.status === 'error') item.content = ev.content;
          if (ev.stats) item.stats = ev.stats;
          if (ev.wallMs) item.wallMs = ev.wallMs;
        } else if (ev.type === 'compare-chunk') {
          item.status = 'running';
          item.content += ev.content;
        }
        renderCompare();
      }
    }
  } catch (e) {
    toast(e.message);
  } finally {
    $('btnCompare').disabled = false;
    $('compareHint').textContent = '最多 4 个模型，依次跑（并发会互相抢显存）。';
  }
}

if ($('btnCompare')) $('btnCompare').addEventListener('click', startCompare);

/* -------------------------------------------------- 模型适配度雷达（估算） */

/** 从 "8.2B" / "494.03M" 里取出参数量（单位：B） */
function parseParams(text) {
  const s = String(text || '').trim();
  const m = /^([\d.]+)\s*([BKM])?/i.exec(s);
  if (!m) return 0;
  const n = Number(m[1]) || 0;
  const unit = (m[2] || 'B').toUpperCase();
  if (unit === 'M') return n / 1000;
  if (unit === 'K') return n / 1e6;
  return n;
}

/**
 * 给每个已装模型算一个适配度雷达。
 *
 * 五个维度：质量、显存余量、速度预期、能力、上下文余量。
 * 都是估算 —— 目的是让人别只凭「哪个名字大」来选。
 */
async function renderFitRadar() {
  const box = $('fitGrid');
  if (!box) return;
  const models = state.models || [];
  if (!models.length) {
    box.innerHTML = emptyBox('models');
    return;
  }
  let vramGB = 0;
  let memGB = 0;
  // 优先用首屏注入的指标（页面开头就带），不用再等一次接口
  let boot = window.__BOOT__ && window.__BOOT__.metrics;
  if (boot && boot.current) {
    const g = (boot.current.gpu || [])[0];
    if (g && g.memoryTotalMB) vramGB = Math.round(g.memoryTotalMB / 1024);
    if (boot.current.memory) memGB = boot.current.memory.totalGB;
  } else {
    try {
      const m = await (await fetch('/api/metrics')).json();
      vramGB = m.current && m.current.gpu && m.current.gpu[0]
        ? Math.round(m.current.gpu[0].memoryTotalMB / 1024) : 0;
      memGB = m.current && m.current.memory ? m.current.memory.totalGB : 0;
    } catch { /* 拿不到就按 0 算 */ }
  }

  const window_ = (ctxState && ctxState.contextWindow) || 8192;
  const axes = ['质量', '显存余量', '速度', '能力', '性价比'];

  const scored = models.map((m) => {
    const params = parseParams(m.params);
    const size = m.sizeGB || 0;
    const caps = (state.caps || {})[m.name] || [];
    const quality = Math.min(100, Math.round((params / 32) * 100));
    const vramRoom = vramGB > 0 ? Math.max(0, Math.min(100, Math.round(((vramGB - size) / vramGB) * 100))) : 0;
    // 经验值：模型越小，生成越快。1GB 的模型大约 400 t/s，20GB 的大约 25 t/s
    const speed = Math.max(0, Math.min(100, Math.round((400 / Math.max(1, size)) / 6 * 100)));
    const capability = Math.min(100, (caps.includes('tools') ? 40 : 0) + (caps.includes('vision') ? 30 : 0) + (caps.includes('thinking') ? 30 : 0));
    // 性价比：每 GB 磁盘能买到多少参数。1.5 参数/GB 算优秀
    const perGB = size > 0 ? params / size : 0;
    const value = Math.max(0, Math.min(100, Math.round((perGB / 1.5) * 100)));
    const values = [quality, vramRoom, speed, capability, value];
    const total = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
    return { m, values, total, perGB };
  }).sort((a, b) => b.total - a.total);

  box.innerHTML = scored.map((s) => `
    <div class="fitcard">
      <div class="fc-head"><b>${esc(s.m.name)}</b><span class="fc-total">${s.total} 分</span></div>
      <div class="fc-radar">${Chart.radar(axes, s.values, { size: 170 })}</div>
      <div class="fc-meta">${esc(s.m.params || '')} ${esc(s.m.quant || '')} · ${s.m.sizeGB} GB</div>
    </div>`).join('');
}

/* ------------------------------------------------- 诊断与维护（网络/清理/报告） */

async function runNetCheck() {
  $('netStamp').textContent = '检查中…';
  $('netResult').innerHTML = '<div class="row"><span class="k">—</span><span class="v">正在探测…</span></div>';
  try {
    const r = await (await fetch('/api/netcheck')).json();
    const rows = (r.results || []).map((x) => {
      const ok = x.ok;
      return `<div class="row"><span class="k">${ok ? (x.warn ? '⚠️' : '✅') : '❌'} ${esc(x.label)}</span>
        <span class="v">${ok ? `${x.ms} ms${x.warn ? ` · ${esc(x.warn)}` : ''}` : esc(x.error || '不通')}</span></div>`;
    });
    if ((r.proxies || []).length) {
      rows.push(`<div class="row"><span class="k">代理</span><span class="v">${esc(r.proxies.map((p) => `${p.key}=${p.value}`).join('，'))}</span></div>`);
    }
    rows.push(`<div class="row"><span class="k">建议</span><span class="v">${esc((r.advice || []).join(' '))}</span></div>`);
    $('netResult').innerHTML = rows.join('');
    $('netStamp').textContent = `检查于 ${new Date(r.at).toLocaleTimeString()}`;
  } catch (e) {
    $('netResult').innerHTML = `<div class="row"><span class="k">失败</span><span class="v">${esc(e.message)}</span></div>`;
    $('netStamp').textContent = '检查失败';
  }
}

async function checkOrphan() {
  $('orphanHint').textContent = '检查中…';
  try {
    const r = await (await fetch('/api/cleanup')).json();
    if (!r.count) {
      $('orphanResult').innerHTML = '<div class="row"><span class="k">残留</span><span class="v">没有残留，磁盘是干净的</span></div>';
      $('btnCleanup').disabled = true;
      $('orphanHint').textContent = '没有需要清理的东西';
      return;
    }
    const preview = (r.preview || []).slice(0, 8).map((b) => `${b.name.slice(0, 22)}… ${b.mb} MB`).join('，');
    $('orphanResult').innerHTML = [
      `<div class="row"><span class="k">残留分片</span><span class="v">${r.count} 个，共 ${r.totalGB} GB</span></div>`,
      `<div class="row"><span class="k">其中</span><span class="v">${esc(preview)}${(r.preview || []).length > 8 ? ' …' : ''}</span></div>`,
    ].join('');
    $('btnCleanup').disabled = false;
    $('orphanHint').textContent = `可以释放约 ${r.totalGB} GB`;
  } catch (e) {
    $('orphanHint').textContent = `检查失败：${e.message}`;
  }
}

if ($('btnNetCheck')) $('btnNetCheck').addEventListener('click', runNetCheck);
if ($('btnCheckOrphan')) $('btnCheckOrphan').addEventListener('click', checkOrphan);
if ($('btnCleanup')) {
  $('btnCleanup').addEventListener('click', async () => {
    if (!confirm('确定要删除这些残留分片吗？\n（已装的模型不受影响）')) return;
    $('btnCleanup').disabled = true;
    try {
      const r = await post('/api/cleanup', { dryRun: false });
      toast(`已清理 ${r.removed} 个分片，释放 ${r.freedGB} GB`);
      await checkOrphan();
      loadSpace().catch(() => {});
    } catch (e) { toast(e.message); }
    $('btnCleanup').disabled = false;
  });
}
if ($('btnReport')) {
  $('btnReport').addEventListener('click', () => {
    window.open('/api/report', '_blank');
    toast('诊断报告已开始下载');
  });
}

/* ------------------------------------------------------------ 首次使用引导 */

const TOUR_KEY = 'localai-tour-done';

/** 三套引导：第一次用 / 出问题时 / 想换模型 */
let tourScenario = 'first';
let tourIndex = 0;

function tourSteps() {
  const all = (window.Guidance && Guidance.TOURS) || {};
  return all[tourScenario] || all.first || [];
}

function tourRender() {
  const steps = tourSteps();
  if (!steps.length) return;
  const step = steps[tourIndex];
  $('tourStep').textContent = `${tourIndex + 1} / ${steps.length}`;
  $('tourTitle').textContent = step.title;
  $('tourText').textContent = step.text;
  $('tourDots').innerHTML = steps.map((_, i) =>
    `<i class="${i === tourIndex ? 'on' : ''}"></i>`).join('');
  $('tourPrev').disabled = tourIndex === 0;
  $('tourNext').textContent = tourIndex === steps.length - 1 ? '开始使用' : '下一步';
}

function tourOpen(scenario) {
  tourScenario = scenario || 'first';
  tourIndex = 0;
  $('tourMask').hidden = false;
  tourRender();
}

function tourClose() {
  $('tourMask').hidden = true;
  try { localStorage.setItem(TOUR_KEY, '1'); } catch { /* ignore */ }
}

if ($('tourNext')) {
  $('tourNext').addEventListener('click', () => {
    const steps = tourSteps();
    if (tourIndex >= steps.length - 1) tourClose();
    else { tourIndex += 1; tourRender(); }
  });
}
if ($('tourPrev')) {
  $('tourPrev').addEventListener('click', () => {
    if (tourIndex > 0) { tourIndex -= 1; tourRender(); }
  });
}
if ($('tourSkip')) $('tourSkip').addEventListener('click', tourClose);
if ($('tourMask')) {
  $('tourMask').addEventListener('click', (e) => { if (e.target === $('tourMask')) tourClose(); });
}

// 第一次打开才引导
try {
  if (!localStorage.getItem(TOUR_KEY)) setTimeout(() => tourOpen('first'), 600);
} catch { /* ignore */ }

/* ------------------------------------------------------------ 通知中心 */

const notifications = [];
let unread = 0;

/** 记一条通知 */
function notify(title, detail, tone) {
  notifications.unshift({ title, detail: detail || '', tone: tone || 'info', at: Date.now() });
  if (notifications.length > 50) notifications.pop();
  unread += 1;
  renderNotifications();
}

function renderNotifications() {
  const bell = $('bellCount');
  if (bell) {
    bell.textContent = unread > 9 ? '9+' : String(unread);
    bell.hidden = unread === 0;
  }
  const list = $('notifList');
  if (!list) return;
  list.innerHTML = notifications.length
    ? notifications.map((n) => `<li class="notif ${esc(n.tone)}">
        <div class="nt">${esc(n.title)}</div>
        ${n.detail ? `<div class="nd">${esc(n.detail)}</div>` : ''}
        <div class="nw">${new Date(n.at).toLocaleTimeString()}</div>
      </li>`).join('')
    : '<li class="none">还没有通知</li>';
}

if ($('btnBell')) {
  $('btnBell').addEventListener('click', () => {
    unread = 0;
    renderNotifications();
    const panel = $('notifPanel');
    panel.hidden = !panel.hidden;
  });
}
if ($('btnNotifClear')) {
  $('btnNotifClear').addEventListener('click', () => {
    notifications.length = 0;
    unread = 0;
    renderNotifications();
  });
}

/* ------------------------------------------------------------------ 服务 */

const SVC_ACTIONS = {
  engine: { label: '启动引擎', ok: '引擎运行中' },
  webui: { label: '启动 WebUI', ok: 'WebUI 运行中' },
  workbench: { label: '启动工作台', ok: '工作台运行中' },
  stop: { label: '停止全部服务', ok: '服务已停止' },
};

function renderServices() {
  const box = $('svcCards');
  const strata = state && state.strata;
  const cards = [];

  if (strata) {
    for (const name of ['engine', 'webui', 'dsh']) {
      const s = strata[name];
      const port = strata.ports[name === 'dsh' ? 'dsh' : name === 'webui' ? 'webui' : 'engine'];
      const label = name === 'engine' ? 'Strata 引擎' : name === 'webui' ? 'WebUI（聊天/文件）' : 'DeepSeek Harness';
      const action = name === 'dsh' ? 'workbench' : name;
      cards.push({
        key: name, title: label, port,
        online: !!s.online,
        detail: s.startupError || (s.online ? '运行中' : '未就绪'),
        error: !!s.startupError,
        action: s.online ? null : action,
      });
    }
  }

  // Ollama 那一侧（两种部署都有可能是真的在跑）
  cards.push({
    key: 'ollama', title: 'Ollama（模型服务）',
    port: 11434,
    online: !!(state && state.running),
    detail: state && state.running ? `运行中 · ${(state.models || []).length} 个模型` : '未运行',
    error: false,
    action: state && state.running ? null : 'ollama',
  });

  box.innerHTML = cards.map((c) => `
    <div class="svccard ${c.online ? 'on' : 'off'}">
      <div class="svchead">
        <span class="dot"></span>
        <b>${esc(c.title)}</b>
        <span class="svcdot">:${c.port}</span>
      </div>
      <div class="svcdetail ${c.error ? 'bad' : ''}">${esc(c.detail)}</div>
      ${c.action ? `<button class="btn ghost small" data-svc="${esc(c.action)}">${esc((SVC_ACTIONS[c.action] || {}).label || '启动')}</button>` : ''}
    </div>`).join('');

  for (const b of box.querySelectorAll('[data-svc]')) {
    b.addEventListener('click', async () => {
      const action = b.dataset.svc;
      b.disabled = true;
      b.textContent = '处理中…';
      try {
        if (action === 'ollama') {
          await post('/api/settings', { ensureOllama: true });
          toast('Ollama 已启动');
        } else {
          const out = await post('/api/strata/service', { action });
          toast(out.message || '已处理');
        }
        setTimeout(() => loadState().catch(() => {}), 1200);
      } catch (e) { toast(e.message); }
      b.disabled = false;
    });
  }

  const actions = $('svcActions');
  actions.innerHTML = strata
    ? '<button class="btn ghost danger" id="svcStopAll">停止全部服务</button>'
    : '<button class="btn ghost small" id="btnStartSvc2">启动工作台</button><button class="btn ghost small" id="btnStopSvc2">停止服务并释放显存</button>';
  $('svcHint2').textContent = strata
    ? '「停止全部服务」会关掉引擎、WebUI 和工作台，显存会立刻释放。'
    : '停止服务会把显存还给游戏和渲染软件。';

  if ($('svcStopAll')) {
    $('svcStopAll').addEventListener('click', async () => {
      if (!confirm('确定要停止全部服务吗？\n（引擎、WebUI、工作台都会关掉，显存会释放）')) return;
      try {
        const out = await post('/api/strata/service', { action: 'stop' });
        toast(out.message || '已停止');
        setTimeout(() => loadState().catch(() => {}), 1500);
      } catch (e) { toast(e.message); }
    });
  }
  if ($('btnStartSvc2')) {
    $('btnStartSvc2').addEventListener('click', async () => {
      try { await post('/api/service', { action: 'start' }); toast('已启动'); } catch (e) { toast(e.message); }
    });
  }
  if ($('btnStopSvc2')) {
    $('btnStopSvc2').addEventListener('click', async () => {
      try { await post('/api/service', { action: 'stop' }); toast('已停止'); } catch (e) { toast(e.message); }
    });
  }
}

/* --------------------------------------------------------- 显卡告警 */

/**
 * 温度 / 功耗告警。
 *
 * 显卡过热会自己降频 —— 用户会以为「模型变慢了」，其实是温度上去了。
 * 温度超过 85°C 一般就该看看散热了。
 */
function gpuAlert(gpu) {
  if (!gpu) return null;
  if (gpu.temperature != null && gpu.temperature >= 85) {
    return `⚠️ 显卡 ${gpu.temperature}°C，偏热了 —— 过热会降速，模型可能「莫名其妙变慢」`;
  }
  if (gpu.temperature != null && gpu.temperature >= 78) {
    return `显卡 ${gpu.temperature}°C，温度偏高`;
  }
  return null;
}

/* --------------------------------------------------------- 显存分账 */

/**
 * 把显存拆成三块：模型权重 / KV cache / 其它占用。
 *
 * 用户只会问一句「我的显存怎么满了」—— 拆开看才知道该关上下文还是该换模型。
 * KV cache 用的是和安装向导同一套估算公式（按参数量线性缩放）。
 */
function renderVramBreakdown(m) {
  const box = $('dashVram');
  if (!box) return;
  const gpu = (m.gpu || [])[0];
  if (!gpu || !gpu.memoryTotalMB) {
    box.innerHTML = '<div class="chart-empty">没有独立显卡，无法拆分显存占用。</div>';
    return;
  }
  const totalGB = gpu.memoryTotalMB / 1024;
  const usedGB = (gpu.memoryUsedMB || 0) / 1024;

  const running = (m.ollama && m.ollama.models) || [];
  let weights = 0;
  let kv = 0;
  const ctxWindow = (ctxState && ctxState.contextWindow) || 8192;
  for (const r of running) {
    const w = r.sizeGB || 0;
    weights += w;
    // KV cache ≈ 每 1K token 的开销 × 上下文长度；用参数量反推
    const params = estimateParams(r.name);
    const per1k = 0.092 * ((params || 8) / 27);
    kv += per1k * (ctxWindow / 1000);
  }
  weights = Math.min(weights, usedGB);
  kv = Math.min(kv, Math.max(0, usedGB - weights));
  const other = Math.max(0, usedGB - weights - kv);
  const free = Math.max(0, totalGB - usedGB);

  const parts = [
    { label: '模型权重', value: weights, text: `${weights.toFixed(1)} GB`, tone: 'good' },
    { label: 'KV cache', value: kv, text: `${kv.toFixed(1)} GB`, tone: 'warn' },
    { label: '其它程序', value: other, text: `${other.toFixed(1)} GB` },
    { label: '空闲', value: free, text: `${free.toFixed(1)} GB` },
  ];
  const pct = Math.round((usedGB / totalGB) * 100);
  // 显存被模型占的不到一半 → 说明大头是别的程序（游戏、渲染软件、别的 AI）
  const note = other > weights + kv && other > 2
    ? '⚠️ 显存的大头不是模型占的 —— 可能是游戏、渲染软件或别的 AI 程序，关掉它们能立刻腾出空间。'
    : '上下文越大，KV cache 占得越多 —— 上下文从 8K 开到 32K，光 KV cache 就会多吃几 GB。';
  box.innerHTML = `
    <div class="vram-split">
      <div class="vs-chart">${Chart.waterfall(parts, { width: 360, labelW: 78, valueW: 62 })}</div>
      <div class="vs-ring">${Chart.ring(pct, { label: '显存已用', size: 128 })}</div>
    </div>
    <p class="row-hint" style="margin-top:10px">${note}
      ${running.length ? `当前上下文 ${ctxWindow} tokens。` : '现在没有模型驻留显存。'}
    </p>`;
}

/** 从模型名里粗略猜参数量（B）—— 名字里带数字的按那个算 */
function estimateParams(name) {
  const s = String(name || '');
  const m = /(\d+(?:\.\d+)?)\s*b/i.exec(s);
  if (m) return Number(m[1]);
  if (/0\.5b|1\.5b/.test(s)) return 0.5;
  return 8;
}

/* ------------------------------------------------------------ 快速操作 */

/** 首页那排「快速操作」按钮 */
const QUICK_ACTIONS = {
  models: () => gotoTab('models'),
  health: () => { gotoTab('health'); $('btnHealth') && $('btnHealth').click(); },
  bench: () => { gotoTab('bench'); $('btnBench') && $('btnBench').click(); },
  play: () => { gotoTab('play'); $('playInput') && $('playInput').focus(); },
  backup: () => { gotoTab('settings'); $('btnExportCfg') && $('btnExportCfg').click(); },
  report: () => { gotoTab('tools'); $('btnReport') && $('btnReport').click(); },
  fix: () => { gotoTab('fix'); $('btnDiagnose') && $('btnDiagnose').click(); },
};

for (const b of document.querySelectorAll('[data-quick]')) {
  b.addEventListener('click', () => {
    const fn = QUICK_ACTIONS[b.dataset.quick];
    if (fn) fn();
  });
}

/* ------------------------------------------------------------ 对话导出 */

/** 把当前对话导成 Markdown */
function chatMarkdown() {
  const lines = [`# 与 ${$('playModel').value || '本地模型'} 的对话`, '', `> 导出于 ${new Date().toLocaleString()}`, ''];
  for (const m of playMessages()) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    lines.push(`**${m.role === 'user' ? '我' : '模型'}**`, '', m.content, '');
  }
  return lines.join('\n');
}

if ($('btnExportChat')) {
  $('btnExportChat').addEventListener('click', () => {
    if (!playMessages().length) { toast('还没有对话'); return; }
    const blob = new Blob([chatMarkdown()], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `localai-chat-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('已导出为 Markdown');
  });
}
if ($('btnCopyChat')) {
  $('btnCopyChat').addEventListener('click', async () => {
    if (!playMessages().length) { toast('还没有对话'); return; }
    try {
      await navigator.clipboard.writeText(chatMarkdown());
      toast('已复制到剪贴板');
    } catch (e) { toast('复制失败：' + e.message); }
  });
}

/* ------------------------------------------------------- 配置检查点 */

/**
 * 配置差异弹窗。
 *
 * 回滚是不可逆操作（虽然会先备份），所以点之前得让用户看到会改掉什么。
 * 只列有变化的项，没变的折成一句「其余 N 项没变」。
 */
async function showConfigDiff(file) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = '<div class="modal"><p>正在对比…</p></div>';
  mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
  document.body.appendChild(mask);

  try {
    const r = await (await fetch(`/api/config/diff?file=${encodeURIComponent(file)}`)).json();
    if (r.error) throw new Error(r.error);

    const row = (cls, label, from, to) => `
      <div class="diff-row ${cls}">
        <span class="diff-k">${esc(label)}</span>
        <span class="diff-v">${from === undefined ? '<i class="dim">（原本没有）</i>' : esc(from)}</span>
        ${to === undefined ? '' : `<span class="diff-arrow">→</span><span class="diff-v to">${esc(to)}</span>`}
      </div>`;

    const body = !r.total
      ? '<p>这份检查点和当前配置<b>完全一样</b>，回滚不会有任何变化。</p>'
      : `
        ${r.changed.length ? `<div class="diff-sec">改过的 ${r.changed.length} 项</div>
          ${r.changed.map((x) => row('changed', x.label, x.from, x.to)).join('')}` : ''}
        ${r.added.length ? `<div class="diff-sec">新增的 ${r.added.length} 项</div>
          ${r.added.map((x) => row('added', x.label, undefined, x.to)).join('')}` : ''}
        ${r.removed.length ? `<div class="diff-sec">删掉的 ${r.removed.length} 项</div>
          ${r.removed.map((x) => row('removed', x.label, x.from, undefined)).join('')}` : ''}
        ${r.same ? `<p class="modal-hint">其余 ${r.same} 项没有变化。</p>` : ''}`;

    mask.innerHTML = `<div class="modal" style="max-width:560px">
      <h2>这个检查点 vs 当前配置</h2>
      <p class="modal-hint">${new Date(r.at).toLocaleString()} 的快照。箭头左边是快照里的值，右边是现在的值。</p>
      <div class="diff-list">${body}</div>
      <div class="modal-actions">
        <button class="btn ghost" id="diffClose">知道了</button>
      </div>
    </div>`;
    $('diffClose').addEventListener('click', () => mask.remove());
  } catch (e) {
    mask.innerHTML = `<div class="modal">
      <h2>对比失败</h2><p>${esc(e.message)}</p>
      <div class="modal-actions"><button class="btn ghost" id="diffClose">关闭</button></div>
    </div>`;
    $('diffClose').addEventListener('click', () => mask.remove());
  }
}

async function loadCheckpoints() {
  const box = $('checkpointList');
  if (!box) return;
  try {
    const r = await (await fetch('/api/config/checkpoints')).json();
    if (!r.items.length) {
      box.innerHTML = '<div class="empty"><b>还没有检查点。</b>改一次配置就会自动留一份。</div>';
      return;
    }
    box.innerHTML = r.items.map((c) => `
      <div class="mrow">
        <div class="mi">
          <div class="mn">${new Date(c.at).toLocaleString()}</div>
          <div class="ms">${esc(c.file)} · ${Math.round(c.size / 1024)} KB</div>
        </div>
        <div class="ma">
          <button class="btn ghost small" data-diff="${esc(c.file)}">看差异</button>
          <button class="btn ghost small" data-restore="${esc(c.file)}">回滚到这里</button>
        </div>
      </div>`).join('');
    for (const b of box.querySelectorAll('[data-diff]')) {
      b.addEventListener('click', () => showConfigDiff(b.dataset.diff));
    }
    for (const b of box.querySelectorAll('[data-restore]')) {
      b.addEventListener('click', async () => {
        if (!confirm(`确定要回滚到 ${b.dataset.restore} 吗？\n（当前配置会先另存一份，回滚错了还能再退回来）`)) return;
        try {
          await post('/api/config/restore', { file: b.dataset.restore });
          toast('已回滚');
          await loadState();
          await loadCheckpoints();
        } catch (e) { toast(e.message); }
      });
    }
  } catch (e) {
    box.innerHTML = `<div class="issue error">读取失败：${esc(e.message)}</div>`;
  }
}

/* ------------------------------------------------------------ 用量统计 */

/** 用量统计：每天消耗了多少 token */
async function loadUsage() {
  const box = $('dashUsage');
  if (!box) return;
  try {
    const r = await (await fetch('/api/usage')).json();
    const items = r.items || [];
    if (!items.length) {
      box.innerHTML = '<div class="chart-empty">在「试用」页聊过之后这里会有记录</div>';
      return;
    }
    const points = items.map((u) => ({
      label: u.day.slice(5),
      value: u.tokens,
      text: `${u.tokens} tokens`,
    }));
    const total = items.reduce((n, u) => n + u.tokens, 0);
    const calls = items.reduce((n, u) => n + u.calls, 0);
    const top = Object.entries(items.reduce((acc, u) => {
      for (const [m, t] of Object.entries(u.models || {})) acc[m] = (acc[m] || 0) + t;
      return acc;
    }, {}))
      .sort((a, b) => b[1] - a[1]).slice(0, 3);
    box.innerHTML = Chart.line(points, { width: 460, height: 150, min: 0 })
      + `<p class="row-hint" style="margin-top:8px">共 ${total.toLocaleString()} tokens / ${calls} 次对话`
      + (top.length ? `，用得最多的是 ${top.map(([m, t]) => `${esc(m)}（${t.toLocaleString()}）`).join('、')}` : '')
      + '。这里只统计「试用」页的对话，工作台里的用量统计不到（那是另一套 API）。</p>';
  } catch (e) {
    box.innerHTML = `<div class="chart-empty">读取失败：${esc(e.message)}</div>`;
  }
}

/* ------------------------------------------------------------ 界面缩放 */

const ZOOM_KEY = 'localai-zoom';

function applyZoom(percent) {
  const p = Math.max(85, Math.min(140, Number(percent) || 100));
  document.documentElement.style.fontSize = `${(p / 100) * 14}px`;
  try { localStorage.setItem(ZOOM_KEY, String(p)); } catch { /* ignore */ }
  const label = $('zoomValue');
  if (label) label.textContent = `${p}%`;
  const range = $('zoomRange');
  if (range && Number(range.value) !== p) range.value = String(p);
}

(function initZoom() {
  let saved = 100;
  try { saved = Number(localStorage.getItem(ZOOM_KEY)) || 100; } catch { saved = 100; }
  applyZoom(saved);
})();

if ($('zoomRange')) {
  $('zoomRange').addEventListener('input', (e) => applyZoom(e.target.value));
}

/* ------------------------------------------------------------------ 帮助 */

/** 帮助页：把「这个页面能干什么」写成一张卡片表 */
const HELP_CARDS = [
  { tab: 'dashboard', icon: '📊', title: '系统概览', text: '显存 / CPU / 内存 / 磁盘实时占用。停服务前先看一眼，确认显存还回去了。' },
  { tab: 'models', icon: '📦', title: '模型管理', text: '装模型、删模型、看空间。还能搜官方模型库，几百个模型里挑。' },
  { tab: 'play', icon: '💬', title: '试用', text: '直接跟模型对话。换个模型试效果、调提示词、看每秒多少 token。' },
  { tab: 'compare', icon: '⚖️', title: '模型对比', text: '同一个问题问几个模型，并排比答案和速度。' },
  { tab: 'bench', icon: '⏱️', title: '性能基准', text: '分开测「生成慢」和「读上下文慢」—— 这两种解法不一样。' },
  { tab: 'context', icon: '🧮', title: '上下文与模型', text: '改窗口大小和压缩参数。压力预算变负数就是「聊久了变短」的根因。' },
  { tab: 'health', icon: '🩺', title: '模型体检', text: '觉得模型变笨了先测一次，分清是能力问题还是配置问题。' },
  { tab: 'fix', icon: '🔧', title: '修复中心', text: '十项体检 + 一键修复。不用重装。' },
  { tab: 'tools', icon: '🧰', title: '诊断与维护', text: '查网络、清下载残留、导出诊断报告。' },
  { tab: 'services', icon: '🔌', title: '服务', text: '哪些东西在跑、怎么启停。一页看全。' },
  { tab: 'settings', icon: '⚙️', title: '服务设置', text: '开机自启、局域网共享、备份配置、快捷键、主题。' },
];

function renderHelp() {
  const box = $('helpGrid');
  if (!box) return;
  box.innerHTML = HELP_CARDS.map((c) => `
    <button class="helpcard" data-goto="${esc(c.tab)}">
      <div class="hc-ico">${c.icon}</div>
      <div class="hc-t">${esc(c.title)}</div>
      <div class="hc-d">${esc(c.text)}</div>
    </button>`).join('');
  bindGoto(box);
}

/* --------------------------------------------------------- 磁盘健康 */

async function loadDisks() {
  const box = $('dashDisks');
  if (!box) return;
  try {
    const r = await (await fetch('/api/disks')).json();
    const items = r.items || [];
    if (!items.length) {
      box.innerHTML = '<div class="chart-empty">系统没有提供磁盘信息（老版本 Windows 或存储服务没开）。</div>';
      return;
    }
    const rows = items.map((d) => `
      <div class="diskrow ${d.level}">
        <div class="dl">
          <b>${esc(d.letter || '')} ${esc(d.name)}</b>
          <span class="dm">${esc(d.mediaText)}${d.sizeGB ? ` · ${d.sizeGB} GB` : ''}</span>
        </div>
        <div class="dh">
          <span class="dlevel ${d.level}">${d.level === 'error' ? '异常' : d.level === 'warn' ? '注意' : '正常'}</span>
          <span class="dn">${esc(d.note)}</span>
        </div>
        <div class="dmeta">
          ${d.temp != null ? `<span>${d.temp}°C</span>` : ''}
          ${d.lifeLeft != null ? `<span>寿命 ${d.lifeLeft}%</span>` : ''}
          ${d.powerOnHours != null ? `<span>通电 ${Math.round(d.powerOnHours)} 小时</span>` : ''}
        </div>
      </div>`).join('');
    const advice = (r.summary || []).map((s) => `<div class="row"><span class="k">·</span><span class="v">${esc(s)}</span></div>`).join('');
    const model = r.modelDisk
      ? `<div class="row"><span class="k">模型所在盘</span><span class="v">${esc(r.modelDisk.letter)} ${esc(r.modelDisk.name)} —— ${esc(r.modelDisk.note)}</span></div>`
      : '';
    box.innerHTML = rows + (advice || model ? `<div class="summary" style="margin-top:12px">${advice}${model}</div>` : '');
  } catch (e) {
    box.innerHTML = `<div class="chart-empty">读取失败：${esc(e.message)}</div>`;
  }
}

/* ------------------------------------------------------- 模型实测排行 */

function renderRanking(data) {
  const box = $('rankingResult');
  if (!box) return;
  const results = (data && data.results) || [];
  if (!results.length) {
    box.innerHTML = '<div class="empty"><b>还没有排行数据。</b>点「开始实测排行」，用同一套题把已装的模型挨个测一遍。</div>';
    return;
  }
  const rows = results.map((r) => {
    const ok = r.error ? 'error' : r.passed === r.total ? 'ok' : 'warn';
    return `<div class="rankrow ${ok}">
      <div class="rk">#${r.rank || '-'}</div>
      <div class="rm">
        <div class="rn">${esc(r.model)}</div>
        <div class="rs">${r.error ? esc(r.error) : `通过 ${r.passed}/${r.total}${r.share != null ? ` · 采样一致 ${Math.round(r.share * 100)}%` : ''}${r.elapsed ? ` · ${r.elapsed}s` : ''}`}</div>
      </div>
      <div class="rp">${r.error ? '—' : `${Math.round((r.rate || 0) * 100)}%`}</div>
    </div>`;
  }).join('');
  const advice = ((data && data.advice) || []).map((a) =>
    `<div class="row"><span class="k">·</span><span class="v">${esc(a)}</span></div>`).join('');
  box.innerHTML = rows + (advice ? `<div class="summary" style="margin-top:12px">${advice}</div>` : '');
}

async function startRanking() {
  const models = (state.models || []).map((m) => m.name);
  if (!models.length) { toast('先装一个模型'); return; }
  $('rankWrap').hidden = false;
  $('rankBar').style.width = '0%';
  $('rankPct').textContent = '0%';
  $('rankTitle').textContent = '准备中…';
  $('rankingResult').innerHTML = '<div class="loading"><span class="spinner"></span> 开始实测…</div>';
  try {
    await post('/api/ranking', { models });
  } catch (e) {
    toast(e.message);
    $('rankWrap').hidden = true;
  }
}

/** 打开页面时把上次的排行结果带出来 */
async function loadRanking() {
  try {
    const r = await (await fetch('/api/ranking')).json();
    if (r && (r.results || []).length) renderRanking(r);
  } catch { /* ignore */ }
}

if ($('btnRanking')) $('btnRanking').addEventListener('click', startRanking);

/* ---------------------------------------------------------------- 修复中心 */

const FIX_LEVEL = { ok: { text: '正常', cls: 'ok' }, warn: { text: '注意', cls: 'warn' }, error: { text: '有问题', cls: 'error' } };
let lastDiagnoseAt = 0;

function renderFix(report) {
  const list = $('fixList');
  const summary = $('fixSummary');
  if (!report) {
    list.innerHTML = emptyBox('services');
    return;
  }
  const problems = (report.checks || []).filter((c) => c.level !== 'ok');
  const level = FIX_LEVEL[report.level] || FIX_LEVEL.ok;
  summary.className = `fix-summary ${level.cls}`;
  summary.innerHTML = problems.length
    ? `<b>发现 ${problems.length} 个问题</b><span>${esc(problems.map((c) => c.label).join('、'))}</span>`
    : '<b>一切正常</b><span>这套配置现在是可以用的。</span>';

  // 有问题就提醒一下，并给出「怎么排查」的引导入口
  if (problems.length && report.at && report.at !== lastDiagnoseAt) {
    lastDiagnoseAt = report.at;
    notify(`体检发现 ${problems.length} 个问题`, problems.map((c) => c.label).join('、'), 'warn');
  }

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

/* ------------------------------------------------------------ 命令面板 */

/**
 * 命令面板：Ctrl+K 打开。
 *
 * 页面已经有 9 个标签页、几十个按钮，光靠鼠标找会很累。
 * 一个输入框就能跳到任何地方 —— 顺便也是最快的「这软件能干什么」说明书。
 */
const COMMANDS = [
  { name: '系统概览', hint: '页面', run: () => gotoTab('dashboard') },
  { name: '模型管理', hint: '页面', run: () => gotoTab('models') },
  { name: '试用', hint: '页面', run: () => gotoTab('play') },
  { name: '模型对比', hint: '页面', run: () => gotoTab('compare') },
  { name: '性能基准', hint: '页面', run: () => gotoTab('bench') },
  { name: '上下文与模型', hint: '页面', run: () => gotoTab('context') },
  { name: '模型体检', hint: '页面', run: () => gotoTab('health') },
  { name: '修复中心', hint: '页面', run: () => gotoTab('fix') },
  { name: '诊断与维护', hint: '页面', run: () => gotoTab('tools') },
  { name: '服务', hint: '页面', run: () => gotoTab('services') },
  { name: '服务设置', hint: '页面', run: () => gotoTab('settings') },

  { name: '开始体检', hint: '动作', run: () => { gotoTab('health'); $('btnHealth') && $('btnHealth').click(); } },
  { name: '快速体检（跳过 32K）', hint: '动作', run: () => { gotoTab('health'); $('btnHealthQuick') && $('btnHealthQuick').click(); } },
  { name: '开始测速', hint: '动作', run: () => { gotoTab('bench'); $('btnBench') && $('btnBench').click(); } },
  { name: '重新检查（修复中心）', hint: '动作', run: () => { gotoTab('fix'); $('btnDiagnose') && $('btnDiagnose').click(); } },
  { name: '检查网络', hint: '动作', run: () => { gotoTab('tools'); $('btnNetCheck') && $('btnNetCheck').click(); } },
  { name: '检查下载残留', hint: '动作', run: () => { gotoTab('tools'); $('btnCheckOrphan') && $('btnCheckOrphan').click(); } },
  { name: '下载诊断报告', hint: '动作', run: () => { gotoTab('tools'); $('btnReport') && $('btnReport').click(); } },
  { name: '刷新状态', hint: '动作', run: () => { loadState(); toast('已刷新'); } },
  { name: '搜官方模型库', hint: '动作', run: () => { gotoTab('models'); $('libBox').open = true; $('libQuery').focus(); } },
  { name: '搜索已装模型', hint: '动作', run: () => { gotoTab('models'); $('modelSearch').focus(); } },
  { name: '查看日志', hint: '动作', run: () => { gotoTab('settings'); $('btnShowLog').click(); } },
  { name: '下载日志', hint: '动作', run: () => { gotoTab('settings'); $('btnDownloadLog').click(); } },
  { name: '检查更新', hint: '动作', run: () => { gotoTab('settings'); $('btnCheckVersion').click(); } },
  { name: '导出配置', hint: '动作', run: () => { gotoTab('settings'); $('btnExportCfg').click(); } },
  { name: '导入配置', hint: '动作', run: () => { gotoTab('settings'); $('btnImportCfg').click(); } },
  { name: '切换主题', hint: '动作', run: () => $('btnTheme').click() },
  { name: '用不上时怎么排查', hint: '引导', run: () => tourOpen('broken') },
  { name: '怎么换模型', hint: '引导', run: () => tourOpen('swap') },
  { name: '重新看一遍使用引导', hint: '引导', run: () => tourOpen('first') },
  { name: '停止服务并释放显存', hint: '动作', run: () => { gotoTab('settings'); $('btnStopSvc').click(); } },
  { name: '启动工作台', hint: '动作', run: () => { gotoTab('settings'); $('btnStartSvc').click(); } },
];

function gotoTab(name) {
  const li = document.querySelector(`#tabs li[data-tab="${name}"]`);
  if (li) li.click();
}

let paletteIndex = 0;
let paletteHits = [];

function paletteRender() {
  const q = $('paletteInput').value.trim().toLowerCase();
  let hits = COMMANDS.filter((c) => !q || c.name.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q));

  // 已装的模型也能搜到：搜到就能直接拿去聊
  const models = (state && state.models) || [];
  for (const m of models) {
    if (!q || m.name.toLowerCase().includes(q)) {
      hits.push({
        name: m.name,
        hint: '已装模型',
        run: () => {
          gotoTab('play');
          const sel = $('playModel');
          if (sel) sel.value = m.name;
          const input = $('playInput');
          if (input) input.focus();
        },
      });
    }
  }

  paletteHits = hits;
  paletteIndex = 0;
  $('paletteList').innerHTML = paletteHits.length
    ? paletteHits.map((c, i) => `<li class="${i === 0 ? 'on' : ''}" data-i="${i}">
        <span class="pn">${esc(c.name)}</span><span class="ph">${esc(c.hint)}</span></li>`).join('')
    : '<li class="none">没有匹配的命令</li>';
  for (const li of $('paletteList').querySelectorAll('[data-i]')) {
    li.addEventListener('click', () => paletteRun(Number(li.dataset.i)));
  }
}

function paletteRun(i) {
  const cmd = paletteHits[i];
  if (!cmd) return;
  paletteClose();
  try { cmd.run(); } catch (e) { toast(e.message); }
}

function paletteOpen() {
  $('paletteMask').hidden = false;
  $('paletteInput').value = '';
  paletteRender();
  $('paletteInput').focus();
}

function paletteClose() {
  $('paletteMask').hidden = true;
}

if ($('paletteInput')) {
  $('paletteInput').addEventListener('input', paletteRender);
  $('paletteInput').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { paletteIndex = Math.min(paletteIndex + 1, paletteHits.length - 1); paletteRender(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { paletteIndex = Math.max(paletteIndex - 1, 0); paletteRender(); e.preventDefault(); }
    else if (e.key === 'Enter') { paletteRun(paletteIndex); e.preventDefault(); }
    else if (e.key === 'Escape') { paletteClose(); e.preventDefault(); }
  });
}
if ($('paletteMask')) {
  $('paletteMask').addEventListener('click', (e) => { if (e.target === $('paletteMask')) paletteClose(); });
}

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
      box.innerHTML = emptyBox('health');
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
      loadTrend('bench').catch(() => {});
    } else if (ev.type === 'ranking-progress') {
      $('rankWrap').hidden = false;
      const pct = Math.max(0, Math.min(100, ev.percent || 0));
      $('rankBar').style.width = `${pct}%`;
      $('rankPct').textContent = `${pct}%`;
      $('rankTitle').textContent = `正在测 ${ev.model}（${ev.index + 1}/${ev.total}）`;
    } else if (ev.type === 'ranking-item') {
      $('rankTitle').textContent = `已测完 ${ev.index + 1}/${ev.total}`;
    } else if (ev.type === 'ranking-done') {
      $('rankWrap').hidden = true;
      $('rankingHint').textContent = '测完了。';
      renderRanking({ results: ev.results, advice: ev.advice });
    } else if (ev.type === 'queue') {
      renderQueue(ev.state);
      for (const it of (ev.state && ev.state.items) || []) {
        if (it._notified) continue;
        if (it.status === 'done') {
          it._notified = true;
          notify(`「${it.model}」下载完成`, '可以在「试用」页直接跟它对话了', 'ok');
        } else if (it.status === 'error') {
          it._notified = true;
          notify(`「${it.model}」下载失败`, it.error || '', 'error');
        }
      }
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
      loadTrend('health').catch(() => {});
      const rate = ev.summary && ev.summary.eval ? Math.round(ev.summary.eval.rate * 100) : null;
      if (ev.ok) notify('体检全部达标', rate != null ? `质量基线通过率 ${rate}%` : '', 'ok');
      else notify('体检有不达标项', '去「模型体检」看是哪一类掉了', 'warn');
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

  if ($('btnBatchDel')) {
    $('btnBatchDel').addEventListener('click', async () => {
      const picked = Array.from(document.querySelectorAll('[data-pick]:checked')).map((i) => i.dataset.pick);
      if (!picked.length) return;
      // 使用中的模型不能删 —— 删了工作台就起不来了
      if (state.model && picked.includes(state.model)) {
        toast(`「${state.model}」是正在用的模型，不能一起删`);
        return;
      }
      const total = picked.reduce((n, m) => {
        const hit = (state.models || []).find((x) => x.name === m);
        return n + (hit ? hit.sizeGB : 0);
      }, 0);
      if (!confirm(`确定要删除这 ${picked.length} 个模型吗？\n会释放约 ${total.toFixed(1)} GB 空间。`)) return;
      let done = 0;
      for (const m of picked) {
        try {
          await post('/api/delete', { model: m });
          done += 1;
        } catch (e) { toast(`${m}：${e.message}`); }
      }
      toast(`已删除 ${done} 个模型`);
      await loadState();
    });
  }

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
      const cur = currentTheme();
      const idx = THEMES.findIndex((t) => t.id === cur);
      const next = THEMES[(idx + 1) % THEMES.length];
      applyTheme(next.id);
      toast(`主题：${next.label}`);
    });
  }

  /* ---- 离线安装包 ---- */
  if ($('btnPackage')) {
    $('btnPackage').addEventListener('click', async () => {
      const btn = $('btnPackage');
      btn.disabled = true;
      btn.textContent = '打包中…';
      $('pkgHint').textContent = '正在打包，请稍候（文件多的时候要十几秒）…';
      try {
        const out = await post('/api/package', { withNode: $('pkgWithNode').checked });
        $('pkgHint').innerHTML = `已生成：<code>${esc(out.zip || out.dir)}</code><br>`
          + '拷到目标机器上解压，双击「① 双击这里开始安装.cmd」即可。';
        toast('离线安装包已生成');
      } catch (e) {
        $('pkgHint').textContent = `打包失败：${e.message}`;
        toast(e.message);
      }
      btn.disabled = false;
      btn.textContent = '生成离线安装包';
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

// 深链：#context / #settings / #palette / #tour
{
  const want = (location.hash || '').replace('#', '');
  const hit = want && document.querySelector(`#tabs li[data-tab="${want}"]`);
  if (hit) hit.click();
  else if (want === 'palette') paletteOpen();
  else if (want === 'tour') tourOpen();
}

// 每 5 秒刷新一次状态（服务启停、模型增删后自动跟上）
setInterval(() => { loadState().catch(() => {}); }, 5000);


/* 帮助按钮：跳「帮助」页（那里是按场景分好的卡片），不是设置页 */
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('btnHelp');
  if (btn) {
    btn.addEventListener('click', () => {
      if (typeof gotoTab === 'function') gotoTab('help');
    });
  }
  const markChat = () => {
    if (location.hash === '#play') localStorage.setItem('lak_chatted', '1');
  };
  window.addEventListener('hashchange', () => { markChat(); if (typeof renderChecklist === 'function') renderChecklist(); });
});


/* 诊断包：直接开新窗口下载，浏览器会按 Content-Disposition 存成 zip */
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('btnBundle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '打包中…';
    // 用 fetch 先探一次，失败能给出提示；成功再交给浏览器下载
    fetch('/api/diagnose/bundle', { headers: { 'x-localai-token': window.__TOKEN__ || '' } })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `local-ai-诊断包-${new Date().toISOString().slice(0, 10)}.zip`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        if (typeof toast === 'function') toast('诊断包已导出');
      })
      .catch((e) => { if (typeof toast === 'function') toast(`导出失败：${e.message}`); })
      .finally(() => { btn.disabled = false; btn.textContent = old; });
  });
});


/* 模型管理页的「勾选闲置」按钮 */
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('btnPickIdle');
  if (btn) btn.addEventListener('click', () => {
    if (!Object.keys(usageMap).length) {
      if (typeof toast === 'function') toast('用量数据还没加载好，稍等一下');
      return;
    }
    pickIdleModels();
  });
});
