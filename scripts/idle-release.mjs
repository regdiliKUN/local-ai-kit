/**
 * 工作台闲置自动释放显存。
 *
 * 为什么按「闲置」而不是「关标签页」判断：工作台（dsh）网页不对话时不和服务端保持任何连接，
 * 浏览器关没关标签页从服务端看是一样的。所以换个可以观测的信号：
 * 只要模型还占着显存，而工作台端口和模型端口在 N 分钟内都没有一条活动连接
 * （不算控制台自己的探活），就认为没人在用了，执行「停止服务并释放显存」。
 */
import { execFile } from 'node:child_process';

/**
 * 从 `netstat -ano -p TCP` 的输出里数出「别人」连到这些端口的 ESTABLISHED 连接。
 * 只看客户端那一侧（外部地址端口 = 目标端口），并排除 ignorePids（控制台自己）。
 */
export function countClientConnections(netstatText, ports, ignorePids = []) {
  const want = new Set(ports.map(Number).filter(Boolean));
  const ignore = new Set(ignorePids.map(Number));
  let n = 0;
  for (const line of String(netstatText || '').split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0] !== 'TCP' || cols[3] !== 'ESTABLISHED') continue;
    const remotePort = Number(cols[2].slice(cols[2].lastIndexOf(':') + 1));
    const pid = Number(cols[4]);
    if (want.has(remotePort) && !ignore.has(pid)) n += 1;
  }
  return n;
}

/**
 * 工作台外壳页面的在线计数。
 *
 * 外壳页（控制台的 /workbench）开着时和控制台保持一条长连接；最后一条断开后等 graceMs，
 * 期间没有新的接上（刷新页面、电脑短暂断网都会马上重连）才调用 onEmpty。
 */
export function createPresence({ graceMs = 45000, onEmpty }) {
  let count = 0;
  let timer = null;
  return {
    join() {
      count += 1;
      clearTimeout(timer);
      timer = null;
    },
    leave() {
      count = Math.max(0, count - 1);
      if (count > 0 || timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (count === 0) Promise.resolve(onEmpty()).catch(() => {});
      }, graceMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    get count() { return count; },
    get pending() { return Boolean(timer); },
  };
}

function netstat() {
  return new Promise((resolve) => {
    execFile('netstat.exe', ['-ano', '-p', 'TCP'], { windowsHide: true, timeout: 10000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

/**
 * @param {object} o
 * @param {() => {enabled:boolean, minutes:number}} o.getSetting
 * @param {() => number[]} o.ports                 要盯的端口（工作台 + 各模型）
 * @param {() => Promise<boolean>} o.modelLoaded   有没有模型占着显存
 * @param {() => boolean} o.busy                   正在启动/停止时跳过
 * @param {() => Promise<void>} o.release          释放显存
 * @param {(s:string)=>void} [o.log]
 */
export function createIdleReleaser({ getSetting, ports, modelLoaded, busy, release, log = () => {}, intervalMs = 30000 }) {
  let timer = null;
  let lastActive = Date.now();
  let wasLoaded = false;

  async function tick() {
    const { enabled, minutes } = getSetting();
    if (!enabled || busy()) { lastActive = Date.now(); return; }
    const loaded = await modelLoaded();
    if (!loaded) { wasLoaded = false; lastActive = Date.now(); return; }
    // 刚加载上：从这一刻起算，给完整的宽限期
    if (!wasLoaded) { wasLoaded = true; lastActive = Date.now(); }

    const text = await netstat();
    if (text == null) return; // 拿不到就不动手，宁可不释放也不误杀
    const active = countClientConnections(text, ports(), [process.pid]);
    const now = Date.now();
    if (active > 0) { lastActive = now; return; }
    if (now - lastActive < minutes * 60000) return;

    log(`[闲置释放] 工作台已 ${minutes} 分钟没有活动，正在停止服务并释放显存`);
    lastActive = now;
    wasLoaded = false;
    await release();
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => { tick().catch((e) => log('[闲置释放] 检查失败：' + (e.message || e))); }, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop() { clearInterval(timer); timer = null; },
    /** 设置改动后重新计时，免得一打开开关就因为「之前闲了很久」立刻释放 */
    touch() { lastActive = Date.now(); },
    tick,
  };
}
