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
const QUICK = ['qwen3:8b', 'qwen2.5:7b', 'qwen3:14b', 'qwen2.5:14b', 'qwen3.8:27b'];

let state = null;

/* ------------------------------------------------------------------ 标签 */

for (const li of document.querySelectorAll('#tabs li')) {
  li.addEventListener('click', () => {
    for (const x of document.querySelectorAll('#tabs li')) x.classList.toggle('active', x === li);
    for (const v of document.querySelectorAll('.view')) v.hidden = true;
    $(`view-${li.dataset.tab}`).hidden = false;
    window.scrollTo(0, 0);
  });
}

/* ------------------------------------------------------------------ 状态 */

async function loadState() {
  state = await (await fetch('/api/state')).json();
  renderStatus();
  renderModels();
  renderSettings();
  renderConfig();
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

// 每 5 秒刷新一次状态（服务启停、模型增删后自动跟上）
setInterval(() => { loadState().catch(() => {}); }, 5000);
