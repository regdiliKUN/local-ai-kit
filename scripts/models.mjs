/**
 * 可选模型表。
 *
 * gb     = 实测下载体积（来自 Ollama registry，单位 GB）
 * needGB = 运行所需显存（含 KV cache 与开销余量）
 * params = 参数量（B），只用来估算 KV cache 占用
 * 按体积从大到小排列，推荐逻辑取「显存跑得动的第一个」。
 */

export const MODEL_CHOICES = [
  {
    tag: 'qwen3:32b',
    name: 'Qwen3 32B',
    gb: 20.0,
    needGB: 23,
    params: 32,
    note: '质量最强，长任务与工具调用最好',
    tags: ['推荐', '工具调用'],
  },
  {
    tag: 'qwen3:30b-a3b',
    name: 'Qwen3 30B-A3B',
    gb: 19.0,
    needGB: 22,
    params: 30,
    note: 'agentic 编码方向强化（MoE，显存占用更低）',
    tags: ['工具调用'],
  },
  {
    tag: 'qwen3:14b',
    name: 'Qwen3 14B',
    gb: 9.3,
    needGB: 13,
    params: 14,
    note: '推理能力较强',
    tags: ['工具调用'],
  },
  {
    tag: 'qwen2.5:14b',
    name: 'Qwen2.5 14B',
    gb: 9.0,
    needGB: 13,
    params: 14,
    note: '成熟稳定，工具调用可靠',
    tags: ['工具调用'],
  },
  {
    tag: 'qwen3:8b',
    name: 'Qwen3 8B',
    gb: 5.2,
    needGB: 8,
    params: 8,
    note: '8GB 显存即可运行',
    tags: ['工具调用'],
  },
  {
    tag: 'qwen2.5:7b',
    name: 'Qwen2.5 7B',
    gb: 4.7,
    needGB: 7,
    params: 7,
    note: '轻量通用',
    tags: ['工具调用'],
  },
  {
    tag: 'qwen2.5:3b',
    name: 'Qwen2.5 3B',
    gb: 1.9,
    needGB: 4,
    params: 3,
    note: '小显存 / 纯 CPU 兜底',
    tags: [],
  },
  {
    tag: 'llama3.2:3b',
    name: 'Llama 3.2 3B',
    gb: 2.0,
    needGB: 4,
    params: 3,
    note: '体积很小',
    tags: [],
  },
];

export const DEFAULT_MODEL = MODEL_CHOICES[0].tag;

/**
 * agent 模式（dsh 工作台）能用的最小上下文窗口。
 *
 * 不能更小的原因不是显存，而是 dsh 自身的固定开销：persona + plan-mode 说明 +
 * 20 多个工具的定义 + agent-instructions（最多 64KB）本身就是一万多 token。
 * 窗口小于它时，光是「把提示词塞进去」就已经占满窗口，留给输出的预算归零，
 * 每轮都报「已达输出 token 上限」，点「继续」只会更糟（提示词又长一截）。
 */
export const MIN_AGENT_CONTEXT = 16384;

/** 界面上可选的上下文长度档位（低于 MIN_AGENT_CONTEXT 的档位不给选） */
export const CONTEXT_OPTIONS = [16384, 32768, 65536];

/**
 * 每次请求为「输出」预留的 token（= dsh provider 配置里的 maxTokens）。
 *
 * dsh 的自动压缩按 contextWindow − maxTokens 算「消息预算」，再减去 headroom 才是
 * 可用的压力预算；预算 ≤ 0 时压缩会被静默禁用（TargetPressureConfigError）。
 * 所以 maxTokens 不能写死：8K 窗口配 8K 输出 = 消息预算 0，压缩直接失效。
 */
export function completionReserve(contextWindow) {
  const cw = Number(contextWindow) || MIN_AGENT_CONTEXT;
  return Math.max(1024, Math.min(8192, Math.round(cw * 0.25)));
}

/** 自动压缩要预留的余量（= dsh compaction-basic 的 headroomTokens），同样按窗口缩放 */
export function compactionHeadroom(contextWindow) {
  const cw = Number(contextWindow) || MIN_AGENT_CONTEXT;
  return Math.max(512, Math.min(8192, Math.round(cw * 0.125)));
}

/** 按显存过滤出能跑的模型；没有独显时只给最小的那几个 */
export function modelsForVram(vramGB) {
  const limit = vramGB > 0 ? vramGB : 4;
  const fits = MODEL_CHOICES.filter((m) => m.needGB <= limit);
  return fits.length ? fits : [MODEL_CHOICES[MODEL_CHOICES.length - 1]];
}

/** 推荐：显存跑得动的最大模型（列表已按体积降序） */
export function recommendModel(vramGB) {
  return modelsForVram(vramGB)[0];
}

/**
 * 上下文长度：按「显存 − 模型体积」的余量决定。
 *
 * 这里算的是「模型权重 + KV cache」能不能全塞进显存。部署包默认开了
 * OLLAMA_FLASH_ATTENTION=1 与 OLLAMA_KV_CACHE_TYPE=q8_0（KV cache 量化到 8bit），
 * 所以余量够大时上到 64K 是实测可行的（RTX 4090 + 27B Q4_K_M：64K 全驻显存占 22.7G/24.5G）。
 * 再往上（128K）会有一部分被 offload 到内存，速度掉得厉害，所以封顶 64K。
 */
export function pickContextWindow(vramGB, modelGB) {
  const spare = (vramGB || 0) - (modelGB || 0);
  let cw;
  if (spare >= 7) cw = 65536;
  else if (spare >= 5) cw = 32768;
  else if (spare >= 3.5) cw = 16384;
  else if (spare >= 1.5) cw = 8192;
  else cw = 4096;
  // 显存再紧也不能低于 agent 的可用下限，否则工作台一开口就是「已达输出 token 上限」
  return Math.max(MIN_AGENT_CONTEXT, cw);
}

export function modelInfo(tag) {
  return MODEL_CHOICES.find((m) => m.tag === tag) || null;
}

/**
 * 粗估某个上下文长度下的显存占用（GB）。
 *
 * 锚点：实测 RTX 4090 + 27B Q4_K_M（16.8GB 权重）+ q8_0 KV，
 * 64K 上下文全量驻留共占约 22.7GB → KV 约 5.9GB → 约 0.092 GB / 1K token。
 * 按参数量线性缩放。**只用来给用户一个数量级的概念**，不是精确值 ——
 * 真实占用还跟层数、KV head 数、是否混合注意力有关。
 */
export function estimateVramGB(tag, contextWindow) {
  const m = modelInfo(tag);
  if (!m) return null;
  const kvPer1k = 0.092 * ((m.params || 8) / 27);
  return m.gb + kvPer1k * ((contextWindow || 8192) / 1000);
}

/** 给定显存，判断某个上下文档位会不会超 */
export function contextFit(tag, contextWindow, vramGB) {
  const need = estimateVramGB(tag, contextWindow);
  if (need == null || !vramGB) return { need, level: 'unknown' };
  const ratio = need / vramGB;
  if (ratio <= 0.85) return { need, level: 'ok' };
  if (ratio <= 1.0) return { need, level: 'tight' };
  return { need, level: 'over' };
}
