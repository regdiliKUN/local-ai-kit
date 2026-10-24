/** 停止本地 AI 工作台：关闭 DeepSeek Harness 与 Ollama，释放显存。 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deploymentRoot, loadConfig } from './config.mjs';
import { runStrataAction } from './strata.mjs';
// 端口查询统一走 detect：以前这里只认 127.0.0.1，
// 局域网共享（0.0.0.0）或 IPv6（[::]）监听的进程会被当成「没在运行」
import { pidOnPort } from './detect.mjs';

const log = (s = '') => console.log(s);

function killPid(pid) {
  try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); return true; }
  catch { return false; }
}

const cfg = loadConfig(deploymentRoot(path.dirname(fileURLToPath(import.meta.url))));
if (cfg?.backend === 'strata') {
  try {
    const result = await runStrataAction(cfg, 'stop');
    log(result.stopped.length ? `已停止 ${result.stopped.length} 个服务进程。` : '没有需要停止的本地 AI 服务。');
    if (!result.ok) {
      log(`有 ${result.refused.length} 个进程未通过归属检查或无法停止，已保留。请检查端口占用和进程权限。`);
      process.exitCode = 1;
    }
  } catch (error) { log(error.message); process.exitCode = 1; }
} else {
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
}
