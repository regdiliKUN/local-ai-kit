/* 本地 AI 安装向导 —— 前端逻辑
 *
 * 设计原则：非技术用户点进来之后，任何时刻都应该能一眼看出「现在该我做什么」。
 * 所以每一步都有显式的操作指引条，出错时必须给出「停在哪 + 为什么 + 怎么办」，
 * 并且提供一键重试 / 复制诊断信息，而不是甩一句报错就完事。
 */

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
  proxy: '',
  spaceOk: true,
  installing: false,
  finished: false,
  failed: false,
  lastParams: null,
  errorInfo: null,
  autoJumped: false,
};

const TASKS = [
  ['prepare', '准备安装目录'],
  ['ollama', '准备 Ollama 推理服务'],
  ['model', '下载模型'],
  ['verify', '校验模型'],
  ['dsh', '安装 DeepSeek Harness'],
  ['config', '写入配置'],
  ['shortcuts', '创建桌面快捷方式'],
];

const STEP_TITLES = Object.fromEntries(TASKS);

/** 假设的家庭宽带下行速度，只用来给个粗略的下载时间预期 */
const ASSUMED_MBPS = 25;

/* ------------------------------------------------------------------ 小工具 */

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

/** 按固定假设速度估算下载耗时，给用户一个「要等多久」的心理预期 */
function estimateDownload(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return `不到 1 分钟`;
  if (s < 3600) return `约 ${Math.round(s / 60)} 分钟`;
  return `约 ${(s / 3600).toFixed(1)} 小时`;
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

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
    b.disabled = !state.modelDir || !state.spaceOk;
  } else if (state.step === 'install') {
    if (state.failed) { b.textContent = '关闭向导'; b.disabled = false; }
    else if (state.finished) { b.textContent = '完成'; b.disabled = false; }
    else { b.textContent = '安装中…'; b.disabled = true; }
  } else {
    b.textContent = '完成';
    b.disabled = false;
  }
}

function footerMsg(s) { $('footerMsg').textContent = s || ''; }

/* -------------------------------------------------------------- 环境检测 */

async function loadDetect(force = false) {
  $('detectBody').innerHTML = '<div class="loading"><span class="spinner"></span> 检测中...</div>';
  try {
    const d = (!force && window.__DETECT__) || await (await fetch(`/api/detect${force ? '?force=1' : ''}`)).json();
    window.__DETECT__ = d;
    state.detect = d;
    renderDetect(state.detect);
    renderModels(state.detect);
    renderContextSeg(state.detect);
    renderDisks(state.detect);
    state.model = state.detect.suggested.model;
    state.modelDir = state.detect.suggested.modelDir;
    state.contextWindow = state.detect.suggested.contextWindow;
    selectModelCard(state.model);
    selectDisk(state.modelDir);
    renderEnvBadge(state.detect);
    updateNext();
  } catch (e) {
    $('detectBody').innerHTML = `<div class="issue error">检测失败：${esc(e.message)}。请关掉向导重新运行一次。</div>`;
  }
}

