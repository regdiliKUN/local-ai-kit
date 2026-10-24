/**
 * 诊断报告。
 *
 * 用户报问题时最费劲的就是「你把信息发给我」—— 要日志、要截图、要版本号。
 * 这里把该有的都打包成一个文件：用户点一下「下载诊断报告」，
 * 把那个文件发给对方就行。
 *
 * 报告里**不含任何用户内容**：只有环境、配置、路径和日志。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig } from './config.mjs';
import { KIT_VERSION } from './install.mjs';
import { readStore, storeDir } from './store.mjs';

/** 敏感信息：路径里的用户名、令牌之类，不该进报告 */
function scrub(text) {
  return String(text || '')
    .replace(/(token|password|secret|api[_-]?key|authorization)["'\s:=]+[^\s"',}]+/gi, '$1: ***')
    .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/g, (m) => m.replace(/\\Users\\[^\\]+/, '\\Users\\***'))
    .replace(/\/home\/[^\/\s"']+/g, '/home/***')
    .replace(/\/Users\/[^\/\s"']+/g, '/Users/***');
}

function section(title, body) {
  return `\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}\n${body || '（空）'}\n`;
}

/**
 * Strata 部署的诊断报告。
 *
 * Strata 用的是自己的引擎，不是 Ollama，所以体检项不一样：
 * 这里关心的是「三个服务在不在、端口通不通、日志里有没有报错」。
 */
export async function strataReport(ctx = {}) {
  const cfg = ctx.cfg || {};
  let state = null;
  try {
    const { strataState } = await import('./strata.mjs');
    state = await strataState(cfg);
  } catch { /* 拿不到就只报配置 */ }

  let out = '';
  out += section('本地 AI 控制台 · 诊断报告（Strata 部署）', [
    `生成时间：${new Date().toLocaleString()}`,
    `工具版本：v${KIT_VERSION}`,
    `Node.js  ：v${process.versions.node}（${process.execPath}）`,
    `系统    ：${os.platform()} ${os.release()} ${os.arch()}`,
  ].join('\n'));

  out += section('硬件', [
    `CPU     ：${(os.cpus()[0] || {}).model || '未知'} · ${os.cpus().length} 核`,
    `内存    ：${Math.round((os.totalmem() / 1073741824) * 10) / 10} GB 总 / ${Math.round((os.freemem() / 1073741824) * 10) / 10} GB 空闲`,
  ].join('\n'));

  out += section('配置', Object.entries(cfg)
    .map(([k, v]) => `${k.padEnd(16)} = ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('\n') || '（没有配置）');

  if (state) {
    out += section('服务状态', [
      `引擎 :${state.ports.engine}   ${state.engine.online ? '运行中' : `未就绪${state.engine.startupError ? ` —— ${state.engine.startupError}` : ''}`}`,
      `WebUI :${state.ports.webui}  ${state.webui.online ? '运行中' : '未就绪'}`,
      `dsh  :${state.ports.dsh}    ${state.dsh.online ? '运行中' : '未就绪'}`,
      `部署根：${state.deploymentRoot}`,
      `模型目录：${state.modelDir || '（未配置）'}`,
    ].join('\n'));
  }

  out += section('日志（最后 300 行）', (ctx.logText || '（没有日志）').split(/\r?\n/).slice(-300).join('\n'));
  out += section('隐私说明', '本报告已自动去掉用户名与令牌类信息。');

  return scrub(out);
}
/**
 * 生成一份纯文本报告。
 *
 * @param {object} ctx { root, cfg, metrics, diagnose, health, bench, logText }
 */
export function buildReport(ctx = {}) {
  const cfg = ctx.cfg || loadConfig(ctx.root) || {};
  const m = ctx.metrics || {};
  const cpu = m.cpu || {};
  const mem = m.memory || {};
  const gpu = (m.gpu || [])[0] || {};

  let out = '';
  out += section('本地 AI 控制台 · 诊断报告', [
    `生成时间：${new Date().toLocaleString()}`,
    `工具版本：v${KIT_VERSION}`,
    `Node.js  ：v${process.versions.node}（${process.execPath}）`,
    `系统    ：${os.platform()} ${os.release()} ${os.arch()}`,
  ].join('\n'));

  out += section('硬件', [
    `CPU     ：${cpu.model || '未知'} · ${cpu.cores || 0} 核`,
    `内存    ：${mem.totalGB || '?'} GB 总 / ${mem.freeGB || '?'} GB 空闲`,
    `显卡    ：${gpu.name || '（未检测到独立显卡）'}`,
    gpu.driver ? `驱动    ：${gpu.driver}` : '',
    gpu.memoryTotalMB ? `显存    ：${gpu.memoryTotalMB} MB` : '',
    `磁盘    ：${m.disk ? `${m.disk.path} 总 ${m.disk.totalGB} GB / 剩 ${m.disk.freeGB} GB` : '未知'}`,
  ].filter(Boolean).join('\n'));

  out += section('配置', Object.entries(cfg)
    .map(([k, v]) => `${k.padEnd(16)} = ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('\n') || '（没有配置）');

  if (ctx.diagnose && ctx.diagnose.checks) {
    out += section('体检结果', ctx.diagnose.checks
      .map((c) => `[${c.level.toUpperCase().padEnd(5)}] ${c.label} —— ${c.detail}`)
      .join('\n'));
  }

  if (ctx.health) {
    out += section('最近一次模型体检', [
      `模型    ：${ctx.health.model || '未知'}`,
      `通过    ：${ctx.health.eval ? `${ctx.health.eval.passed}/${ctx.health.eval.total}` : '未知'}`,
      `判据    ：${(ctx.health.verdicts || []).map((v) => `${v.ok ? 'PASS' : 'FAIL'} ${v.name}（${v.detail}）`).join('；')}`,
    ].join('\n'));
  }

  if (ctx.bench && ctx.bench.verdict) {
    out += section('最近一次测速', [
      `模型    ：${ctx.bench.model}`,
      `生成速度：${ctx.bench.verdict.genTokensPerSec} tokens/s`,
      `读提示词：${ctx.bench.verdict.promptTokensPerSec} tokens/s`,
      `结论    ：${(ctx.bench.verdict.advice || []).join(' ')}`,
    ].join('\n'));
  }

  out += section('日志（最后 300 行）', (ctx.logText || '（没有日志）').split(/\r?\n/).slice(-300).join('\n'));
  out += section('隐私说明', '本报告已自动去掉用户名与令牌类信息。');

  return scrub(out);
}

/**
 * 综合评测报告（JSON）。
 *
 * 把「测速历史 + 体检历史 + 模型实测排行」汇总成一个 JSON 文件，方便：
 *   - 跨机器对比（同一套题、同一套指标，比官网跑分有说服力）
 *   - 发给别人 / 存档 / 二次画图
 *
 * 只读 store.json，不碰任何用户对话或日志。
 */
export function buildAggregateReport(ctx = {}) {
  const store = ctx.store || readStore();
  const bench = Array.isArray(store.bench) ? store.bench : [];
  const health = Array.isArray(store.health) ? store.health : [];
  const ranking = Array.isArray(store.ranking) ? store.ranking : [];

  const genOf = (b) => Number(b.gen || (b.verdict && b.verdict.genTokensPerSec) || 0);
  const bestGen = bench.length ? Math.max(...bench.map(genOf)) : null;
  const lastHealth = health.length ? health[health.length - 1] : null;
  const lastHealthRate = lastHealth
    ? (lastHealth.rate != null ? lastHealth.rate
      : (lastHealth.eval ? lastHealth.eval.passed / Math.max(1, lastHealth.eval.total) : null))
    : null;

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      kitVersion: KIT_VERSION,
      node: process.versions.node,
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    },
    summary: {
      benchRuns: bench.length,
      healthRuns: health.length,
      rankingSnapshots: ranking.length,
      bestGenTokensPerSec: bestGen == null ? null : Math.round(bestGen * 10) / 10,
      lastHealthPassRate: lastHealthRate == null ? null : Math.round(lastHealthRate * 1000) / 1000,
    },
    bench,
    health,
    ranking,
  };
}

// 作为脚本直接运行：把综合评测报告写到文件（默认写在 store 旁边）
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const out = buildAggregateReport();
  const file = process.argv.slice(2).find((a) => !a.startsWith('-'))
    || path.join(storeDir(), `eval-report-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');
  console.log(`已生成综合评测报告：${file}`);
  console.log(`  测速 ${out.summary.benchRuns} 次 · 体检 ${out.summary.healthRuns} 次 · 排行快照 ${out.summary.rankingSnapshots} 份`);
}
