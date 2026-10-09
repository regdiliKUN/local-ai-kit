/* 本地 AI 安装向导 —— 前端逻辑 */

const $ = (id) => document.getElementById(id);

/** POST 到安装服务；必须带服务端注入的令牌，否则会被拒绝 */
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

const state = {
  detect: null,
  step: 'detect',
  model: null,
  customModel: '',
  modelDir: '',
  contextWindow: 0,
  installing: false,
  finished: false,
};

const TASKS = [
  ['prepare', '准备安装目录'],
  ['ollama', '准备 Ollama 推理服务'],
  ['model', '下载模型'],
  ['dsh', '安装 DeepSeek Harness'],
  ['config', '写入配置'],
  ['shortcuts', '创建桌面快捷方式'],
];

/* ------------------------------------------------------------------ 导航 */

function go(step) {
  state.step = step;
  for (const v of document.querySelectorAll('.view')) v.hidden = true;
  $(`view-${step}`).hidden = false;

  const order = ['detect', 'model', 'location', 'install', 'done'];
  const cur = order.indexOf(step);
  for (const li of document.querySelectorAll('#steps li')) {
    const i = order.indexOf(li.dataset.step);
    li.classList.toggle('active', i === cur);
    li.classList.toggle('done', i < cur);
  }

  $('btnBack').hidden = !['model', 'location'].includes(step);
  updateNext();
  window.scrollTo(0, 0);
}

function updateNext() {
  const b = $('btnNext');
  b.disabled = true;
  if (state.step === 'detect') {
    b.textContent = '继续';
    b.disabled = !state.detect || state.detect.issues.some((i) => i.level === 'error');
  } else if (state.step === 'model') {
    b.textContent = '继续';
    b.disabled = !state.model;
  } else if (state.step === 'location') {
    b.textContent = '开始安装';
    b.disabled = !state.modelDir;
  } else if (state.step === 'install') {
    b.textContent = '完成';
    b.disabled = !state.finished;
  } else {
    b.textContent = '完成';
    b.disabled = false;
  }
}

function footerMsg(s) { $('footerMsg').textContent = s || ''; }

/* -------------------------------------------------------------- 环境检测 */

async function loadDetect() {
  try {
    // 服务端会把结果直接注入（首屏无需等待），注入缺失时才回退到请求
    const d = window.__DETECT__ || await (await fetch('/api/detect')).json();
    state.detect = d;
    renderDetect(state.detect);
    renderModels(state.detect);
    renderDisks(state.detect);
    state.model = state.detect.suggested.model;
    state.modelDir = state.detect.suggested.modelDir;
    state.contextWindow = state.detect.suggested.contextWindow;
    selectModelCard(state.model);
    selectDisk(state.modelDir);
    renderEnvBadge(state.detect);
    updateNext();
  } catch (e) {
    $('detectBody').innerHTML = `<div class="issue error">检测失败：${e.message}</div>`;
  }
}

function renderDetect(d) {
  const cards = [];

  cards.push({
    k: 'Node.js',
    v: d.node.ok ? `v${d.node.version}` : `v${d.node.version}（版本偏低）`,
    s: d.node.ok ? '运行环境就绪' : '建议升级到 20 以上',
    cls: d.node.ok ? 'ok' : 'err',
  });

  cards.push(d.gpu.found
    ? {
      k: '显卡',
      v: d.gpu.name,
      s: `${d.gpu.vramGB} GB 显存` + (d.gpu.driver ? ` · 驱动 ${d.gpu.driver}` : ''),
      cls: d.gpu.vendor === 'nvidia' ? 'ok' : 'warn',
    }
    : { k: '显卡', v: d.gpu.name || '未检测到独立显卡', s: '只能用很小的模型，速度会很慢', cls: 'warn' });

  cards.push(d.ollama.installed
    ? { k: 'Ollama', v: d.ollama.running ? '已安装并运行中' : '已安装', s: d.ollama.version ? `版本 ${d.ollama.version}` : '', cls: 'ok' }
    : { k: 'Ollama', v: '未安装', s: '安装时会引导你装好', cls: 'warn' });

  cards.push(d.install.dshInstalled
    ? { k: 'DeepSeek Harness', v: '已安装', s: '会检查并更新配置', cls: 'ok' }
    : { k: 'DeepSeek Harness', v: '待安装', s: '安装过程约 1–3 分钟', cls: '' });

  cards.push({
    k: '权限',
    v: d.elevated ? '管理员' : '普通用户',
    s: d.elevated ? '可以安装到任意位置' : '安装到用户目录不需要管理员',
    cls: d.elevated ? 'ok' : '',
  });

  const big = d.disks.filter((x) => x.freeGB >= 30).length;
  cards.push({ k: '磁盘', v: `${d.disks.length} 个分区`, s: `${big} 个分区可用空间 ≥30GB`, cls: '' });

  $('detectBody').innerHTML =
    `<div class="env-grid">${cards.map((c) => `
      <div class="env-card ${c.cls}">
        <div class="k">${c.k}</div>
        <div class="v">${esc(c.v)}</div>
        <div class="s">${esc(c.s || '')}</div>
      </div>`).join('')}</div>` +
    (d.issues.length ? `<div class="issues">${d.issues.map((i) => `
      <div class="issue ${i.level}">${esc(i.text)}</div>`).join('')}</div>` : '');

  const errs = d.issues.filter((i) => i.level === 'error').length;
  footerMsg(errs ? '有必须解决的问题，请先处理' : '检测完成，点击「继续」');
}

