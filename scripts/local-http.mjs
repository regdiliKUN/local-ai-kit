/** Shared loopback HTTP helpers. Reject malformed input without crashing the server. */
import http from 'node:http';
import crypto from 'node:crypto';

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

export function createSafeServer(handler) {
  const server = http.createServer((req, res) => {
    Promise.resolve().then(() => handler(req, res)).catch((error) => {
      if (res.destroyed) return;
      if (res.headersSent) return res.destroy();
      res.writeHead(error.statusCode || 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.statusCode ? error.message : '操作失败，请检查配置和服务日志' }));
    });
  });
  server.requestTimeout = 15000;
  return server;
}
