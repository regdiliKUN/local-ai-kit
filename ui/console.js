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

/* ------------------------------------------------------------------ 状态 */

async function loadState() {
  state = await (await fetch('/api/state')).json();
  renderStatus();
  renderModels();
  renderSettings();
  renderConfig();
  await loadContext();
}

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
  const list = state.models || [];
  $('modelCount').textContent = list.length ? `（${list.length} 个，共 ${list.reduce((n, m) => n + m.sizeGB, 0).toFixed(1)} GB）` : '';
  if (!list.length) {
    $('modelList').innerHTML = `<div class="empty">
      <b>还没有装任何模型。</b>
      用下面的「加装新模型」下一个吧 —— 也可以回到安装向导里选。
    </div>`;
    return;
  }
  $('modelList').innerHTML = list.map((m) => `
    <div class="mrow" data-model="${esc(m.name)}">
      <div class="mi">
        <div class="mn">${esc(m.name)}</div>
        <div class="ms">${esc(m.params || '')} ${esc(m.quant || '')}${m.modified ? ' · ' + esc(String(m.modified).slice(0, 10)) : ''}</div>
      </div>
      <div class="mz">${m.sizeGB} GB</div>
      <div class="ma"><button class="btn ghost small danger" data-del="${esc(m.name)}">删除</button></div>
    </div>`).join('');

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

function renderSettings() {
  $('swAutostart').checked = !!state.settings.autostart;
  $('swLan').checked = !!state.settings.lanShare;
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

  renderDiff(ctx, out, head, ratio);
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

function connectSSE() {
  const es = new EventSource('/api/events');
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
  es.onerror = () => { /* 自动重连 */ };
}

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
    $('log').textContent = '';
    showLog(true);
    $('progressWrap').hidden = false;
    $('progressTitle').textContent = `下载 ${model}`;
    $('progressPct').textContent = '0%';
    $('progressBar').style.width = '0%';
    $('progressStats').innerHTML = '';
    setBusy(true);
    try { await post('/api/pull', { model }); } catch (e) { toast(e.message); setBusy(false); }
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