function renderEnvBadge(d) {
  $('envBadge').innerHTML = d.gpu.found
    ? `<b>${esc(d.gpu.name.replace(/^(NVIDIA GeForce|AMD Radeon) /, ''))}</b><br>${d.gpu.vramGB} GB 显存`
    : '<b>未检测到独显</b>';
}

/* -------------------------------------------------------------- 选模型 */

function renderModels(d) {
  const gpuText = d.gpu.found
    ? `检测到 <b>${esc(d.gpu.name)}</b>（${d.gpu.vramGB} GB 显存），下面只列出跑得动的模型。`
    : '未检测到可用的独立显卡，只列出最小的几个模型。';
  $('modelLead').innerHTML = gpuText;

  $('modelCards').innerHTML = d.models.map((m) => `
    <button class="card" type="button" data-tag="${esc(m.tag)}">
      ${m.recommended ? '<span class="badge">推荐</span>' : (m.installed ? '<span class="badge installed">已安装</span>' : '')}
      <div class="name">${esc(m.name)}</div>
      <div class="note">${esc(m.note)}</div>
      <div class="meta">
        <span>下载 <b>${m.gb} GB</b></span>
        <span>需显存 <b>${m.needGB} GB</b></span>
      </div>
    </button>`).join('');

  for (const c of document.querySelectorAll('#modelCards .card')) {
    c.addEventListener('click', () => {
      document.querySelector('input[name=modelPick][value="__custom__"]').checked = false;
      $('customModel').disabled = true;
      state.model = c.dataset.tag;
      selectModelCard(state.model);
      updateContext();
    });
  }

  const customRadio = document.querySelector('input[name=modelPick][value="__custom__"]');
  customRadio.addEventListener('change', () => {
    $('customModel').disabled = !customRadio.checked;
    if (customRadio.checked) {
      $('customModel').focus();
      state.model = state.customModel || '';
    } else {
      state.model = d.suggested.model;
    }
    selectModelCard(state.model);
    updateNext();
  });
  $('customModel').addEventListener('input', (e) => {
    state.customModel = e.target.value.trim();
    state.model = state.customModel;
    updateContext();
  });
}

function selectModelCard(tag) {
  for (const c of document.querySelectorAll('#modelCards .card')) {
    c.classList.toggle('selected', c.dataset.tag === tag);
  }
  updateContext();
}

function updateContext() {
  const d = state.detect;
  const info = d && d.models.find((m) => m.tag === state.model);
  const vram = d ? d.gpu.vramGB : 0;
  if (info) {
    const spare = vram - info.gb;
    state.contextWindow = spare >= 7 ? 32768 : spare >= 3.5 ? 16384 : spare >= 1.5 ? 8192 : 4096;
  } else {
    // 手动输入的模型不知道体积，保守取 8K，装好后可在 配置.json 里调大
    state.contextWindow = 8192;
  }
  footerMsg(state.model ? `已选择：${state.model}　上下文 ${state.contextWindow}` : '请选择或输入一个模型');
  updateNext();
}

/* ------------------------------------------------------------ 存放位置 */

function renderDisks(d) {
  const usable = d.disks.filter((x) => x.freeGB >= 20).sort((a, b) => b.freeGB - a.freeGB);
  $('diskList').innerHTML = usable.map((x) => {
    const usedPct = Math.round(((x.totalGB - x.freeGB) / x.totalGB) * 100);
    return `
      <div class="disk" data-root="${esc(x.root)}">
        <div class="letter">${x.letter}</div>
        <div class="info">
          <div class="t">${x.letter}: 盘</div>
          <div class="s">空闲 ${x.freeGB} GB / 共 ${x.totalGB} GB</div>
        </div>
        <div class="meter"><i style="width:${usedPct}%"></i></div>
      </div>`;
  }).join('');

  for (const el of document.querySelectorAll('#diskList .disk')) {
    el.addEventListener('click', () => {
      state.modelDir = el.dataset.root + 'ollama\\models';
      $('customDir').value = '';
      selectDisk(state.modelDir);
    });
  }
}

