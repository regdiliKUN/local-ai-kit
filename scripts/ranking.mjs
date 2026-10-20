/**
 * 模型质量本地实测排行。
 *
 * 「qwen3:8b 和 qwen2.5:14b 哪个好」是个没有标准答案的问题 ——
 * 官网的跑分是别人的机器、别人的问题。
 * 唯一靠得住的办法是**在你自己的机器上、用同一套题实测**。
 *
 * 这里做的是：把体检用的那 21 道题，挨个模型跑一遍，按通过率排名。
 *
 * 注意：
 *   - 一次要跑好几分钟，中途可以随时停
 *   - 每个模型都要先加载进显存，慢是正常的
 *   - 排���只说明「在这 21 道题上谁更强」，不是全面的胜负
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.dirname(HERE);

/** 每次最多测几个模型（太多要跑太久） */
const MAX_MODELS = 8;

/**
 * 跑一遍排行。
 *
 * @param {object} opts
 * @param {string[]} opts.models   要测的模型
 * @param {function} opts.onProgress 进度回调
 * @param {function} opts.shouldStop  返回 true 就停
 */
export async function runRanking({ models = [], onProgress = () => {}, shouldStop = () => false } = {}) {
  const script = path.join(KIT, 'healthcheck', 'quick.mjs');
  if (!fs.existsSync(script)) {
    throw new Error('找不到体检脚本 healthcheck/quick.mjs');
  }
  const list = models.slice(0, MAX_MODELS);
  const results = [];

  for (let i = 0; i < list.length; i++) {
    if (shouldStop()) break;
    const model = list[i];
    onProgress({ phase: 'model', model, index: i, total: list.length, percent: Math.round((i / list.length) * 100) });

    const r = await runOne(script, model);
    results.push(r);
    onProgress({
      phase: 'model-done', model, index: i, total: list.length,
      percent: Math.round(((i + 1) / list.length) * 100), result: r,
    });
  }

  results.sort((a, b) => (b.passed || 0) - (a.passed || 0) || (b.rate || 0) - (a.rate || 0));
  results.forEach((r, i) => { r.rank = i + 1; });
  onProgress({ phase: 'done', percent: 100, results });
  return { results, at: Date.now() };
}

/** 跑一个模型的 21 道题 */
function runOne(script, model) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, '--json', '--quick'], {
      cwd: KIT,
      env: {
        ...process.env,
        LOCAL_AI_MODEL: model,
        LOCAL_AI_BASE_URL: 'http://127.0.0.1:11434/v1',
      },
      windowsHide: true,
    });
    let buf = '';
    let summary = null;
    let failed = null;

    const onLine = (line) => {
      const t = line.trim();
      if (!t) return;
      let ev;
      try { ev = JSON.parse(t); } catch { return; }
      if (ev.type === 'done') summary = ev.summary;
      else if (ev.type === 'error') failed = ev.text || '体检失败';
    };

    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      const parts = buf.split(/\r?\n/);
      buf = parts.pop() || '';
      for (const p of parts) onLine(p);
    });
    child.on('error', (e) => resolve({ model, error: String(e.message || e), passed: 0, total: 0, rate: 0 }));
    child.on('close', (code) => {
      if (buf.trim()) onLine(buf);
      if (!summary) {
        resolve({ model, error: failed || `体检进程退出（code=${code}）`, passed: 0, total: 0, rate: 0 });
        return;
      }
      resolve({
        model: summary.model || model,
        passed: summary.eval ? summary.eval.passed : 0,
        total: summary.eval ? summary.eval.total : 0,
        rate: summary.eval ? summary.eval.rate : 0,
        share: summary.stability ? summary.stability.share : null,
        ok: (summary.verdicts || []).every((v) => v.ok),
        elapsed: summary.elapsed_s || null,
        verdicts: summary.verdicts || [],
        fails: summary.eval ? summary.eval.fails : [],
      });
    });
  });
}

/**
 * 给结果加一句人话建议。
 */
export function rankingAdvice(results) {
  if (!results || results.length < 2) return [];
  const ok = results.filter((r) => !r.error);
  if (!ok.length) return ['没有一个模型跑成功 —— 先去「修复中心」看看 Ollama 是不是有问题。'];
  const out = [];
  const best = ok[0];
  const last = ok[ok.length - 1];
  out.push(`在这 21 道题上，${best.model} 最强（${best.passed}/${best.total}）。`);
  if (best.passed === best.total) {
    out.push('它是满分 —— 别的模型在这套题上没能全对。');
  } else {
    out.push(`不过它也不是全对（${best.total - best.passed} 题没过），这套题偏简单或偏难都不好说。`);
  }
  if (last.model !== best.model) {
    out.push(`${last.model} 排最后（${last.passed}/${last.total}），如果它占着显存却不用，换成 ${best.model} 更划算。`);
  }
  const big = ok.find((r) => r.passed <= best.passed - 3);
  if (big) {
    out.push(`${big.model} 差了 ${best.passed - big.passed} 题，但体积可能小很多 —— 速度优先的话它也许更合适。`);
  }
  out.push('提醒：这只是这 21 道题的结果，不代表全面能力；代码、数学、长上下文还得自己试。');
  return out;
}
