/**
 * 共用的回环 HTTP 助手。
 *
 * 安装向导和控制台都只监听 127.0.0.1，但浏览器里任何网页都能向它发请求，
 * 所以这里集中处理三件事：
 *   1. 来源校验：Host 头（防 DNS rebinding）+ 随机令牌（防跨站）
 *   2. 限流：本地页面也会被恶意网页「诱导点击」，别让一个坏页面把服务打满
 *   3. 健壮性：畸形请求体、超大请求体都不能把服务带崩
 */

import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';

export function tokenMatches(value, expected) {
  const a = Buffer.from(String(value || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * 读请求体并解析成 JSON。
 *
 * 按 JSON 规范，application/json 应该是 UTF-8。但中文 Windows 生态里有些客户端
 * 会带 `charset=gbk` 发过来 —— 如果一律按 UTF-8 解，中文会变成一堆问号。
 * 所以这里认一下 Content-Type 上声明的编码。
 */
export function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    const fail = (message, statusCode) => {
      failed = true;
      reject(Object.assign(new Error(message), { statusCode }));
    };
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) return fail('请求内容超过 64 KiB', 413);
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      try {
        const raw = Buffer.concat(chunks);
        const text = decodeBody(raw, req.headers['content-type']);
        const value = size ? JSON.parse(text) : {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        resolve(value);
      } catch { fail('请求必须是有效的 JSON 对象', 400); }
    });
    req.on('aborted', () => fail('请求已中断', 400));
    req.on('error', reject);
  });
}

/** 按 Content-Type 声明的编码解码请求体（默认 UTF-8） */
export function decodeBody(raw, contentType) {
  const match = /charset=([\w-]+)/i.exec(String(contentType || ''));
  const charset = (match ? match[1] : 'utf-8').toLowerCase();
  const encoding = ['utf-8', 'utf8', 'ascii', 'latin1', 'binary'].includes(charset) ? 'utf8' : charset;
  try {
    return new TextDecoder(encoding).decode(raw);
  } catch {
    return raw.toString('utf8');
  }
}

/**
 * 每个响应都带上这些头。
 *
 * 本地页面不加载任何外部资源，但补上 CSP 可以顺手挡掉「页面里塞进一个
 * 指向外部的脚本」这类注入（模型名、目录名这些字符串会进到 HTML 里）。
 */
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self' 'unsafe-inline'; connect-src 'self'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export function applySecurityHeaders(res) {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
}

export function jsonResponse(res, code, body) {
  applySecurityHeaders(res);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * 限流器：按「分钟」分桶计数。
 *
 * 为什么要限：控制台页面每 5 秒会拉一次 /api/state，这属于正常流量，
 * 所以 GET 的额度给得比较宽（240 次/分钟 ≈ 4 次/秒，够几十个标签页轮询）。
 * 而 POST 是「会改东西」的操作，额度收紧到 30 次/分钟，挡住疯狂重试的脚本。
 */
export function createRateLimiter({ getLimit = 240, postLimit = 30, windowMs = 60000 } = {}) {
  const buckets = new Map();
  return function allow(req) {
    const now = Date.now();
    const key = `${req.socket?.remoteAddress || 'local'}:${req.method === 'POST' ? 'post' : 'get'}`;
    const limit = req.method === 'POST' ? postLimit : getLimit;
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.start >= windowMs) {
      bucket = { start: now, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    // 顺手清理过期桶，避免长时间运行后 Map 无限增长
    if (buckets.size > 64) {
      for (const [k, b] of buckets) if (now - b.start >= windowMs) buckets.delete(k);
    }
    return { ok: bucket.count <= limit, remaining: Math.max(0, limit - bucket.count), limit };
  };
}

/**
 * 生成一组「来源校验」函数。
 *
 * hostOk  —— Host 头必须是本机 + 当前端口，挡住 DNS rebinding
 * postOk  —— Origin 必须在白名单里，且必须带上页面里注入的随机令牌
 */
export function createOriginGuard({ port, token }) {
  const allowed = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  return {
    hostOk(req) {
      const h = String(req.headers.host || '').toLowerCase();
      return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
    },
    postOk(req) {
      const origin = req.headers.origin;
      if (origin && !allowed.has(String(origin))) return false;
      const t = String(req.headers['x-localai-token'] || '');
      return tokenMatches(t, token);
    },
  };
}

export function createSafeServer(handler) {
  const server = http.createServer((req, res) => {
    Promise.resolve().then(() => handler(req, res)).catch((error) => {
      if (res.destroyed) return;
      if (res.headersSent) return res.destroy();
      applySecurityHeaders(res);
      res.writeHead(error.statusCode || 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.statusCode ? error.message : '操作失败，请检查配置和服务日志' }));
    });
  });
  /*
   * 超时设置有个坑：
   * requestTimeout 是「整个请求最多多久」。SSE 是长连接，请求永远不会「结束」，
   * 所以只要设了它（比如默认 15 秒 / 30 秒），SSE 就会被定期掐断，
   * 浏览器马上重连 —— 于是变成一个「疯狂重连」的死循环，还能把限流器打满。
   *
   * 所以：整体不限时（0），但保留 headersTimeout 防止「慢速发头」的攻击。
   * 服务只监听 127.0.0.1 且 POST 需要随机令牌，风险可控。
   */
  server.requestTimeout = 0;
  server.timeout = 0;
  server.headersTimeout = 60000;
  server.keepAliveTimeout = 72000;
  return server;
}

/**
 * 打开一条 SSE 通道。
 *
 * 顺带做三件小事：
 *   - 定期发心跳注释（`: ping`），让中间设备别把「看起来闲着」的连接掐了
 *   - 客户端断开时把心跳定时器清掉，不留后台泄漏
 *   - 写失败（客户端已经走了但服务端还没察觉）时通知调用方，把它从连接表里摘掉
 *
 * 最后这条很重要：浏览器对同一个源最多只开 6 条 HTTP/1.1 连接，
 * 一旦积累了几条「僵尸」SSE（页面跳走了、连接却还挂着），
 * 新的 SSE 就会被浏览器排队，页面上的进度条从此再也不动。
 */
export function openEventStream(res, { heartbeatMs = 25000, onDead } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  let dead = false;
  const timer = setInterval(() => {
    if (dead) return;
    try { res.write(': ping\n\n'); } catch { markDead(); }
  }, heartbeatMs);
  if (typeof timer.unref === 'function') timer.unref();

  function markDead() {
    if (dead) return;
    dead = true;
    clearInterval(timer);
    if (onDead) { try { onDead(); } catch { /* ignore */ } }
  }

  res.on('close', markDead);
  res.on('error', markDead);

  return {
    get dead() { return dead; },
    send(obj) {
      if (dead) return false;
      try {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
        return true;
      } catch {
        markDead();
        return false;
      }
    },
  };
}

/**
 * 静态文件服务：只允许 UI 目录内的文件。
 *
 * 路径穿越（../../etc/passwd）在这里被挡住：先把请求里的分隔符统一成 /，
 * 拒绝含 .. 的片段，再拼路径并校验最终路径确实在 UI 目录里。
 */
export function resolveStaticPath(uiDir, relative) {
  const clean = String(relative || '').replace(/\\/g, '/');
  if (!clean || clean.includes('\0')) return null;
  if (clean.split('/').some((part) => part === '..' || part === '')) return null;
  const full = path.resolve(uiDir, clean);
  const base = path.resolve(uiDir);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}