/** 自定义模型目录：必须是 X:\ 开头的完整路径 */
function isValidDir(s) {
  return /^[A-Za-z]:\\/.test(s) && !/[<>"|?*]/.test(s.slice(2));
}

$('customDir').addEventListener('input', (e) => {
  const v = e.target.value.trim().replace(/\//g, '\\');
  $('customDirErr').hidden = !v || isValidDir(v);
  if (v && isValidDir(v)) {
    state.modelDir = v;
    selectDisk(v);
  } else if (!v) {
    state.modelDir = state.detect ? state.detect.suggested.modelDir : '';
    selectDisk(state.modelDir);
  } else {
    state.modelDir = '';
    selectDisk('');
  }
});

function selectDisk(dir) {
  const custom = $('customDir').value.trim() !== '';
  for (const el of document.querySelectorAll('#diskList .disk')) {
    el.classList.toggle('selected', !custom && !!dir && dir.startsWith(el.dataset.root));
  }
  $('dirPreview').textContent = dir || '（请选择一个磁盘，或输入完整路径）';
  const info = state.detect && state.detect.models.find((m) => m.tag === state.model);
  $('needSpace').textContent = info ? Math.ceil(info.gb * 1.3) : 20;
  updateNext();
}

/* ---------------------------------------------------------------- 安装 */

/* ---------------------------------------------------------------- 安装 */

/** 哪些步骤耗时较长但拿不到确切百分比 —— 用滚动条 + 计时告诉用户「还在动」 */
const OPAQUE_STEPS = new Set(['ollama', 'dsh']);

const STEP_TITLES = {
  prepare: '准备安装目录',
  ollama: '准备 Ollama 推理服务',
  model: '下载模型',
  dsh: '安装 DeepSeek Harness',
  config: '写入配置',
  shortcuts: '创建桌面快捷方式',
};

const PHASE_TITLES = {
  model: '下载模型',
  'ollama-setup': '下载 Ollama 安装包',
};

/** 每一步的运行时状态：status / 明细文字 / 起止时间 / 内部百分比 */
const taskState = {};

/** 当前是否处于「不确定进度」状态（启动服务、装依赖这种） */
let pending = null;

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

/** 这一步已经跑了多久 */
function elapsedText(t) {
  if (!t || !t.startedAt) return '';
  const sec = Math.max(0, Math.round(((t.endedAt || Date.now()) - t.startedAt) / 1000));
  if (sec < 1) return '';
  return sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分 ${String(sec % 60).padStart(2, '0')} 秒`;
}

function renderTasks() {
  $('taskList').innerHTML = TASKS.map(([id, label]) => `
    <li data-task="${id}"><span class="ico"></span><span class="name">${label}</span><span class="tm"></span><span class="st"></span></li>`).join('');
  for (const [id] of TASKS) paintTask(id);
}

function paintTask(id) {
  const li = document.querySelector(`#taskList li[data-task="${id}"]`);
  if (!li) return;
  const t = taskState[id] || {};
  li.className = t.status || '';
  li.querySelector('.st').textContent = t.text || '';
  li.querySelector('.tm').textContent = elapsedText(t);
}

function setTask(id, status, text) {
  const t = taskState[id] || (taskState[id] = {});
  if (status === 'running') {
    if (t.status !== 'running') { t.startedAt = Date.now(); t.endedAt = 0; }
  } else if (t.startedAt && !t.endedAt) {
    t.endedAt = Date.now();
  }
  t.status = status;
  t.text = text || '';
  paintTask(id);
  updateOverall();
}

/** 当前步骤内部走到哪儿了（0~1）。拿不到百分比时按用时缓慢推进 */
function stepFraction(t) {
  if (typeof t.percent === 'number') return t.percent / 100;
  if (!t.startedAt) return 0.1;
  return Math.min(0.9, 0.1 + (Date.now() - t.startedAt) / 1000 / 150);
}

/** 整体进度：已完成步骤数 + 当前步骤的内部进度 */
function updateOverall() {
  const total = TASKS.length;
  let done = 0;
  let frac = 0;
  for (const [id] of TASKS) {
    const t = taskState[id] || {};
    if (t.status === 'done' || t.status === 'skipped') { done++; continue; }
    if (t.status === 'running') frac = stepFraction(t);
    break;
  }
  const pct = Math.min(100, Math.round(((done + frac) / total) * 100));

  $('overallWrap').hidden = false;
  $('overallBar').style.width = `${pct}%`;
  $('overallPct').textContent = `${pct}%`;
  const cur = TASKS[Math.min(done, total - 1)][1];
  $('overallLabel').textContent = done >= total ? '安装完成' : `第 ${done + 1} / ${total} 步 · ${cur}`;
}

/**
 * 渲染当前步骤的详细进度。
 * ev: { phase, title, percent, got, total, speed, eta, parts, text, indeterminate }
 */
function renderProgress(ev) {
  const track = $('progressTrack');
  $('progressWrap').hidden = false;
  $('progressTitle').textContent = ev.title || PHASE_TITLES[ev.phase] || '安装进度';

  if (ev.indeterminate) {
    track.classList.add('indeterminate');
    $('progressPct').textContent = '';
    $('progressStats').innerHTML = `<div class="stat"><span class="v">${esc(ev.text || '正在处理…')}</span></div>`;
    return;
  }

  pending = null;
  track.classList.remove('indeterminate');

  const pct = Math.max(0, Math.min(100, Math.round(ev.percent || 0)));
  $('progressPct').textContent = `${pct}%`;
  $('progressBar').style.width = `${pct}%`;

  const stats = [];
  if (ev.total > 0) stats.push(['已下载', `${fmtBytes(ev.got)} / ${fmtBytes(ev.total)}`]);
  if (ev.speed > 0) stats.push(['速度', `${fmtBytes(ev.speed)}/s`]);
  if (ev.eta > 0) stats.push(['剩余', fmtEta(ev.eta)]);
  if (ev.parts) stats.push(['分片', `${ev.parts.done} / ${ev.parts.total}`]);
  if (!stats.length && ev.text) stats.push(['', ev.text]);

  $('progressStats').innerHTML = stats
    .map(([k, v]) => `<div class="stat">${k ? `<span class="k">${k}</span>` : ''}<span class="v">${esc(v)}</span></div>`)
    .join('');
}

/** 耗时较长、又没有百分比的步骤：滚动条 + 已用时 */
function showPending(title, note) {
  pending = { title, note, startedAt: Date.now() };
  renderProgress({ title, indeterminate: true, text: `${note} 已用时 0 秒` });
}

function appendLog(text) {
  const pre = $('log');
  pre.textContent += text + '\n';
  pre.scrollTop = pre.scrollHeight;
}

async function startInstall() {
  for (const k of Object.keys(taskState)) delete taskState[k];
  pending = null;
  renderTasks();
  updateOverall();
  go('install');
  state.finished = false;
  updateNext();

  // 安装目录和 Ollama 路径由服务端自己检测，这里只传用户的选择
  try {
    await post('/api/install', {
      model: state.model,
      modelDir: state.modelDir,
      contextWindow: state.contextWindow,
    });
  } catch (e) {
    onEvent({ type: 'error', text: e.message });
  }
}

function onEvent(ev) {
  // 服务端会回放事件历史：如果安装已经在进行（或刚完成），刷新后自动回到进度页
  if ((ev.type === 'begin' || ev.type === 'step') && !state.autoJumped) {
    if (['detect', 'model', 'location'].includes(state.step)) {
      state.autoJumped = true;
      renderTasks();
      $('progressWrap').hidden = true;
      go('install');
    }
  }

  if (ev.type === 'step') {
    setTask(ev.id, ev.status, ev.text);
    if (ev.status === 'running') {
      footerMsg(ev.text);
      if (ev.id === 'model') {
        // 模型下载：先显示「正在获取模型信息」，拿到数据后换成真实进度
        renderProgress({ phase: 'model', indeterminate: true, text: '正在连接模型仓库，获取模型信息…' });
      } else if (OPAQUE_STEPS.has(ev.id)) {
        showPending(STEP_TITLES[ev.id], ev.id === 'dsh' ? '正在安装依赖（约 1–3 分钟）' : '正在启动服务');
      } else {
        // 其它步骤很快，没必要占一块面板
        $('progressWrap').hidden = true;
      }
    } else if (ev.status === 'error') {
      // 出错时保留面板，让用户看得到停在哪
    } else if (ev.id === 'model' || OPAQUE_STEPS.has(ev.id)) {
      pending = null;
      $('progressWrap').hidden = true;
    }
  } else if (ev.type === 'log') {
    appendLog(ev.text);
  } else if (ev.type === 'progress') {
    const t = taskState[ev.phase];
    if (t && typeof ev.percent === 'number' && !ev.indeterminate) t.percent = ev.percent;
    renderProgress(ev);
    updateOverall();
  } else if (ev.type === 'needs-elevation') {
    showModal(ev.reason, ev.hint, ev.action);
  } else if (ev.type === 'error') {
    appendLog('错误：' + ev.text);
    footerMsg(ev.text);
    $('installTitle').textContent = '安装未完成';
    $('installLead').textContent = '可以修正问题后重新运行安装向导。';
    pending = null; // 停掉计时，面板停在出错那一刻
    state.finished = true;
    updateNext();
  } else if (ev.type === 'done') {
    state.finished = true;
    pending = null;
    $('installTitle').textContent = '安装完成';
    $('installLead').textContent = '全部步骤已完成。';
    $('progressWrap').hidden = true;
    $('overallWrap').hidden = false;
    $('overallBar').style.width = '100%';
    $('overallPct').textContent = '100%';
    $('overallLabel').textContent = '安装完成';
    renderSummary(ev.summary);
    footerMsg('安装完成，点击「完成」');
    updateNext();
    setTimeout(() => go('done'), 700);
  } else if (ev.type === 'detect-refresh') {
    state.detect = ev.data;
    pending = null;
    $('progressWrap').hidden = true;
    renderDetect(ev.data);
    renderModels(ev.data);
    renderDisks(ev.data);
    renderEnvBadge(ev.data);
    hideModal();
    footerMsg('已重新检测，点击「继续」');
    go('detect');
  }
}

function renderSummary(s) {
  $('summary').innerHTML = `
    <div class="row"><span class="k">安装目录</span><span class="v">${esc(s.root)}</span></div>
    <div class="row"><span class="k">模型</span><span class="v">${esc(s.model)}</span></div>
    <div class="row"><span class="k">模型存放</span><span class="v">${esc(s.modelDir)}</span></div>
    <div class="row"><span class="k">上下文长度</span><span class="v">${s.contextWindow}</span></div>`;
}

function connectSSE() {
  const es = new EventSource('/api/events');
  es.onmessage = (m) => {
    try { onEvent(JSON.parse(m.data)); } catch { /* ignore */ }
  };
  es.onerror = () => { /* 自动重连 */ };
}

/* ---------------------------------------------------------------- 弹窗 */

function showModal(reason, hint, action) {
  $('modalReason').textContent = reason || '';
  $('modalHint').textContent = hint || '';
  $('modalOk').dataset.action = action || '';
  $('modalMask').hidden = false;
}
function hideModal() { $('modalMask').hidden = true; }

$('modalCancel').addEventListener('click', hideModal);
$('modalOk').addEventListener('click', async () => {
  const action = $('modalOk').dataset.action;
  hideModal();
  if (action === 'install-ollama') {
    footerMsg('正在安装 Ollama...');
    try { await post('/api/install-ollama'); } catch (e) { footerMsg(e.message); }
  } else {
    footerMsg('请关闭安装向导，右键「① 双击这里开始安装.cmd」选择「以管理员身份运行」。');
  }
});

/* ---------------------------------------------------------------- 按钮 */

$('btnBack').addEventListener('click', () => {
  go(state.step === 'location' ? 'model' : 'detect');
});

$('btnNext').addEventListener('click', async () => {
  if (state.step === 'detect') go('model');
  else if (state.step === 'model') { if (state.model) go('location'); }
  else if (state.step === 'location') startInstall();
  else if (state.step === 'done' || state.step === 'install') {
    if (state.finished) {
      try { await post('/api/quit'); } catch { /* 服务可能已退出 */ }
      document.body.innerHTML =
        '<div style="display:grid;place-items:center;height:100vh;font:15px system-ui;color:#6b7280">' +
        '安装向导已关闭，可以关闭这个页面了。</div>';
    }
  }
});

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------------------------------------------------------- 启动 */

// 每秒刷新「已用时」和整体进度：长步骤（下模型、装依赖）看起来才是「活的」
setInterval(() => {
  if (state.step !== 'install') return;
  for (const [id] of TASKS) {
    const t = taskState[id];
    if (t && t.status === 'running') paintTask(id);
  }
  if (pending) {
    const sec = Math.max(0, Math.round((Date.now() - pending.startedAt) / 1000));
    renderProgress({ title: pending.title, indeterminate: true, text: `${pending.note} · 已用时 ${sec} 秒` });
  }
  updateOverall();
}, 1000);

connectSSE();
renderTasks();
loadDetect();