function renderDetect(d) {
  const cards = [];

  cards.push({
    k: 'Node.js',
    v: d.node.ok ? `v${d.node.version}` : `v${d.node.version}（版本偏低）`,
    s: d.node.ok ? '运行环境就绪' : '需要 20 以上',
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
    : { k: 'Ollama', v: '未安装', s: '安装时会自动帮你装好', cls: 'warn' });

  cards.push(d.install.dshInstalled
    ? { k: 'DeepSeek Harness', v: '已安装', s: '会检查并更新配置', cls: 'ok' }
    : { k: 'DeepSeek Harness', v: '待安装', s: '安装过程约 1–3 分钟', cls: '' });

  cards.push({
    k: '权限',
    v: d.elevated ? '管理员' : '普通用户',
    s: d.elevated ? '可以安装到任意位置' : '装到用户目录不需要管理员',
    cls: d.elevated ? 'ok' : '',
  });

  const big = d.disks.filter((x) => x.freeGB >= 30).length;
  cards.push({ k: '磁盘', v: `${d.disks.length} 个分区`, s: `${big} 个分区可用空间 ≥30GB`, cls: '' });

  $('detectBody').innerHTML =
    `<div class="env-grid">${cards.map((c) => `
      <div class="env-card ${c.cls}">
        <div class="k">${esc(c.k)}</div>
        <div class="v">${esc(c.v)}</div>
        <div class="s">${esc(c.s || '')}</div>
      </div>`).join('')}</div>` +
    (d.issues.length ? `<div class="issues">${d.issues.map((i) => `
      <div class="issue ${i.level}">
        <div class="issue-main">${esc(i.text)}</div>
        ${i.hint ? `<div class="issue-hint">→ ${esc(i.hint)}</div>` : ''}
      </div>`).join('')}</div>` : '');

  const errs = d.issues.filter((i) => i.level === 'error').length;
  footerMsg(errs ? '有必须先解决的问题，请看上面的红框' : '检测完成 —— 点右下角「继续」');
}

function renderEnvBadge(d) {
  $('envBadge').innerHTML = d.gpu.found
    ? `<b>${esc(d.gpu.name.replace(/^(NVIDIA GeForce|AMD Radeon) /, ''))}</b><br>${d.gpu.vramGB} GB 显存`
    : '<b>未检测到独显</b>';
}

/* -------------------------------------------------------------- 选模型 */

function renderModels(d) {
  $('modelLead').innerHTML = d.gpu.found
    ? `检测到 <b>${esc(d.gpu.name)}</b>（${d.gpu.vramGB} GB 显存），下面只列出你的显卡跑得动的模型。`
    : '未检测到可用的独立显卡，只列出最小的几个模型。';

  // 本机已经下过模型的话，直接告诉用户可以复用，省掉一次十几 GB 的下载
  const dirs = d.existingDirs || [];
  if (dirs.length) {
    $('localModels').hidden = false;
    $('localModels').innerHTML =
      `<b>本机已经找到 ${dirs.reduce((n, x) => n + x.models.length, 0)} 个已下载的模型</b>，可以直接复用，不用重新下载：`
      + dirs.map((x) => `<div class="lm"><code>${esc(x.dir)}</code><span>${esc(x.models.join('、'))}</span></div>`).join('');
  } else {
    $('localModels').hidden = true;
  }

  $('modelCards').innerHTML = d.models.map((m) => {
    const mins = estimateDownload((m.gb * 1000) / ASSUMED_MBPS);
    const badge = m.localDir
      ? '<span class="badge local">本机已有</span>'
      : (m.recommended ? '<span class="badge">推荐</span>'
        : (m.installed ? '<span class="badge installed">已安装</span>' : ''));
    const sub = m.localDir
      ? `已在 <code>${esc(m.localDir)}</code> 找到，<b>不用重新下载</b>`
      : (m.installed ? 'Ollama 里已有，不用重下' : `按 25MB/s 估算，约 ${mins}下完`);
    return `
    <button class="card" type="button" data-tag="${esc(m.tag)}">
      ${badge}
      <div class="name">${esc(m.name)}</div>
      <div class="note">${esc(m.note)}</div>
      <div class="meta">
        <span>下载 <b>${m.gb} GB</b></span>
        <span>需显存 <b>${m.needGB} GB</b></span>
      </div>
      <div class="meta sub">${sub}</div>
    </button>`;
  }).join('');

  for (const c of document.querySelectorAll('#modelCards .card')) {
    c.addEventListener('click', () => {
      document.querySelector('input[name=modelPick][value="__custom__"]').checked = false;
      $('customModel').disabled = true;
      $('customModelErr').hidden = true;
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
      $('customModelErr').hidden = true;
    }
    selectModelCard(state.model);
    updateNext();
  });

  $('customModel').addEventListener('input', (e) => {
    state.customModel = e.target.value.trim();
    state.model = state.customModel;
    $('customModelErr').hidden = !state.customModel || isValidModelName(state.customModel);
    updateContext();
  });
}

/** 和服务端 ollama.mjs 的 isValidModelName 保持一致 */
function isValidModelName(s) {
  return typeof s === 'string' && s.length <= 120 && /^[a-z0-9][a-z0-9._\-/]*(:[a-z0-9._\-]+)?$/i.test(s);
}

function selectModelCard(tag) {
  for (const c of document.querySelectorAll('#modelCards .card')) {
    c.classList.toggle('selected', c.dataset.tag === tag);
  }
  updateContext();
}

/** 上下文长度的档位按钮（4K / 8K / 16K / 32K / 64K） */
function renderContextSeg(d) {
  const opts = d.contextOptions || [];
  $('ctxSeg').innerHTML = opts
    .map((o) => `<button type="button" class="seg-btn" data-cw="${o.value}">${esc(o.label)}</button>`)
    .join('');
  for (const b of document.querySelectorAll('#ctxSeg .seg-btn')) {
    b.addEventListener('click', () => {
      state.contextWindow = Number(b.dataset.cw);
      paintContext();
    });
  }
}

function updateContext() {
  const d = state.detect;
  const info = d && d.models.find((m) => m.tag === state.model);
  // 上下文长度由服务端算好（和命令行安装共用同一套公式），前端直接用
  state.contextWindow = info ? (info.contextWindow || 8192) : 8192;
  paintContext();
  footerMsg(state.model ? `已选择：${state.model}` : '请选择或输入一个模型');
  updateNext();
}

/** 刷新上下文选择器的选中态与显存估算 */
function paintContext() {
  const d = state.detect;
  const info = d && d.models.find((m) => m.tag === state.model);
  for (const b of document.querySelectorAll('#ctxSeg .seg-btn')) {
    b.classList.toggle('on', Number(b.dataset.cw) === state.contextWindow);
  }
  const vram = d ? d.gpu.vramGB : 0;
  const est = info && info.vramEstimate ? info.vramEstimate[state.contextWindow] : null;
  const label = `${Math.round(state.contextWindow / 1024)}K`;
  if (est == null) {
    $('ctxInfo').innerHTML = `上下文 <b>${label}</b>`
      + (info ? '' : '（手动输入的模型不知道体积，先保守取 8K）');
    return;
  }
  const ratio = vram ? est / vram : 0;
  const flag = !vram ? ''
    : ratio > 1 ? '<span class="ctx-flag over">可能超出显存</span>'
      : ratio > 0.85 ? '<span class="ctx-flag tight">偏紧</span>'
        : '<span class="ctx-flag ok">够用</span>';
  $('ctxInfo').innerHTML = `上下文 <b>${label}</b> · 预计占用 <b>${est} GB</b> / 显存 ${vram} GB ${flag}`;
}

/* ------------------------------------------------------------ 存放位置 */

function renderDisks(d) {
  const usable = d.disks.filter((x) => x.freeGB >= 20).sort((a, b) => b.freeGB - a.freeGB);
  $('noDisk').hidden = usable.length > 0;

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
      $('customDirErr').hidden = true;
      selectDisk(state.modelDir);
    });
  }
}

