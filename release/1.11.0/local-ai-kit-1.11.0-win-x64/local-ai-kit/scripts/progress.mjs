/**
 * 启动进度模型（纯函数，不碰任何 IO）。
 *
 * 为什么不用「定时器假装进度」：
 *   前端自己跑的假进度一定会在模型没加载完时冲到 99% 然后卡住，用户以为卡死，
 *   于是反复点「启动工作台」—— 那正是要修的问题。这里的进度只由三个真实信号驱动：
 *     1. 引擎健康检查是否通过（权威信号，一票定音）
 *     2. dsh 端口是否已在监听（收尾信号）
 *     3. 引擎日志里已经出现的启动里程碑（load 权重 / 填专家缓存 / ready）
 *   时间只用来在「当前阶段内部」做插值，并且永远只能走到下一阶段的门口（-15%），
 *   阶段本身不会因为等得久而自己前进。
 *
 * 另外两条硬约束：
 *   - 单调不减：服务端会把每次算出的值取 max，进度条只会往前走，不会回弹。
 *   - 没有真正就绪就绝不到 100：上限卡在 99，100 只在 engine && dsh 都在线时给出。
 */

/** 启动阶段的百分比区间与实际耗时预期（秒），按这台机器的实测值标定 */
export const STARTUP_STEPS = [
  { id: 'submit', from: 0, to: 4, label: '已提交启动', expect: 1 },
  { id: 'probe', from: 4, to: 8, label: '检查现有服务', expect: 2 },
  { id: 'spawn', from: 8, to: 16, label: '引擎进程启动', expect: 3 },
  { id: 'weights', from: 16, to: 38, label: '读取模型权重', expect: 14 },
  { id: 'experts', from: 38, to: 76, label: '填充显存专家缓存', expect: 26 },
  { id: 'serving', from: 76, to: 90, label: '模型就绪检查', expect: 4 },
  { id: 'dsh', from: 90, to: 98, label: '启动工作台界面', expect: 9 },
];

/**
 * Ollama 这条启动路径的阶段。
 *
 * 和 Strata 最大的不同：Ollama 的服务通常已经在托盘里跑着，慢的是「把 27B 读进显存」
 * 这一步；而且它要先等 Strata 让出显存，所以单独排一段 vram 阶段。
 */
export const OLLAMA_STEPS = [
  { id: 'submit', from: 0, to: 4, label: '已提交启动', expect: 1 },
  { id: 'vram', from: 4, to: 14, label: '让出显存', expect: 6 },
  { id: 'ollama', from: 14, to: 32, label: '启动 Ollama 服务', expect: 8 },
  { id: 'load', from: 32, to: 84, label: '加载模型到显存', expect: 55 },
  { id: 'dsh', from: 84, to: 98, label: '启动工作台界面', expect: 9 },
];

