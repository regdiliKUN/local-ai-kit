/** 停止本地 AI 工作台：关闭 DeepSeek Harness 与 Ollama，释放显存。 */

import { execSync } from 'node:child_process';

const log = (s = '') => console.log(s);

function pidOnPort(port) {
  try {
    const out = execSync('netstat -ano -p TCP', { encoding: 'utf8' });
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
      if (m && Number(m[1]) === port) return Number(m[2]);
    }
  } catch { /* ignore */ }
  return null;
}

function killPid(pid) {
  try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); return true; }
  catch { return false; }
}

log('正在停止本地 AI 工作台...');

const dshPid = pidOnPort(3080);
if (dshPid) {
  log(killPid(dshPid) ? `  DeepSeek Harness 已停止 (PID ${dshPid})。` : `  无法停止 PID ${dshPid}，请手动结束。`);
} else {
  log('  DeepSeek Harness 本来就没在运行。');
}

let stopped = false;
for (const img of ['ollama app.exe', 'ollama.exe']) {
  try { execSync(`taskkill /IM "${img}" /F`, { stdio: 'ignore' }); stopped = true; } catch { /* ignore */ }
}
log(stopped ? '  Ollama 已停止，显存已释放。' : '  Ollama 本来就没在运行。');

log('\n完成。');
