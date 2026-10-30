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
  if (!r.ok) {
    // 把服务端的结构化提示带出来：比如 /api/retry 会告诉前端
    // 「这次失败没法原地重试，得重新走一遍向导」，前端据此决定是弹错还是回上一步
    const err = new Error(data.error || `HTTP ${r.status}`);
    if (data.needWizard) err.needWizard = true;
    throw err;
  }
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
    // 读屏要能听出「现在第几步」（步骤条本身不可点，所以不用 tabindex）
    if (i === cur) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
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
    // 手动输入的模型名也要校验：以前只判断「非空」，输个 qwen 3!!! 也能点继续，
    // 然后被服务端 400 打回来，落到「重试安装」的死循环里
    b.disabled = !state.model || !isValidModelName(state.model);
  } else if (state.step === 'location') {
    b.textContent = '开始安装';
    b.disabled = !state.modelDir || !state.spaceOk;
  } else if (state.step === 'install') {
    // 失败时不再给「关闭向导」：那会直接杀掉服务，连重试和日志都没了。
    // 现在失败/暂停都引导用户用下方面板里的按钮（重试 / 返回修改）。
    if (state.failed) { b.textContent = '返回修改'; b.disabled = false; }
    else if (state.paused) { b.textContent = '等待你完成操作…'; b.disabled = true; }
    else if (state.finished) { b.textContent = '完成'; b.disabled = false; }
    else { b.textContent = '安装中…'; b.disabled = true; }
  } else {
    b.textContent = '完成';
    b.disabled = false;
  }
}

function footerMsg(s) { $('footerMsg').textContent = s || ''; }

/* ---------------------------------------------------------- 一键按推荐装 */

/**
 * 「按推荐装」：用检测到的推荐值直接开始装，跳过选模型、选盘两步。
 *
 * 很多用户其实不知道该选哪个 —— 与其让他们在一堆卡片里犹豫，
 * 不如给一个「就这样」的按钮。选错了还能退回来改。
 */
function quickInstall() {
  const d = state.detect;
  if (!d) { toast('还没检测完，等一下'); return; }
  const errs = d.issues.filter((i) => i.level === 'error');
  if (errs.length) {
    toast('有必须先解决的问题：' + errs[0].text);
    return;
  }
  state.model = d.suggested.model;
  state.modelDir = d.suggested.modelDir;
  state.contextWindow = d.suggested.contextWindow;
  state.quick = true;
  selectModelCard(state.model);
  selectDisk(state.modelDir);
  go('location');
  footerMsg(`按推荐配置：${state.model} · 窗口 ${Math.round(state.contextWindow / 1024)}K`);
  updateNext();
  toast('已按推荐填好，点「开始安装」即可');
}

/** 装完自动跑一次体检，告诉我现在是什么状态 */
function selfCheckAfterInstall() {
  const btn = $('btnSelfCheck');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '体检中…';
    try {
      const r = await (await fetch('/api/selfcheck', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-LocalAI-Token': window.__TOKEN__ || '' },
        body: JSON.stringify({ model: state.model || '' }),
      })).json();
      $('selfCheckResult').innerHTML = r.started
        ? '<div class="issue info"><div class="issue-main">体检已启动</div>'
          + '<div class="issue-hint">大约 20 秒。装完想立刻知道状态，就点一下这里。</div></div>'
        : `<div class="issue error">体检没能启动：${esc(r.error || '未知原因')}</div>`;
    } catch (e) {
      $('selfCheckResult').innerHTML = `<div class="issue error">体检没能启动：${esc(e.message)}</div>`;
    }
    btn.disabled = false;
    btn.textContent = '装完跑一次体检';
  });
}

/* -------------------------------------------------------------- 环境检测 */

