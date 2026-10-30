const $ = (id) => document.getElementById(id);
let loading = false;
let pending = false;

async function refresh() {
  if (loading) return;
  loading = true;
  try {
    const response = await fetch('/api/state');
    if (!response.ok) throw new Error('状态读取失败');
    const state = await response.json();
    for (const name of ['engine', 'webui', 'dsh']) {
      const service = state[name];
      $(name + '-status').textContent = service.online ? '● 运行中 · :' + state.ports[name] : '○ 未就绪 · :' + state.ports[name];
      $(name + '-status').className = service.online ? 'badge online' : 'badge';
      $(name + '-link').href = 'http://127.0.0.1:' + state.ports[name] + '/';
    }
    $('root').textContent = state.deploymentRoot;
    $('engine-error').textContent = state.engine.startupError || '';
    $('engine-error').hidden = !state.engine.startupError;
    document.querySelector('[data-action="webui"]').disabled = pending || !state.engine.online;
  } finally { loading = false; }
}

function message(text, error = false) { $('message').textContent = text; $('message').className = error ? 'message error' : 'message'; }

for (const button of document.querySelectorAll('[data-action]')) {
  button.addEventListener('click', async () => {
    if (pending) return;
    pending = true;
    for (const b of document.querySelectorAll('[data-action]')) b.disabled = true;
    message('正在处理，请稍候…');
    try {
      const response = await fetch('/api/service', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-LocalAI-Token': window.__TOKEN__ },
        body: JSON.stringify({ action: button.dataset.action }) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || '部分进程未能停止，请检查是否属于当前部署');
      message(button.dataset.action === 'stop' ? '服务已停止。' : result.alreadyRunning ? '服务已在运行，点击卡片上的入口即可打开。' : '启动请求已提交。模型加载需要时间，服务就绪后状态会自动更新。');
    } catch (error) { message(error.message, true); }
    finally {
      pending = false;
      for (const b of document.querySelectorAll('[data-action]')) b.disabled = false;
      refresh().catch((error) => message(error.message, true));
    }
  });
}
$('refresh').addEventListener('click', () => refresh().catch((error) => message(error.message, true)));
$('report').addEventListener('click', () => {
  window.open('/api/report', '_blank');
  message('诊断报告已开始下载。');
});
refresh().catch((error) => message(error.message, true));
setInterval(() => { refresh().catch(() => message('控制台连接已断开，请重新打开控制台。', true)); }, 5000);

/* ---------------------------------------------------------------- 机器状态 */

function fmtGB(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n} GB`;
}

/** 拉一次指标并画出来 */
async function loadMetrics() {
  let data;
  if (window.__METRICS__) {
    // 首屏注入的：先用它画一遍，省得等接口
    data = window.__METRICS__;
    window.__METRICS__ = null;
  } else {
    try {
      const response = await fetch('/api/metrics');
      if (!response.ok) return;
      data = await response.json();
    } catch { return; }
  }
  const m = data.current || {};
  const h = data.history || {};

  const gpu0 = (m.gpu || [])[0];
  const vramPct = gpu0 ? gpu0.memoryPercent : null;
  $('gVram').innerHTML = vramPct == null ? '—' : `${vramPct}<span class="unit">%</span>`;
  $('gVramSub').textContent = gpu0
    ? `${(gpu0.memoryUsedMB / 1024).toFixed(1)} / ${(gpu0.memoryTotalMB / 1024).toFixed(1)} GB`
    : '没有检测到独立显卡';
  $('gVramSpark').innerHTML = Chart.sparkline(h.vram || [], { width: 150, height: 30, min: 0, max: 100 });

  const cpuPct = m.cpu ? m.cpu.usage : null;
  $('gCpu').innerHTML = cpuPct == null ? '—' : `${cpuPct}<span class="unit">%</span>`;
  $('gCpuSub').textContent = m.cpu ? `${m.cpu.cores} 核` : '未知';
  $('gCpuSpark').innerHTML = Chart.sparkline(h.cpu || [], { width: 150, height: 30, min: 0, max: 100 });

  const memPct = m.memory ? m.memory.percent : null;
  $('gMem').innerHTML = memPct == null ? '—' : `${memPct}<span class="unit">%</span>`;
  $('gMemSub').textContent = m.memory ? `${fmtGB(m.memory.usedGB)} / ${fmtGB(m.memory.totalGB)}` : '未知';
  $('gMemSpark').innerHTML = Chart.sparkline(h.memory || [], { width: 150, height: 30, min: 0, max: 100 });

  const diskPct = m.disk ? m.disk.usedPercent : null;
  $('gDisk').innerHTML = diskPct == null ? '—' : `${diskPct}<span class="unit">%</span>`;
  $('gDiskSub').textContent = m.disk ? `${m.disk.path} 剩余 ${fmtGB(m.disk.freeGB)}` : '未知';
  $('gDiskSpark').innerHTML = Chart.sparkline(h.disk || [], { width: 150, height: 30, min: 0, max: 100 });

  if (!gpu0) {
    $('gpuDetail').innerHTML = '<p>没有检测到独立显卡 —— 模型会跑在 CPU 上，速度会很慢。</p>';
  } else {
    const rows = [
      ['型号', gpu0.name],
      ['驱动', gpu0.driver || '—'],
      ['显存占用', `${(gpu0.memoryUsedMB / 1024).toFixed(1)} / ${(gpu0.memoryTotalMB / 1024).toFixed(1)} GB`],
      ['GPU 占用', gpu0.utilization == null ? '—' : `${gpu0.utilization}%`],
      ['温度', gpu0.temperature == null ? '—' : `${gpu0.temperature} °C`],
      ['功耗', gpu0.powerWatts == null ? '—' : `${gpu0.powerWatts} W`],
    ];
    $('gpuDetail').innerHTML =
      Chart.gauge(vramPct || 0, { label: '显存占用', width: 180, height: 104 })
      + `<table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`;
  }
}

loadMetrics();
setInterval(() => { loadMetrics(); }, 3000);
