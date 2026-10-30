/**
 * 性能基准测试。
 *
 * 「这机器跑起来到底快不快」—— 用户最常问但最难回答的问题。
 * 因为「慢」有两种完全不同的原因：
 *   - 生成慢（tokens/s 低）→ 换更大的显卡有用
 *   - 读上下文慢（prompt eval 慢）→ 上下文开太大就有问题
 *
 * 所以这里分开测两个指标，并给出「该怎么调」的判读。
 *
 * 只用 Ollama 的 /api/chat —— 它返回的 eval_count / eval_duration /
 * prompt_eval_count / prompt_eval_duration 就是现成的测量数据。
 */

import { OLLAMA_BASE } from './ollama.mjs';

const LOREM = [
  '本地大模型正在你的电脑上运行。', '所有推理都发生在这台机器上，不会发送到任何服务器。',
  '显存决定了你能同时装下多大的模型和多少上下文。', '上下文越长，模型能记住的对话内容就越多。',
  '但上下文越长，每生成一个 token 都要把整段上下文重新看一遍，速度也就越慢。',
  '压缩机制会在会话快要撑满的时候，把前面的对话摘要成一小段。',
];

/** 拼一段大约 tokens 个字的提示词（中文大约 1 字 ≈ 0.7 token，这里按 1.5 字/token 估） */
export function makePrompt(targetTokens) {
  const words = [];
  let length = 0;
  let i = 0;
  while (length < targetTokens) {
    const s = LOREM[i % LOREM.length];
    words.push(s);
    length += s.length;
    i += 1;
  }
  return words.join('') + '\n\n请用一句话总结上面这段文字的要点。';
}

/** 从 Ollama 的完成事件里抽速度指标 */
export function extractRates(final) {
  const tokens = Number(final.eval_count) || 0;
  const promptTokens = Number(final.prompt_eval_count) || 0;
  const evalNs = Number(final.eval_duration) || 0;
  const promptNs = Number(final.prompt_eval_duration) || 0;
  return {
    tokens,
    promptTokens,
    genTokensPerSec: evalNs > 0 ? Math.round((tokens / evalNs) * 1e9) : null,
    promptTokensPerSec: promptNs > 0 ? Math.round((promptTokens / promptNs) * 1e9) : null,
    loadMs: Math.round((Number(final.total_duration) || 0) / 1e6),
    totalMs: Math.round((Number(final.total_duration) || 0) / 1e6),
  };
}

/** 中位数（比平均数抗干扰：偶发的一次卡顿不该把结论带偏） */
export function median(values) {
  const nums = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : Math.round((nums[mid - 1] + nums[mid]) / 2);
}

/**
 * 参考值：不同显存档位下「正常应该有多快」。
 * 数字来自 4090（24G）上实测的同代模型，别的卡按比例缩放，只作参考。
 */
export const REFERENCE = {
  24: { gen: 55, prompt: 900 },
  16: { gen: 32, prompt: 520 },
  12: { gen: 22, prompt: 360 },
  8: { gen: 14, prompt: 240 },
  0: { gen: 3, prompt: 40 },
};

/** 按显存大小给出参考值（向下取最接近的一档） */
export function referenceFor(vramGB) {
  const tiers = Object.keys(REFERENCE).map(Number).sort((a, b) => b - a);
  for (const t of tiers) if ((vramGB || 0) >= t) return REFERENCE[t];
  return REFERENCE[0];
}

/**
 * 跑一次基准。
 *
 * @param {object} opts
 * @param {string} opts.model
 * @param {number} [opts.runs]      重复几次取中位数
 * @param {number} [opts.promptTokens] 长提示词的 token 数（测读上下文速度）
 * @param {number} [opts.vramGB]    显卡显存，用来给参考值
 * @param {number} [opts.numCtx]    上下文窗口
 */
export async function runBenchmark({ model, runs = 3, promptTokens = 2000, vramGB = 0, numCtx = 0, onProgress = null }) {
  const results = { model, runs, generation: [], prompt: [], error: null };

  const call = async (prompt, options) => {
    const r = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false, options }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} ${t}`.trim());
    }
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return extractRates(j);
  };

  try {
    /* ---- 1. 预热：第一次调用要把模型从磁盘读进显存，不算数 ---- */
    if (onProgress) onProgress({ phase: 'warmup', percent: 5 });
    await call('你好', { num_predict: 8, ...(numCtx ? { num_ctx: numCtx } : {}) });

    /* ---- 2. 生成速度 ---- */
    for (let i = 0; i < runs; i++) {
      if (onProgress) onProgress({ phase: 'generation', percent: 10 + Math.round((i / runs) * 40) });
      const r = await call('用三句话介绍你自己。', {
        num_predict: 128,
        ...(numCtx ? { num_ctx: numCtx } : {}),
      });
      results.generation.push(r);
    }

    /* ---- 3. 读上下文的速度（长提示词） ---- */
    if (onProgress) onProgress({ phase: 'prompt', percent: 55 });
    const long = await call(makePrompt(promptTokens), {
      num_predict: 32,
      ...(numCtx ? { num_ctx: numCtx } : {}),
    });
    results.prompt.push(long);

    if (onProgress) onProgress({ phase: 'done', percent: 100 });
  } catch (e) {
    results.error = String(e.message || e);
    if (onProgress) onProgress({ phase: 'error', percent: 100, text: results.error });
    return results;
  }

  /* ---- 4. 判读 ---- */
  const ref = referenceFor(vramGB);
  const gen = median(results.generation.map((r) => r.genTokensPerSec));
  const promptRate = median(results.prompt.map((r) => r.promptTokensPerSec));
  const avgLoad = Math.round(results.generation.reduce((n, r) => n + r.loadMs, 0) / (results.generation.length || 1));

  results.verdict = {
    genTokensPerSec: gen,
    promptTokensPerSec: promptRate,
    avgLoadMs: avgLoad,
    reference: ref,
    genLevel: level(gen, ref.gen),
    promptLevel: level(promptRate, ref.prompt),
    advice: advice(gen, promptRate, ref),
  };
  return results;
}

/** 达成度：>= 参考值算优秀，>= 60% 算正常，明显偏低算偏慢 */
function level(value, reference) {
  if (!value || !reference) return 'unknown';
  const ratio = value / reference;
  if (ratio >= 1) return 'good';
  if (ratio >= 0.6) return 'ok';
  if (ratio >= 0.3) return 'slow';
  return 'verySlow';
}

/** 给出可执行的建议（别只说「慢」，要说改什么） */
function advice(gen, promptRate, ref) {
  const out = [];
  if (!gen) return ['没测出生成速度，先确认模型能正常加载。'];
  if (gen < ref.gen * 0.3) {
    out.push('生成速度明显偏低：模型多半是跑在 CPU 上（显卡没被用上），或者显存不够被挤到内存里了。去「系统概览」看看 GPU 占用是不是 0。');
  }
  if (promptRate && ref.prompt && promptRate < ref.prompt * 0.4) {
    out.push('读长提示词特别慢：说明上下文开得太大。把「上下文与模型」里的窗口调小一档通常立刻见效。');
  }
  if (gen >= ref.gen && promptRate >= ref.prompt * 0.6) {
    out.push('速度正常，这套配置没问题。');
  }
  if (gen && gen < ref.gen * 0.6 && gen >= ref.gen * 0.3) {
    out.push('生成速度略低于同档显存的常见值。如果感觉聊天「变笨」，那是另一个问题，用「模型体检」量一下。');
  }
  return out;
}
