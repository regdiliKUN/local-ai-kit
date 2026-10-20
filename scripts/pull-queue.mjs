/**
 * 模型下载队列。
 *
 * 原来一次只能下一个模型：下一个的时候别的全得排队等着，用户只能干瞪眼。
 * 现在改成真正的队列 —— 想下几个加几个，排队顺序清楚，每一个都有独立的
 * 进度条，都能单独取消。
 *
 * 设计：
 *   - 同一时间只跑一个下载（Ollama 本身也只支持这样，并发反而互相拖慢）
 *   - 队列状态随时可以取，界面直接照着画
 *   - 事件通过回调抛出去，console.mjs 负责转成 SSE
 */

import { OLLAMA_BASE } from './ollama.mjs';

const MAX_QUEUE = 20;

export function createPullQueue({ emit } = {}) {
  /** @type {Array<{model:string,status:string,percent:number,got:number,total:number,speed:number,eta:number,error:string}>} */
  const items = [];
  let running = false;
  let current = null;      // 正在跑的 AbortController
  let stopped = false;

  function snapshot() {
    return {
      items: items.map((it) => ({ ...it })),
      running: !!running,
      current: current ? current.model : null,
    };
  }

  function notify() {
    if (emit) emit({ type: 'queue', state: snapshot() });
  }

  /** 加入队列；已经在队列里或正在下的不会重复加 */
  function add(model) {
    const name = String(model || '').trim();
    if (!name) return { ok: false, error: '模型名不能为空' };
    if (items.length >= MAX_QUEUE) return { ok: false, error: `队列最多 ${MAX_QUEUE} 个，先删掉几个再试` };
    if (items.some((it) => it.model === name)) return { ok: false, error: `「${name}」已经在队列里了` };
    items.push({
      model: name, status: 'queued', percent: 0, got: 0, total: 0, speed: 0, eta: 0, error: '',
    });
    notify();
    pump();
    return { ok: true };
  }

  /** 取消某个还没开始的任务；正在下的那个只能标记（由 abort 处理） */
  function cancel(model) {
    const name = String(model || '').trim();
    const index = items.findIndex((it) => it.model === name);
    if (index < 0) return { ok: false, error: '队列里没有这个任务' };
    if (items[index].status === 'running') {
      items[index].status = 'cancelling';
      if (current) current.abort();
      notify();
      return { ok: true };
    }
    items.splice(index, 1);
    notify();
    return { ok: true };
  }

  function clearFinished() {
    for (let i = items.length - 1; i >= 0; i--) {
      if (['done', 'error', 'cancelled'].includes(items[i].status)) items.splice(i, 1);
    }
    notify();
  }

  function update(model, patch) {
    const item = items.find((it) => it.model === model);
    if (!item) return;
    Object.assign(item, patch);
    notify();
  }

  /** 取下一个待下载的任务开始跑 */
  function pump() {
    if (running) return;
    const next = items.find((it) => it.status === 'queued');
    if (!next) return;
    running = true;
    run(next).finally(() => {
      running = false;
      current = null;
      notify();
      pump();
    });
  }

  async function run(item) {
    const controller = new AbortController();
    current = controller;
    update(item.model, { status: 'running', percent: 0, error: '' });

    const parts = new Map();
    let lastFlush = 0;
    let lastAt = 0;
    let lastGot = 0;
    let speed = 0;

    const flush = (force) => {
      const now = Date.now();
      if (!force && now - lastFlush < 300) return;
      lastFlush = now;
      let got = 0; let total = 0;
      for (const p of parts.values()) { got += p.got; total += p.total; }
      if (lastAt) {
        const dt = (now - lastAt) / 1000;
        if (dt > 0.3 && got >= lastGot) {
          const inst = (got - lastGot) / dt;
          speed = speed ? speed * 0.6 + inst * 0.4 : inst;
        }
      }
      lastAt = now; lastGot = got;
      const pct = total > 0 ? Math.min(99, Math.floor((got / total) * 100)) : 0;
      update(item.model, {
        percent: pct, got, total, speed,
        eta: speed > 0 && total > got ? (total - got) / speed : 0,
      });
    };

    try {
      const r = await fetch(`${OLLAMA_BASE}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: item.model, stream: true }),
        signal: controller.signal,
      });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);

      const dec = new TextDecoder();
      let buf = '';
      const handle = (line) => {
        const s = line.trim();
        if (!s) return;
        let j;
        try { j = JSON.parse(s); } catch { return; }
        if (j.error) throw new Error(j.error);
        if (j.total) {
          const id = j.digest || j.status;
          const cur = parts.get(id) || { got: 0, total: 0 };
          if (j.total > 0) cur.total = j.total;
          cur.got = Math.max(cur.got, Math.min(j.completed || 0, cur.total || j.completed || 0));
          parts.set(id, cur);
          flush();
        }
      };

      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
      }
      if (buf.trim()) handle(buf);

      flush(true);
      update(item.model, { status: 'done', percent: 100, speed: 0, eta: 0 });
    } catch (e) {
      if (stopped || e.name === 'AbortError') {
        update(item.model, { status: 'cancelled', speed: 0, eta: 0 });
      } else {
        update(item.model, { status: 'error', error: String(e.message || e), speed: 0, eta: 0 });
      }
    }
  }

  return {
    add,
    cancel,
    clearFinished,
    snapshot,
    /** 队列里还有没干完的活？控制台据此决定「能不能改配置」 */
    isBusy: () => running || items.some((it) => ['queued', 'running', 'cancelling'].includes(it.status)),
    stop() { stopped = true; if (current) current.abort(); },
  };
}