/** 自定义模型目录：必须是 X:\ 开头的完整路径 */
function isValidDir(s) {
  return /^[A-Za-z]:\\/.test(s) && !/[<>"|?*]/.test(s.slice(2));
}

function setupCustomDir() {
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

  // 代理是可选项：留空就正常直连
  $('proxy').addEventListener('input', (e) => {
    const v = e.target.value.trim();
    state.proxy = v;
    $('proxyErr').hidden = !v || /^https?:\/\/\S+$/i.test(v);
  });
}

function selectDisk(dir) {
  const custom = $('customDir').value.trim() !== '';
  for (const el of document.querySelectorAll('#diskList .disk')) {
    el.classList.toggle('selected', !custom && !!dir && dir.startsWith(el.dataset.root));
  }
  $('dirPreview').textContent = dir || '（请先点一个磁盘，或在上面输入完整路径）';

  const d = state.detect;
  const info = d && d.models.find((m) => m.tag === state.model);
  const need = info ? Math.ceil(info.gb * 1.3) : 20;
  $('needSpace').textContent = need;

  // 磁盘空间预检：模型下载 + 解压大约要 1.3 倍体积
  let free = null;
  if (dir && /^[A-Za-z]:\\/.test(dir) && d) {
    const dk = d.disks.find((x) => x.letter === dir[0].toUpperCase());
    if (dk) free = dk.freeGB;
  }
  state.spaceOk = !(dir && free != null && free < need);

  const box = $('spaceWarn');
  if (!state.spaceOk) {
    box.hidden = false;
    box.innerHTML = `<b>这块盘空间不够。</b>${esc(dir.slice(0, 2))} 只剩 <b>${free} GB</b>，`
      + `这个模型下载 + 解压大约需要 <b>${need} GB</b>。`
      + '请换一块空间更大的盘，或者回上一步选个小一点的模型。';
  } else {
    box.hidden = true;
  }
  $('spaceInfo').innerHTML = (dir && free != null)
    ? `目标磁盘剩余 <b>${free} GB</b>，预计需要 <b>${need} GB</b>。`
    : '';
  updateNext();
}

/* ---------------------------------------------------------------- 安装 */

/** 哪些步骤耗时较长但拿不到确切百分比 —— 用滚动条 + 计时告诉用户「还在动」 */
const OPAQUE_STEPS = new Set(['ollama', 'verify', 'dsh']);

/** 长步骤的副标题：让用户知道现在在等什么 */
const PENDING_NOTES = {
  ollama: '正在启动服务',
  verify: '正在把模型加载进显存（首次约 1 分钟）',
  dsh: '正在安装依赖（约 1–3 分钟）',
};

const PHASE_TITLES = {
  model: '下载模型',
  'ollama-setup': '下载 Ollama 安装包',
};

/** 每一步的运行时状态：status / 明细文字 / 起止时间 / 内部百分比 */
const taskState = {};

/** 当前是否处于「不确定进度」状态（启动服务、装依赖这种） */
let pending = null;

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

/** 开始（或重试 / 续装）之前，把安装界面恢复成干净状态 */
function resetInstallUI() {
  for (const k of Object.keys(taskState)) delete taskState[k];
  pending = null;
  state.finished = false;
  state.failed = false;
  state.errorInfo = null;
  $('errorPanel').hidden = true;
  $('log').textContent = '';
  $('installTitle').textContent = '正在安装，请勿关闭';
  $('installLead').textContent = '全部自动完成，你只需要等它跑完。';
  $('keepOpen').hidden = false;
  renderTasks();
  updateOverall();
  updateNext();
}

async function startInstall() {
  state.lastParams = {
    model: state.model,
    modelDir: state.modelDir,
    contextWindow: state.contextWindow,
    proxy: state.proxy || '',
  };
  resetInstallUI();
  go('install');

  // 安装目录和 Ollama 路径由服务端自己检测，这里只传用户的选择
  try {
    await post('/api/install', state.lastParams);
  } catch (e) {
    onEvent({ type: 'error', text: e.message, stage: 'internal', remedy: [] });
  }
}

/* -------------------------------------------------- 失败面板（排障引导） */

const STAGE_NAMES = {
  prepare: '准备安装目录',
  ollama: '准备 Ollama 推理服务',
  model: '下载模型',
  dsh: '安装 DeepSeek Harness',
  config: '写入配置',
  shortcuts: '创建桌面快捷方式',
  internal: '启动安装',
};

function showError(ev) {
  state.failed = true;
  state.finished = true;
  state.errorInfo = ev;

  $('installTitle').textContent = '安装没有完成';
  $('installLead').textContent = '别急，下面写清楚了问题出在哪、以及你可以怎么做。';
  $('keepOpen').hidden = true;
  // 收起进度条：出错时它停在半路，留着会让人以为还在下
  $('progressWrap').hidden = true;
  pending = null;

  $('errStage').innerHTML = `停在了：<b>${esc(STAGE_NAMES[ev.stage] || ev.stage || '安装过程')}</b>`;
  $('errWhy').textContent = ev.text || '安装过程出错。';
  const steps = Array.isArray(ev.remedy) && ev.remedy.length ? ev.remedy : ['点下面的「重试安装」再试一次', '还不行就关掉向导，重新双击「① 双击这里开始安装.cmd」'];
  $('errHow').innerHTML = steps.map((s) => `<li>${esc(s)}</li>`).join('');
  $('errorPanel').hidden = false;

  footerMsg('安装中断了 —— 看上面的「你可以这样做」');
  updateNext();
  window.scrollTo(0, 0);
}

function buildDiagnostics() {
  const d = state.detect || {};
  const lines = [];
  lines.push('===== 本地 AI 安装向导 诊断信息 =====');
  lines.push(`时间：${new Date().toLocaleString()}`);
  lines.push(`浏览器：${navigator.userAgent}`);
  lines.push('');
  lines.push('--- 环境 ---');
  lines.push(`Node.js：${d.node ? 'v' + d.node.version : '未知'}（${d.node && d.node.ok ? '正常' : '偏低'}）`);
  lines.push(`显卡：${d.gpu ? (d.gpu.found ? `${d.gpu.name} / ${d.gpu.vramGB}GB / 驱动 ${d.gpu.driver || '未知'}` : '未检测到独显') : '未知'}`);
  lines.push(`Ollama：${d.ollama ? (d.ollama.installed ? `已安装 ${d.ollama.version || ''}` : '未安装') : '未知'}`);
  lines.push(`权限：${d.elevated ? '管理员' : '普通用户'}`);
  lines.push(`安装目录：${(d.install && d.install.root) || '未知'}（剩余 ${d.install && d.install.freeGB != null ? d.install.freeGB + ' GB' : '未知'}）`);
  lines.push(`模型：${state.lastParams ? state.lastParams.model : '未选择'}`);
  lines.push(`模型目录：${state.lastParams ? state.lastParams.modelDir : '未选择'}`);
  lines.push(`上下文长度：${state.contextWindow}`);
  lines.push(`代理：${state.proxy || '未使用'}`);
  if (d.existingDirs && d.existingDirs.length) {
    lines.push(`本机已有模型目录：${d.existingDirs.map((x) => `${x.dir}（${x.models.length} 个）`).join('，')}`);
  }
  if (d.disks) lines.push(`磁盘：${d.disks.map((x) => `${x.letter}: ${x.freeGB}/${x.totalGB}GB`).join('，')}`);
  lines.push('');
  lines.push('--- 出错信息 ---');
  lines.push(`停在哪一步：${STAGE_NAMES[state.errorInfo && state.errorInfo.stage] || '未知'}`);
  lines.push(`说明：${(state.errorInfo && state.errorInfo.text) || '未知'}`);
  lines.push('');
  lines.push('--- 安装日志（最后 60 行）---');
  const log = $('log').textContent.trim().split('\n');
  lines.push(log.slice(-60).join('\n'));
  lines.push('');
  lines.push('===== 以上内容可直接发给帮你排查的人 =====');
  return lines.join('\n');
}

async function copyDiagnostics() {
  const text = buildDiagnostics();
  try {
    await navigator.clipboard.writeText(text);
    toast('诊断信息已复制到剪贴板，直接粘贴发给别人即可');
  } catch {
    // 剪贴板被拒时退回到「选中 + 复制」
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('诊断信息已复制'); }
    catch { toast('复制失败，请打开日志手动复制'); }
    ta.remove();
  }
}

