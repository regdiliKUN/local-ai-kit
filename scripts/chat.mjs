/**
 * 对话代理。
 *
 * 让控制台自己也能跟模型说话 —— 不用切到工作台就能试一个模型：
 * 换模型、试提示词、看它到底有多快。
 *
 * 直接转发 Ollama 的 /api/chat，并把 NDJSON 流翻译成页面好用的 SSE 事件：
 *   {type:'chunk', content}    一段文字
 *   {type:'done', stats}       结束，带速度统计
 *   {type:'error', text}       出错
 */

import { OLLAMA_BASE } from './ollama.mjs';

const MAX_MESSAGES = 40;

/** 校验并清洗前端传来的消息列表 */
export function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant' || m.role === 'system'))
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 20000) }));
}

/** 从 Ollama 的完成事件里算出人话的速度指标 */
export function summarize(final) {
  if (!final) return null;
  const evalCount = Number(final.eval_count) || 0;
  const promptCount = Number(final.prompt_eval_count) || 0;
  const evalNs = Number(final.eval_duration) || 0;
  const promptNs = Number(final.prompt_eval_count != null ? final.total_duration : 0) || 0;
  return {
    tokens: evalCount,
    promptTokens: promptCount,
    tokensPerSec: evalNs > 0 ? Math.round((evalCount / evalNs) * 1e9) : null,
    promptTokensPerSec: promptNs > 0 ? Math.round((promptCount / promptNs) * 1e9) : null,
    totalMs: Math.round((Number(final.total_duration) || 0) / 1e6),
  };
}

/**
 * 同时问几个模型，把结果并排比一比。
 *
 * 「换个模型会不会更好」是最难自己判断的问题 —— 同一个问题问两遍，
 * 放在一起看，差别一眼就出来了。顺便把速度也一起比了。
 *
 * @param {import('node:http').ServerResponse} res
 * @param {object} opts { models, messages, options }
 */
export async function streamCompare(res, { models, messages, options = {} }) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* 客户端断了 */ } };

  const list = (models || []).slice(0, 4);
  send({ type: 'compare-start', models: list });

  // 一个个来：并发跑会互相抢显存，结果也不可比
  for (const model of list) {
    send({ type: 'compare-item', model, status: 'running', content: '' });
    const started = Date.now();
    let last = null;
    try {
      const r = await fetch(`${OLLAMA_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: sanitizeMessages(messages),
          stream: true,
          options: {
            temperature: Number(options.temperature) || 0.7,
            num_predict: Math.max(1, Math.min(2048, Number(options.numPredict) || 512)),
            ...(options.numCtx ? { num_ctx: Number(options.numCtx) } : {}),
          },
        }),
      });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let j;
          try { j = JSON.parse(line); } catch { continue; }
          if (j.error) throw new Error(j.error);
          const content = j.message && j.message.content;
          if (content) send({ type: 'compare-chunk', model, content });
          if (j.done) last = j;
        }
      }
      const stats = summarize(last);
      send({
        type: 'compare-item',
        model,
        status: 'done',
        content: '',
        stats,
        wallMs: Date.now() - started,
      });
    } catch (e) {
      send({ type: 'compare-item', model, status: 'error', content: String(e.message || e), wallMs: Date.now() - started });
    }
  }
  send({ type: 'compare-done' });
  try { res.end(); } catch { /* ignore */ }
}
export async function streamChat(res, { model, messages, options = {} }) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* 客户端断了 */ } };

  const body = {
    model,
    messages: sanitizeMessages(messages),
    stream: true,
    options: {
      temperature: Number(options.temperature) || 0.7,
      num_predict: Math.max(1, Math.min(4096, Number(options.numPredict) || 1024)),
      ...(options.numCtx ? { num_ctx: Number(options.numCtx) } : {}),
    },
  };

  let aborted = false;
  res.on('close', () => { aborted = true; });

  try {
    const r = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok || !r.body) {
      const text = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} ${text}`.trim());
    }

    const dec = new TextDecoder();
    let buf = '';
    let last = null;
    for await (const chunk of r.body) {
      if (aborted) break;
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (j.error) { send({ type: 'error', text: j.error }); return; }
        const content = j.message && j.message.content;
        // 推理模型（qwen3 等）把思考过程放在 thinking 字段，content 在想完之后才出现；
        // 短测（num_predict 小）时 8 个 token 全花在思考上，content 一直是空的。
        // 这里把 thinking 也转发出去，否则「试一下」对推理模型会误判成「没出字」。
        const thinking = j.message && j.message.thinking;
        if (content || thinking) send({ type: 'chunk', content: content || '', thinking: thinking || '' });
        if (j.done) last = j;
      }
    }
    send({ type: 'done', stats: summarize(last) });
  } catch (e) {
    send({ type: 'error', text: String(e.message || e) });
  } finally {
    try { res.end(); } catch { /* ignore */ }
  }
}
