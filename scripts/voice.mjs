/**
 * 语音输入：把浏览器录下的一段音频交给本地 faster-whisper 转成文字。
 *
 * 全程离线，音频不出本机。转写进程常驻（模型只加载一次），第一次用时才拉起。
 *
 * 配置（配置.json，可选）：
 *   voicePython   装了 faster-whisper 的 python.exe
 *                 默认用 bili-duty 插件里那套（~/.dsh/bili-duty/.venv-asr）
 *   voiceHfHome   模型缓存目录（HF_HOME），默认与上面那套同目录的 .hf-cache
 *   voiceModel    Whisper 模型名，默认 small
 *   voiceDevice   auto | cuda | cpu，默认 auto（先试显卡，不行退回 CPU）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export function voiceSettings(cfg = {}) {
  const biliHome = path.join(os.homedir(), '.dsh', 'bili-duty');
  const python = cfg.voicePython || path.join(biliHome, '.venv-asr', 'Scripts', 'python.exe');
  const hfHome = cfg.voiceHfHome || path.join(biliHome, '.hf-cache');
  return {
    python,
    hfHome,
    model: cfg.voiceModel || 'small',
    device: cfg.voiceDevice || 'auto',
    tmpDir: path.join(os.tmpdir(), 'localai-voice'),
  };
}

let worker = null;      // { child, ready: Promise, pending: Map, info }
let nextId = 1;
let lastError = '';

function startWorker(cfg) {
  const s = voiceSettings(cfg);
  if (!fs.existsSync(s.python)) {
    throw new Error(`没找到语音识别环境：${s.python}。请在 配置.json 里用 voicePython 指定装了 faster-whisper 的 python.exe`);
  }
  const child = spawn(s.python, ['-u', path.join(HERE, 'voice-worker.py')], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HF_HOME: s.hfHome,
      LOCALAI_VOICE_MODEL: s.model,
      LOCALAI_VOICE_DEVICE: s.device,
      PYTHONIOENCODING: 'utf-8',
    },
  });
  const w = { child, pending: new Map(), info: null, stderr: '' };
  let buf = '';
  let resolveReady, rejectReady;
  w.ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
  w.ready.catch(() => {});

  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if ('ready' in msg) {
        if (msg.ready) { w.info = msg; resolveReady(msg); }
        else { lastError = msg.error || '语音模型加载失败'; rejectReady(new Error(lastError)); }
        continue;
      }
      const p = w.pending.get(msg.id);
      if (!p) continue;
      w.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve({ text: msg.text || '', ms: msg.ms || 0 });
    }
  });
  child.stderr.on('data', (chunk) => {
    w.stderr = (w.stderr + chunk.toString('utf8')).slice(-4000);
  });
  const onGone = (why) => {
    if (worker === w) worker = null;
    const err = new Error(why);
    rejectReady(err);
    for (const p of w.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    w.pending.clear();
  };
  child.on('error', (e) => { lastError = String(e.message || e); onGone(lastError); });
  child.on('exit', (code) => {
    if (code) {
      const tail = w.stderr.trim().split('\n').slice(-3).join(' ');
      lastError = `语音识别进程退出（${code}）${tail ? '：' + tail : ''}`;
    }
    onGone(lastError || '语音识别进程已退出');
  });
  return w;
}

function ensureWorker(cfg) {
  if (!worker) worker = startWorker(cfg);
  return worker;
}

export function voiceState(cfg) {
  const s = voiceSettings(cfg);
  return {
    available: fs.existsSync(s.python),
    loaded: Boolean(worker && worker.info),
    device: worker && worker.info ? worker.info.device : null,
    model: s.model,
    error: lastError || null,
  };
}

/** 预热：页面打开「试用」时调用，让第一次说话不用等模型加载 */
export async function warmVoice(cfg) {
  const w = ensureWorker(cfg);
  return w.ready;
}

export async function transcribe(cfg, audio, { lang = 'zh', ext = 'webm' } = {}) {
  if (!audio || !audio.length) throw new Error('没有录到声音');
  const s = voiceSettings(cfg);
  fs.mkdirSync(s.tmpDir, { recursive: true });
  const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext : 'webm';
  const file = path.join(s.tmpDir, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${safeExt}`);
  fs.writeFileSync(file, audio);
  try {
    const w = ensureWorker(cfg);
    await w.ready;
    const id = nextId++;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        w.pending.delete(id);
        reject(new Error('语音转写超时'));
      }, 120000);
      w.pending.set(id, { resolve, reject, timer });
      w.child.stdin.write(JSON.stringify({ id, path: file, lang }) + '\n');
    });
  } finally {
    fs.rm(file, { force: true }, () => {});
  }
}

export function stopVoice() {
  if (worker) { try { worker.child.kill(); } catch { /* ignore */ } worker = null; }
}

/** 读原始二进制请求体（录音），限 25 MB */
export function readAudioBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > MAX_AUDIO_BYTES) {
        failed = true;
        reject(Object.assign(new Error('录音太长了（超过 25 MB）'), { statusCode: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on('aborted', () => { if (!failed) { failed = true; reject(new Error('请求已中断')); } });
    req.on('error', reject);
  });
}