/* ---------------------------------------------------------------- 事件 */

function onEvent(ev) {
  if (ev.type === 'begin') {
    resetInstallUI();
    if (!state.autoJumped && ['detect', 'model', 'location'].includes(state.step)) {
      state.autoJumped = true;
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
        showPending(STEP_TITLES[ev.id], PENDING_NOTES[ev.id] || '正在处理');
      } else {
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
  } else if (ev.type === 'paused') {
    // 缺前置（比如没装 Ollama）：不是失败，等用户配合完会自动接着装
    state.failed = false;
    state.finished = false;
    $('installTitle').textContent = '需要你完成一步操作';
    $('installLead').textContent = '按弹窗里的提示操作即可；完成后安装会自动继续，不用重来。';
    $('keepOpen').hidden = false;
    footerMsg('等待你完成上一步操作…');
    updateNext();
  } else if (ev.type === 'error') {
    appendLog('错误：' + ev.text);
    showError(ev);
  } else if (ev.type === 'done') {
    state.finished = true;
    state.failed = false;
    pending = null;
    $('installTitle').textContent = '安装完成';
    $('installLead').textContent = '全部步骤都跑完了。';
    $('progressWrap').hidden = true;
    $('overallWrap').hidden = false;
    $('overallBar').style.width = '100%';
    $('overallPct').textContent = '100%';
    $('overallLabel').textContent = '安装完成';
    renderSummary(ev.summary);
    footerMsg('安装完成 —— 点「完成」关闭向导');
    updateNext();
    setTimeout(() => go('done'), 700);
  } else if (ev.type === 'detect-refresh') {
    state.detect = ev.data;
    pending = null;
    $('progressWrap').hidden = true;
    renderDetect(ev.data);
    renderModels(ev.data);
    renderContextSeg(ev.data);
    renderDisks(ev.data);
    renderEnvBadge(ev.data);
    hideModal();
    footerMsg('已重新检测 —— 点右下角「继续」');
    go('detect');
  }
}

function renderSummary(s) {
  $('summary').innerHTML = `
    <div class="row"><span class="k">安装目录</span><span class="v">${esc(s.root)}</span></div>
    <div class="row"><span class="k">模型</span><span class="v">${esc(s.model)}</span></div>
    <div class="row"><span class="k">模型存放</span><span class="v">${esc(s.modelDir)}</span></div>
    <div class="row"><span class="k">上下文长度</span><span class="v">${s.contextWindow}</span></div>`;
  $('launchHint').textContent = s.shortcutsOk
    ? '也可以直接点左边那个按钮启动，效果和双击桌面图标一样。'
    : '桌面图标没建成功 —— 到安装目录里双击「重建桌面图标.cmd」可以补上。';
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
  const isOllama = action === 'install-ollama';
  $('modalTitle').textContent = isOllama ? '需要先装一个组件' : '需要管理员权限';
  $('modalReason').textContent = reason || '';
  $('modalHint').textContent = hint || '';
  $('modalOk').dataset.action = action || '';
  $('modalOk').textContent = isOllama ? '自动安装 Ollama' : '自动以管理员身份继续';
  $('modalCancel').textContent = isOllama ? '我自己装' : '稍后再说';
  $('modalMask').hidden = false;
}
function hideModal() { $('modalMask').hidden = true; }

function setupModal() {
  $('modalCancel').addEventListener('click', hideModal);
  $('modalOk').addEventListener('click', async () => {
    const action = $('modalOk').dataset.action;
    hideModal();
    if (action === 'install-ollama') {
      footerMsg('正在下载并安装 Ollama…');
      try { await post('/api/install-ollama'); } catch (e) { footerMsg(e.message); }
      return;
    }
    // 需要管理员：直接以管理员身份重启向导，用户不用自己去右键
    footerMsg('正在申请管理员权限…（请在 Windows 弹窗里点「是」）');
    try {
      const r = await post('/api/relaunch-elevated');
      if (!r.ok) throw new Error(r.error || '未能获得管理员权限');
      document.body.innerHTML =
        '<div class="bye"><h2>已用管理员身份重新打开</h2>' +
        '<p>请看新弹出的窗口和浏览器标签页，继续完成安装。</p>' +
        '<p class="dim">这个旧页面可以关掉了。</p></div>';
    } catch (e) {
      toast('自动提权失败：' + e.message);
      footerMsg('自动提权失败 —— 请到部署包文件夹里右键「① 双击这里开始安装.cmd」，选「以管理员身份运行」');
      try { await post('/api/open-folder', { which: 'kit' }); } catch { /* ignore */ }
    }
  });
}

/* ---------------------------------------------------------------- 按钮 */

function setupButtons() {
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
          '<div class="bye"><h2>安装向导已关闭</h2>' +
          '<p>可以关掉这个页面和那个黑色窗口了。</p>' +
          '<p class="dim">以后要用 AI，双击桌面上的「启动本地AI」。</p></div>';
      }
    }
  });

  $('btnRedetect').addEventListener('click', async () => {
    footerMsg('正在重新检测…');
    await loadDetect(true);
  });

  $('errRetry').addEventListener('click', async () => {
    footerMsg('正在重试安装…');
    resetInstallUI();
    try { await post('/api/retry'); } catch (e) { onEvent({ type: 'error', text: e.message, stage: 'internal', remedy: [] }); }
  });

  $('errRedetect').addEventListener('click', async () => {
    footerMsg('正在重新检测…');
    await loadDetect(true);
  });

  $('errCopy').addEventListener('click', copyDiagnostics);

  $('errLogs').addEventListener('click', async () => {
    try { await post('/api/open-folder', { which: 'logs' }); } catch (e) { toast(e.message); }
  });

  $('btnLaunch').addEventListener('click', async () => {
    try {
      const r = await post('/api/launch-workbench');
      if (!r.ok) throw new Error(r.error || '启动失败');
      $('launchHint').textContent = '已经启动 —— 看新弹出的黑色窗口，浏览器会自动打开工作台（首次加载模型约 1 分钟）。';
    } catch (e) {
      toast('启动失败：' + e.message);
    }
  });

  $('btnOpenFolder').addEventListener('click', async () => {
    try { await post('/api/open-folder', { which: 'install' }); } catch (e) { toast(e.message); }
  });
}

/* ---------------------------------------------------------------- 启动 */

setupButtons();
setupModal();
setupCustomDir();

// 每秒刷新「已用时」和整体进度：长步骤（下模型、装依赖）看起来才是「活的」
setInterval(() => {
  if (state.step !== 'install' || state.failed) return;
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
