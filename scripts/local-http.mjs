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
        const value = size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        resolve(value);
      } catch { fail('请求必须是有效的 JSON 对象', 400); }
    });
    req.on('aborted', () => fail('请求已中断', 400));
    req.on('error', reject);
  });
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
  server.requestTimeout = 15000;
  // SSE 长连接不能被 requestTimeout 掐断
  server.setTimeout(0);
  server.keepAliveTimeout = 72000;
  return server;
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
