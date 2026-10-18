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
    window.scrollTo(0, 0);
    // 第一次进「服务设置」时静默查一次版本，省得用户还要先点一下
    if (li.dataset.tab === 'settings' && !updCheckedOnce) {
      updCheckedOnce = true;
      refreshUpdateInfo({ silent: true });
    }
  });
}

/* ------------------------------------------------------------------ 状态 */

async function loadState() {
  state = await (await fetch('/api/state')).json();
  renderStatus();
  renderModels();
  renderSettings();
  renderConfig();
  reconcileUpdating();
}

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
    if (ev.scope === 'update') { handleUpdateEvent(ev); return; }
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
    } else if (ev.type === 'idle') {
      setBusy(false);
      reconcileUpdating();
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

/* ------------------------------------------------------------ 版本与更新 */

const UPD_BTN = {
  idle: '检查并更新',
  ready: '检查并更新',   // 有更新可装
  checking: '检查中…',
  updating: '更新中…',
  done: '重新检查',      // 已是最新
  error: '重试',
};

let updReport = null;
let updRunning = false;
let updCheckedOnce = false;
let updState = 'idle';

function paintUpdateButton() {
  const b = $('btnUpdate');
  b.textContent = UPD_BTN[updState] || UPD_BTN.idle;
  b.disabled = updState === 'checking' || updState === 'updating';
}

function setBadge(kind, text) {
  const el = $('updBadge');
  if (!text) { el.hidden = true; return; }
  el.hidden = false;
  el.className = `upd-badge ${kind || ''}`.trim();
  el.textContent = text;
}

function setUpdateResult(kind, html) {
  const el = $('updResult');
  if (!html) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.className = `upd-result ${kind}`;
  el.innerHTML = html;
}

function updLogLine(t) {
  const pre = $('updLog');
  pre.textContent += t + '\n';
  pre.scrollTop = pre.scrollHeight;
}

/** 把一次检查结果画成 4 行组件清单 */
function renderUpdateReport(report) {
  const list = report.components || [];
  $('updList').innerHTML = list.map((c) => {
    const outdated = c.status === 'outdated';
    const ver = outdated
      ? `<b>${esc(c.current)}</b><span class="arrow">→</span><b>${esc(c.latest)}</b>`
      : `<b>${esc(c.current)}</b>`;
    const tag = c.status === 'ok'
      ? '<span class="u-tag ok">已是最新</span>'
      : outdated
        ? `<span class="u-tag ${c.auto ? 'warn' : 'dim'}">${c.auto ? '可更新' : '需手动更新'}</span>`
        : '<span class="u-tag dim">未能检查</span>';
    const sub = c.reason
      ? `<span style="color:var(--warn)">${esc(c.reason)}</span>`
      : esc(c.hint || '');
    const link = outdated && !c.auto && c.url
      ? ` <a href="${esc(c.url)}" target="_blank" rel="noreferrer">去下载</a>`
      : '';
    return `<div class="upd-row${c.auto ? '' : ' manual'}">
      <div class="u-name">${esc(c.name)}<span class="u-sub">${sub}${link}</span></div>
      <div class="u-ver">${ver}</div>
      ${tag}
    </div>`;
  }).join('');

  const t = String(report.checkedAt || '').slice(11, 16);
  if (report.updates > 0) {
    setBadge('warn', `${report.updates} 项可更新`);
    $('updSub').textContent = report.autoUpdates
      ? `检查于 ${t}，其中 ${report.autoUpdates} 项可以自动更新，点右边按钮直接装。`
      : `检查于 ${t}，这些都要手动更新（点对应行里的「去下载」）。`;
    updState = 'ready';
  } else {
    setBadge('ok', '已是最新');
    $('updSub').textContent = `检查于 ${t}，所有组件都是最新版本。`;
    updState = 'done';
  }
  paintUpdateButton();
}

/** 只查不更（打开「服务设置」时静默跑一次） */
async function refreshUpdateInfo({ silent } = {}) {
  if (updRunning) return null;
  updState = 'checking';
  paintUpdateButton();
  try {
    const r = await fetch('/api/update/check');
    const report = await r.json();
    if (!r.ok || report.error) throw new Error(report.error || `HTTP ${r.status}`);
    updReport = report;
    renderUpdateReport(report);   // 内部会按有无更新设置按钮状态
    return report;
  } catch (e) {
    setBadge('err', '检查失败');
    $('updSub').textContent = '检查更新失败，可以稍后重试。';
    updState = 'error';
    paintUpdateButton();
    if (!silent) setUpdateResult('err', `检查失败：${esc(e.message)}<span class="u-line">常见原因：断网、GitHub / npm 访问不了、公司网络拦截。</span>`);
    return null;
  }
}

/** 点按钮：先查，有可自动更新的就立刻更新；没有就给提示 */
async function onUpdateClick() {
  if (updRunning || updState === 'checking') return;   // 前端防连点
  setUpdateResult('', '');
  $('updLog').textContent = '';
  const report = await refreshUpdateInfo({ silent: false });
  if (!report) return;

  const outdated = report.components.filter((c) => c.status === 'outdated');
  const auto = outdated.filter((c) => c.auto);
  const manual = outdated.filter((c) => !c.auto);

  if (!outdated.length) {
    setUpdateResult('ok', '已是最新版本，不需要更新。');
    toast('已是最新，无需更新');
    return;
  }
  if (!auto.length) {
    setUpdateResult('warn',
      `有 ${manual.length} 项需要手动更新：<span class="u-line">`
      + manual.map((c) => `${esc(c.name)} ${esc(c.current)} → ${esc(c.latest)}（<a href="${esc(c.url)}" target="_blank" rel="noreferrer">去下载</a>）`).join('<br>')
      + '</span>');
    toast('这些组件需要手动更新');
    return;
  }

  // 开始更新
  updRunning = true;
  updState = 'updating';
  paintUpdateButton();
  $('updProgress').hidden = false;
  $('updLogBox').hidden = false;
  $('updBar').style.width = '2%';
  $('updStatus').textContent = `正在更新 ${auto.length} 项…`;

  try {
    const r = await post('/api/update/run', {});
    if (r.started === false) {
      updRunning = false;
      updState = 'done';
      paintUpdateButton();
      $('updProgress').hidden = true;
      setUpdateResult('ok', '刚刚又检查了一遍，已经是最新版本。');
      return;
    }
    // 后续进度靠 SSE（scope=update）推送
  } catch (e) {
    updRunning = false;
    updState = 'error';
    paintUpdateButton();
    $('updProgress').hidden = true;
    setUpdateResult('err', `更新没有开始：${esc(e.message)}`);
    toast(e.message);
  }
}

/** 更新过程中的 SSE 事件（scope=update） */
function handleUpdateEvent(ev) {
  if (ev.type === 'progress') {
    $('updProgress').hidden = false;
    $('updBar').style.width = `${Math.max(2, Math.min(100, Math.round(ev.percent || 0)))}%`;
    if (ev.label) $('updStatus').textContent = `正在更新：${ev.label}`;
  } else if (ev.type === 'step') {
    updLogLine(`[${ev.id}] ${ev.text}`);
    $('updStatus').textContent = ev.text;
  } else if (ev.type === 'log') {
    updLogLine(ev.text);
  } else if (ev.type === 'done') {
    finishUpdate(true, ev.result);
  } else if (ev.type === 'error') {
    finishUpdate(false, ev.result, ev.text);
  }
}

function finishUpdate(ok, result, errText) {
  updRunning = false;
  updState = ok ? 'done' : 'error';
  paintUpdateButton();
  $('updBar').style.width = '100%';

  const lines = [];
  if (ok) {
    const ups = (result && result.updated) || [];
    lines.push(ups.length
      ? `已更新 ${ups.length} 项：<span class="u-line">${ups.map((u) => `· ${esc(u.name || u.id)} ${esc(u.from)} → ${esc(u.to)}`).join('<br>')}</span>`
      : '没有需要更新的组件。');
    if (result && result.restartHint) {
      lines.push('dsh 运行时换过了 —— <b>重启工作台</b>（先「停止服务」，再「启动工作台」）后生效。');
    }
    setUpdateResult('ok', lines.join('<span class="u-line"></span>'));
    toast('更新完成');
  } else {
    lines.push(`更新失败：${esc(errText || '未知原因')}`);
    const fails = (result && result.failed) || [];
    for (const f of fails) lines.push(`· ${esc(f.id)}：${esc(f.reason)}`);
    if (fails.some((f) => f.id === 'dsh')) lines.push('已尝试回滚到原版本；如果工作台起不来，重跑安装向导可修好。');
    setUpdateResult('err', lines.join('<span class="u-line"></span>'));
    toast('更新失败：' + (errText || '请查看日志'));
  }

  const skipped = (result && result.skipped) || [];
  if (skipped.length) {
    lines.push(`另有 ${skipped.length} 项需手动更新：${skipped.map((s) => esc(s.name || s.id)).join('、')}`);
  }

  setTimeout(() => { $('updProgress').hidden = true; }, 900);
  setTimeout(() => { refreshUpdateInfo({ silent: true }); loadState().catch(() => {}); }, 700);
}

/**
 * 用服务端的 updating 状态校准按钮。
 * 场景：更新中刷新了页面 —— 本地状态丢了，但服务端还在跑，
 * 不校准的话按钮会显示可点，点了只会拿到 409。
 */
async function reconcileUpdating() {
  if (!state) return;
  if (state.updating) {
    updRunning = true;
    updState = 'updating';
    paintUpdateButton();
    $('updProgress').hidden = false;
    if (!$('updStatus').textContent) $('updStatus').textContent = '更新正在进行中…';
  } else if (updRunning && updState === 'updating') {
    // 服务端已经跑完了，但 done 事件可能没收到（页面刚刷新 / 断线）
    updRunning = false;
    updState = 'ready';
    paintUpdateButton();
    $('updProgress').hidden = true;
  }
}

function setupUpdateCard() {
  paintUpdateButton();
  $('btnUpdate').addEventListener('click', onUpdateClick);
}

/* ------------------------------------------------------------------ 启动 */

setupButtons();
setupUpdateCard();
connectSSE();
loadState().catch((e) => {
  $('modelList').innerHTML = `<div class="issue error">读取状态失败：${esc(e.message)}</div>`;
});

// 每 5 秒刷新一次状态（服务启停、模型增删后自动跟上）
setInterval(() => { loadState().catch(() => {}); }, 5000);