async function loadDetect(force = false) {
  $('detectBody').innerHTML = '<div class="loading"><span class="spinner"></span> 检测中...</div>';
  try {
    // 检测要 spawn 显卡查询，驱动异常时可能长时间不返回 —— 没有超时的话
    // 页面会永远停在「检测中…」，用户既不能继续也不知道为什么
    const d = (!force && window.__DETECT__)
      || await (await fetch(`/api/detect${force ? '?force=1' : ''}`, { signal: AbortSignal.timeout(30000) })).json();
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
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    $('detectBody').innerHTML = `<div class="issue error">检测失败：${esc(timeout ? '30 秒没有返回（显卡驱动可能卡住了）' : e.message)}。`
      + `<br>可以先点上面的「重新检测」；还是不行就更新显卡驱动后，关掉向导重新运行一次。</div>`;
    updateNext();
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

  // 「按推荐装」把推荐值写清楚，用户点之前就知道会装什么
  const hint = $('qiHint');
  if (hint && d.suggested) {
    hint.innerHTML = `会装 <b>${esc(d.suggested.model)}</b>，窗口 <b>${Math.round((d.suggested.contextWindow || 8192) / 1024)}K</b>`
      + (d.suggested.modelDir ? `，放在 <code>${esc(d.suggested.modelDir)}</code>` : '')
      + '。选错了还能退回来改。';
  }

  const errs = d.issues.filter((i) => i.level === 'error').length;
  footerMsg(errs ? '有必须先解决的问题，请看上面的红框' : '检测完成 —— 点右下角「继续」');

  renderRadar(d);
}

/**
 * 硬件雷达图：把「这台电脑」和「推荐配置」放一起比。
 *
 * 用户最关心的其实是「我这样够不够」—— 一张图比一堆数字直观。
 * 参考值取 README 里写的推荐档：24G 显存 / 64G 内存 / 50G 空闲盘 / 16 核。
 */
function renderRadar(d) {
  const box = $('detectRadar');
  if (!box) return;
  const sys = d.system || { cores: 0, memoryGB: 0 };
  const bestDisk = Math.max(0, ...d.disks.map((x) => x.freeGB));
  const pct = (value, target) => Math.max(0, Math.min(100, Math.round((value / target) * 100)));

  const axes = ['显存', '内存', '空闲盘', 'CPU 核数', 'Node'];
  const values = [
    pct(d.gpu.vramGB || 0, 24),
    pct(sys.memoryGB || 0, 64),
    pct(bestDisk, 50),
    pct(sys.cores || 0, 16),
    d.node.ok ? 100 : 40,
  ];

  const items = axes.map((label, i) => ({
    label,
    value: values[i],
    text: `${values[i]}%`,
    color: values[i] >= 85 ? 'var(--ok)' : values[i] >= 50 ? 'var(--warn)' : 'var(--err)',
  }));

  box.innerHTML = `
    <div class="wizard-radar">${Chart.radar(axes, values, { size: 230 })}</div>
    <div class="wizard-bars">${Chart.bars(items, { width: 300, labelW: 70, valueW: 48 })}</div>
    <p class="row-hint">参考值：24G 显存 / 64G 内存 / 50G 空闲盘 / 16 核 CPU。<b>不达标也能装</b>，只是能跑的模型更小、速度更慢。</p>`;
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

  // 单选按钮和输入框是静态节点，监听只绑一次（见 setupModelInputs）。
  // 以前写在这里，每次「重新检测」都会再绑一份 —— 点一次检测，输入框里
  // 敲一个字就触发 N+1 次 updateContext()。
  $('customModel').disabled = !customRadioChecked();
}

/** 「手动输入其他模型」这个单选框是否选中 */
function customRadioChecked() {
  const r = document.querySelector('input[name=modelPick][value="__custom__"]');
  return !!(r && r.checked);
}

/** 手动输入模型的交互：只在启动时绑一次 */
function setupModelInputs() {
  const customRadio = document.querySelector('input[name=modelPick][value="__custom__"]');
  if (!customRadio || customRadio.dataset.bound) return;
  customRadio.dataset.bound = '1';
  customRadio.addEventListener('change', () => {
    $('customModel').disabled = !customRadio.checked;
    if (customRadio.checked) {
      $('customModel').focus();
      state.model = state.customModel || '';
    } else {
      const d = state.detect;
      state.model = d ? d.suggested.model : '';
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
    // 名字不合法时「继续」要跟着变灰（以前这里不刷新，用户能看到红字但按钮还是亮的）
    updateNext();
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
    renderVramChart(d, info, vram);
    return;
  }
  const ratio = vram ? est / vram : 0;
  const flag = !vram ? ''
    : ratio > 1 ? '<span class="ctx-flag over">可能超出显存</span>'
      : ratio > 0.85 ? '<span class="ctx-flag tight">偏紧</span>'
        : '<span class="ctx-flag ok">够用</span>';
  $('ctxInfo').innerHTML = `上下文 <b>${label}</b> · 预计占用 <b>${est} GB</b> / 显存 ${vram} GB ${flag}`;

  renderVramChart(d, info, vram);
}

/** 各上下文档位的显存占用，和显卡实际显存对比 */
function renderVramChart(d, info, vram) {
  const box = $('ctxVramChart');
  if (!box) return;
  if (!info || !info.vramEstimate) {
    box.innerHTML = '<div class="chart-empty">手动输入的模型不知道体积，先保守取 8K。</div>';
    return;
  }
  const opts = d.contextOptions || [];
  const items = opts.map((o) => {
    const need = info.vramEstimate[o.value];
    const over = vram ? need > vram : false;
    return {
      label: o.label,
      value: need,
      text: `${need} GB`,
      color: over ? 'var(--err)' : (vram && need / vram > 0.85 ? 'var(--warn)' : 'var(--chart-1)'),
    };
  });
  items.push({
    label: '你的显存',
    value: vram || 0,
    text: `${vram} GB`,
    color: 'var(--chart-3)',
  });
  box.innerHTML = Chart.bars(items, { width: 340, labelW: 74, valueW: 62 })
    + '<p class="row-hint">红色那档表示模型可能装不进显存 —— 选小一档的上下文更稳。</p>';
}

/* ------------------------------------------------------------ 存放位置 */

function renderDisks(d) {
  const usable = d.disks.filter((x) => x.freeGB >= 20).sort((a, b) => b.freeGB - a.freeGB);
  $('noDisk').hidden = usable.length > 0;

  $('diskList').innerHTML = usable.map((x) => {
    const usedPct = Math.round(((x.totalGB - x.freeGB) / x.totalGB) * 100);
    return `
      <button type="button" class="disk" data-root="${esc(x.root)}" aria-pressed="false">
        <div class="letter">${x.letter}</div>
        <div class="info">
          <div class="t">${x.letter}: 盘</div>
          <div class="s">空闲 ${x.freeGB} GB / 共 ${x.totalGB} GB</div>
        </div>
        <div class="meter"><i style="width:${usedPct}%"></i></div>
      </button>`;
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
    const on = !custom && !!dir && dir.startsWith(el.dataset.root);
    el.classList.toggle('selected', on);
    // 读屏靠 aria-pressed 判断「当前选的是哪个盘」
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
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
    // 必须清掉内联宽度：.progress.indeterminate .bar 的 34% 是样式表规则，
    // 内联 style 优先级更高。上一段下载到 100% 后这里不清，就会看到一条满格条在横冲。
    $('progressBar').style.width = '';
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
  verify: '校验模型',
  dsh: '安装 DeepSeek Harness',
  config: '写入配置',
  shortcuts: '创建桌面快捷方式',
  internal: '启动安装',
};

/** 上一次「需要提权 / 需要先装组件」的说明，paused 面板要复用它 */
let lastNeedsElevation = null;
let pausedTimer = null;

/**
 * 「缺前置」不是失败：比如没装 Ollama。
 *
 * 以前这里只把标题改一改就完事了 —— 用户点弹窗里的「我自己装」之后，
 * 弹窗关掉、页面上没有任何按钮可点（「继续」是「安装中…」且禁用、上一步是隐藏的），
 * 只能关窗口重来。而且提示写着「装完会自动继续」，其实没有人在盯着 Ollama 有没有装好。
 *
 * 现在：给出可点的「我已经装好了，继续安装」，并且每 15 秒问一次检测接口，
 * 真装好了就自动接着装。
 */
function showPaused(ev) {
  state.failed = false;
  state.finished = false;
  state.paused = true;
  $('installTitle').textContent = '需要你完成一步操作';
  $('installLead').textContent = '按下面说的做；做完点「我已经装好了，继续安装」，或者等它自己检测到。';
  $('keepOpen').hidden = false;
  $('progressWrap').hidden = true;
  pending = null;

  const reason = (lastNeedsElevation && lastNeedsElevation.reason) || '缺少一个必须先装好的组件。';
  const hint = (lastNeedsElevation && lastNeedsElevation.hint) || '';
  $('errorPanel').classList.add('warn');
  $('errTitle').textContent = '需要你完成一步操作';
  $('errStage').innerHTML = `停在了：<b>${esc(STAGE_NAMES[ev.stage] || ev.stage || '安装过程')}</b>`;
  $('errWhy').textContent = reason;
  $('errHow').innerHTML = (hint
    ? [hint, '装好后回到这个页面点「我已经装好了，继续安装」。']
    : ['装好后回到这个页面点「我已经装好了，继续安装」。'])
    .map((s) => `<li>${esc(s)}</li>`).join('');
  $('errRetry').textContent = '我已经装好了，继续安装';
  $('errorPanel').hidden = false;
  footerMsg('等待你完成上一步操作…');
  updateNext();
  startPausedWatch();
}

/** 每 15 秒看一眼组件装好了没，装好了就自动续装 */
function startPausedWatch() {
  stopPausedWatch();
  pausedTimer = setInterval(async () => {
    if (!state.paused) { stopPausedWatch(); return; }
    try {
      const d = await (await fetch('/api/detect?force=1', { signal: AbortSignal.timeout(20000) })).json();
      if (d && d.ollama && d.ollama.installed) {
        stopPausedWatch();
        state.paused = false;
        footerMsg('检测到组件已装好，正在继续安装…');
        resetInstallUI();
        try { await post('/api/retry'); } catch (e) { footerMsg(e.message); }
      }
    } catch { /* 检测失败就再等一轮 */ }
  }, 15000);
}

function stopPausedWatch() {
  if (pausedTimer) { clearInterval(pausedTimer); pausedTimer = null; }
}

function showError(ev) {
  state.failed = true;
  state.finished = true;
  state.paused = false;
  stopPausedWatch();
  state.errorInfo = ev;
  $('errorPanel').classList.remove('warn');
  $('errTitle').textContent = '安装没有完成';
  $('errRetry').textContent = '重试安装';

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
  // 装完自检：单独一条线，不影响安装进度
  if (ev.type === 'selfcheck-item') {
    const box = $('selfCheckResult');
    if (box) {
      const done = box.querySelectorAll('.sc-item').length;
      box.innerHTML = `<div class="issue info"><div class="issue-main">体检进行中…（${done + 1} 题）</div>
        <div class="issue-hint">21 道质量题，跑完就知道模型能不能用了。</div></div>`;
    }
    return;
  }
  if (ev.type === 'selfcheck-done') {
    const box = $('selfCheckResult');
    const s = ev.summary || {};
    const rows = ((s.verdicts) || []).map((v) =>
      `<div class="row"><span class="k">${v.ok ? '✅' : '❌'} ${esc(v.name)}</span><span class="v">${esc(v.detail)}</span></div>`).join('');
    if (box) {
      box.innerHTML = `<div class="summary">${rows || '<div class="row"><span class="k">—</span><span class="v">没有结果</span></div>'}</div>`;
    }
    toast(ev.ok ? '体检通过，装好了就能用' : '体检有不达标项，去控制台看看');
    return;
  }
  if (ev.type === 'selfcheck-error') {
    const box = $('selfCheckResult');
    if (box) box.innerHTML = `<div class="issue error"><div class="issue-main">体检失败</div><div class="issue-hint">${esc(ev.text || '')}</div></div>`;
    return;
  }

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
    lastNeedsElevation = ev;
    showModal(ev.reason, ev.hint, ev.action);
  } else if (ev.type === 'paused') {
    showPaused(ev);
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

let sseErrors = 0;

/**
 * 安装服务的连接断了 —— 必须让用户知道。
 *
 * EventSource 会自动重连，但有两种情况它会永久 CLOSED：服务进程被杀
 * （用户关掉了那个黑色窗口，正是页面上反复警告别做的事），以及服务以
 * 非 200 响应（比如提权重启后端口变了）。以前 onerror 是空的，
 * 页面就一直停在「安装中…」，进度条还在慢慢爬，用户完全不知道连接已经没了。
 */
function showConnBanner() {
  if ($('connBanner')) return;
  const el = document.createElement('div');
  el.id = 'connBanner';
  el.className = 'conn-banner';
  el.innerHTML = '<b>与安装服务的连接已断开</b>'
    + '<span>请检查那个黑色窗口是否还开着。重新双击「① 双击这里开始安装.cmd」可以继续安装，已完成的步骤不会重来。</span>'
    + '<button class="btn ghost small" id="connReload">重新加载页面</button>';
  document.body.appendChild(el);
  const btn = $('connReload');
  if (btn) btn.addEventListener('click', () => location.reload());
}

function connectSSE() {
  const es = new EventSource('/api/events');
  es.onopen = () => { sseErrors = 0; };
  es.onmessage = (m) => {
    try { onEvent(JSON.parse(m.data)); } catch { /* ignore */ }
  };
  es.onerror = () => {
    sseErrors += 1;
    if (es.readyState === EventSource.CLOSED || sseErrors >= 3) {
      try { es.close(); } catch { /* ignore */ }
      showConnBanner();
      footerMsg('连接已断开 —— 请看页面顶部的提示');
    }
  };
}

/* ---------------------------------------------------------------- 弹窗 */

let modalReturnFocus = null;

function showModal(reason, hint, action) {
  // 记下打开弹窗前的焦点，关掉时还回去（键盘用户不会「丢」在页面顶部）
  modalReturnFocus = document.activeElement;
  const isOllama = action === 'install-ollama';
  $('modalTitle').textContent = isOllama ? '需要先装一个组件' : '需要管理员权限';
  $('modalReason').textContent = reason || '';
  $('modalHint').textContent = hint || '';
  $('modalOk').dataset.action = action || '';
  $('modalOk').textContent = isOllama ? '自动安装 Ollama' : '自动以管理员身份继续';
  $('modalCancel').textContent = isOllama ? '我自己装' : '稍后再说';
  $('modalMask').hidden = false;
  // 焦点移进弹窗，Tab 才不会跑到后面的页面上
  setTimeout(() => { const b = $('modalOk'); if (b) b.focus(); }, 30);
}

function hideModal() {
  const mask = $('modalMask');
  if (!mask || mask.hidden) return;
  mask.hidden = true;
  if (modalReturnFocus && typeof modalReturnFocus.focus === 'function') {
    try { modalReturnFocus.focus(); } catch { /* 元素可能已经被重绘掉了 */ }
  }
  modalReturnFocus = null;
}

function setupModal() {
  $('modalCancel').addEventListener('click', hideModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('modalMask').hidden) { e.preventDefault(); hideModal(); }
  });
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
    else if (state.step === 'install' && state.failed) {
      resetInstallUI();
      go('location');
    }
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
    // 检测结果写在 #view-detect 里，不切过去的话用户只会看到底部文案变了，
    // 人还停在原来的页面上，以为按钮没反应
    resetInstallUI();
    go('detect');
  });

  if ($('btnQuickInstall')) {
    $('btnQuickInstall').addEventListener('click', quickInstall);
  }
  selfCheckAfterInstall();

  $('errRetry').addEventListener('click', async () => {
    footerMsg('正在重试安装…');
    resetInstallUI();
    try {
      await post('/api/retry');
    } catch (e) {
      // 服务端说「没有可重试的安装」时，再点「重试」只会一直弹同一句错误。
      // 这种情况直接把人送回向导，让他重新选一次。
      if (e.needWizard) {
        toast('需要重新走一遍向导');
        go('location');
        return;
      }
      onEvent({ type: 'error', text: e.message, stage: 'internal', remedy: [] });
    }
  });

  // 错误面板里的「返回上一步修改」：模型选错了 / 盘选错了，都得能退回去改
  if ($('errBack')) {
    $('errBack').addEventListener('click', () => {
      resetInstallUI();
      go('location');
    });
  }

  $('errRedetect').addEventListener('click', async () => {
    footerMsg('正在重新检测…');
    await loadDetect(true);
    resetInstallUI();
    go('detect');
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
setupModelInputs();

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
