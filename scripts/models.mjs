/**
 * 可选模型表。
 *
 * gb     = 实测下载体积（来自 Ollama registry，单位 GB）
 * needGB = 运行所需显存（含 KV cache 与开销余量）
 * 按体积从大到小排列，推荐逻辑取「显存跑得动的第一个」。
 */

export const MODEL_CHOICES = [
  {
    tag: 'qwen3.8:27b',
    name: 'Qwen3.8 27B',
    gb: 16.8,
    needGB: 21,
    note: '质量最强，长任务与工具调用最好',
    tags: ['推荐', '工具调用'],
  },
  {
    tag: 'qwen3.6:27b',
    name: 'Qwen3.6 27B',
    gb: 16.8,
    needGB: 21,
    note: 'agentic 编码方向强化',
    tags: ['工具调用'],
  },
  {
    tag: 'qwen3:14b',
    name: 'Qwen3 14B',
    gb: 9.3,
    needGB: 13,
    note: '推理能力较强',
    tags: ['工具调用'],
  },
  {
    tag: 'qwen2.5:14b',
    name: 'Qwen2.5 14B',
    gb: 9.0,
    needGB: 13,
    note: '成熟稳定，工具调用可靠',
    tags: ['工具调用'],
  },
  {
    tag: 'qwen3:8b',
    name: 'Qwen3 8B',
    gb: 5.2,
    needGB: 8,
    note: '8GB 显存即可运行',
    tags: ['工具调用'],
  },
  {
    tag: 'qwen2.5:7b',
    name: 'Qwen2.5 7B',
    gb: 4.7,
    needGB: 7,
    note: '轻量通用',
    tags: ['工具调用'],
  },
  {
    tag: 'qwen2.5:3b',
    name: 'Qwen2.5 3B',
    gb: 1.9,
    needGB: 4,
    note: '小显存 / 纯 CPU 兜底',
    tags: [],
  },
  {
    tag: 'llama3.2:3b',
    name: 'Llama 3.2 3B',
    gb: 2.0,
    needGB: 4,
    note: '体积很小',
    tags: [],
  },
];

export const DEFAULT_MODEL = MODEL_CHOICES[0].tag;

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

/** 上下文长度：按「显存 − 模型体积」的余量决定 */
export function pickContextWindow(vramGB, modelGB) {
  const spare = (vramGB || 0) - (modelGB || 0);
  if (spare >= 7) return 32768;
  if (spare >= 3.5) return 16384;
  if (spare >= 1.5) return 8192;
  return 4096;
}

export function modelInfo(tag) {
  return MODEL_CHOICES.find((m) => m.tag === tag) || null;
}
