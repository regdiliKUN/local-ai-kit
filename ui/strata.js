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
refresh().catch((error) => message(error.message, true));
setInterval(() => { refresh().catch(() => message('控制台连接已断开，请重新打开控制台。', true)); }, 5000);