/** 引擎启动日志里的里程碑。顺序有意义：后面的出现意味着前面的都已经过 */
const MARKERS = [
  ['weights', /reading the model's weights|loading the model/i],
  ['experts', /loading the most-used experts|filling the GPU's expert cache/i],
  ['almostReady', /almost ready|still starting/i],
  ['ready', /ready: http:\/\//i],
];

/**
 * 从引擎日志尾部识别已经走过的里程碑。
 *
 * 只认这些稳定的句子，不去猜别的输出：日志格式变了，最坏结果只是退回按时间插值，
 * 而不是给出错误的阶段名。
 */
export function parseStartupMarkers(logText) {
  const text = String(logText || '');
  const found = { weights: false, experts: false, almostReady: false, ready: false };
  for (const [id, re] of MARKERS) {
    if (!re.test(text)) continue;
    found[id] = true;
    // 更靠后的里程碑出现时，把它前面的都补上
    for (const [other] of MARKERS) {
      found[other] = true;
      if (other === id) break;
    }
  }
  if (found.almostReady || found.ready) found.experts = true;
  if (found.experts) found.weights = true;
  return found;
}

function stepOf(steps, id) {
  return steps.find((s) => s.id === id) || steps[0];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 阶段内插值 —— 两条启动路径共用。
 *
 * 只负责「在当前阶段里按时间往前走」，最多到该区间的 85%：留在下一阶段门口等真信号，
 * 绝不自己推门。percent 还受 lastPercent 约束，保证只进不退。
 */
function stepProgress(steps, stepId, elapsedS, lastPercent) {
  const step = stepOf(steps, stepId);
  const index = steps.indexOf(step);
  const beforeS = steps.slice(0, index).reduce((sum, s) => sum + s.expect, 0);
  const phaseElapsedS = Math.max(0, elapsedS - beforeS);
  const ratio = clamp(phaseElapsedS / Math.max(step.expect, 0.5), 0, 0.85);
  const percent = clamp(Math.round(Math.max(step.from + (step.to - step.from) * ratio, lastPercent)), 0, 99);
  const remainingS = steps.slice(index).reduce((sum, s) => sum + s.expect, 0) - phaseElapsedS;
  return {
    step,
    percent,
    // 没完成就至少留 1 秒：显示「预计剩余 0s」却还停在 88% 最容易被当成卡死
    etaSeconds: Math.max(1, Math.round(remainingS)),
  };
}

function readyResult(elapsedMs) {
  return {
    percent: 100,
    step: 'ready',
    title: '工作台已就绪',
    phase: '工作台已就绪',
    detail: `用时 ${(elapsedMs / 1000).toFixed(1)} 秒`,
    elapsedMs,
    etaSeconds: 0,
    done: true,
    failed: false,
  };
}

function failedResult(elapsedMs, percent, error) {
  return {
    percent,
    step: 'failed',
    title: '启动失败',
    phase: '启动失败',
    detail: String(error),
    elapsedMs,
    etaSeconds: 0,
    done: false,
    failed: true,
  };
}

/**
 * 算出此刻的启动进度。
 *
 * backend 决定走哪张阶段表：strata（引擎日志里程碑）或 ollama（服务 + 显存里有没有模型）。
 * 其余参数两边通用。
 *
 * @param {object} input
 * @param {'strata'|'ollama'} [input.backend]     走哪条启动路径
 * @param {number} input.startedAt                本次启动的起点（毫秒时间戳）
 * @param {number} [input.now]                    当前时间，默认 Date.now()，测试可注入
 * @param {boolean} [input.engineOnline]          Strata 引擎 /health 是否通过
 * @param {boolean} [input.ollamaOnline]          Ollama 服务是否在线
 * @param {boolean} [input.modelLoaded]           Ollama 是否已把模型加载进显存
 * @param {boolean} [input.dshOnline]             工作台界面端口是否在监听
 * @param {object} [input.markers]                parseStartupMarkers 的结果（仅 strata）
 * @param {string|null} [input.error]             启动失败原因
 * @param {number} [input.lastPercent]            上一次返回的百分比，用来保证单调不减
 */
export function computeStartupProgress({
  backend = 'strata',
  startedAt,
  now = Date.now(),
  engineOnline = false,
  ollamaOnline = false,
  modelLoaded = false,
  dshOnline = false,
  markers = {},
  error = null,
  lastPercent = 0,
} = {}) {
  const elapsedMs = startedAt ? Math.max(0, now - startedAt) : 0;
  const elapsedS = elapsedMs / 1000;

  if (backend === 'ollama') {
    // 服务在、模型进了显存、界面也起来了 —— 三个都齐才算就绪
    if (ollamaOnline && modelLoaded && dshOnline) return readyResult(elapsedMs);

    let stepId = 'submit';
    if (ollamaOnline && modelLoaded) stepId = 'dsh';
    else if (ollamaOnline) stepId = 'load';
    else if (engineOnline) stepId = 'vram';       // Strata 还占着显存，正在让它退场
    else if (elapsedS > 1.2) stepId = 'ollama';

    const { step, percent, etaSeconds } = stepProgress(OLLAMA_STEPS, stepId, elapsedS, lastPercent);
    if (error) {
      return failedResult(elapsedMs, clamp(Math.round(Math.max(lastPercent, step.from)), 0, 99), error);
    }
    return {
      percent, step: step.id, title: '正在启动 Ollama 工作台', phase: step.label,
      detail: ollamaNote(step.id), elapsedMs, etaSeconds, done: false, failed: false,
    };
  }

  // ---- Strata ----
  // 两个服务都在线：唯一的完成状态，别的路径都不许给 100
  if (engineOnline && dshOnline) return readyResult(elapsedMs);

  let stepId = 'submit';
  if (engineOnline) stepId = 'dsh';
  else if (markers.ready || markers.almostReady) stepId = 'serving';
  else if (markers.experts) stepId = 'experts';
  else if (markers.weights) stepId = 'weights';
  else if (elapsedS > 1.5) stepId = 'spawn';

  const { step, percent, etaSeconds } = stepProgress(STARTUP_STEPS, stepId, elapsedS, lastPercent);
  if (error) {
    return failedResult(elapsedMs, clamp(Math.round(Math.max(lastPercent, step.from)), 0, 99), error);
  }
  return {
    percent, step: step.id, title: '正在启动工作台', phase: step.label,
    detail: phaseNote(step.id), elapsedMs, etaSeconds, done: false, failed: false,
  };
}

function ollamaNote(id) {
  switch (id) {
    case 'submit': return '正在下发给服务控制器';
    case 'vram': return '先让 Strata 退场，把显存腾出来';
    case 'ollama': return 'Ollama 服务还没起来，正在启动';
    case 'load': return '把模型权重读进显存，这一步最慢';
    case 'dsh': return '模型已就位，正在打开工作台界面';
    default: return '';
  }
}

function phaseNote(id) {
  switch (id) {
    case 'submit': return '正在下发给服务控制器';
    case 'probe': return '先看服务是不是已经在跑';
    case 'spawn': return '拉起引擎进程';
    case 'weights': return '把模型权重读进内存，这一步最慢';
    case 'experts': return '把常用专家搬进显存，完成后就不再慢';
    case 'serving': return '引擎马上就能接请求了';
    case 'dsh': return '引擎已就绪，正在打开工作台界面';
    default: return '';
  }
}
