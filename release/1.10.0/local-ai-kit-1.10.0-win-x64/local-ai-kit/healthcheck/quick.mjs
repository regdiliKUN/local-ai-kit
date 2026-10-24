#!/usr/bin/env node
/**
 * quick.mjs —— 模型体检（Node 版，零依赖）
 *
 * 为什么要有这个文件：
 *   本部署包承诺「只要 Node，双击就能用」，安装器会自动装 Node，
 *   但**不会装 Python**。而 healthcheck/ 下的 Python 版本需要 3.10+，
 *   普通用户走完一键安装后很可能根本没有 python 命令
 *   （Windows 自带的还是"跳转微软商店"的假别名）。
 *   所以面向终端用户的体检必须用 Node 跑。
 *
 *   Python 版本（run_all.py / flip_probe.py）保留给开发者：
 *   功能更全（阶梯曲线、SVG、稳定性、拐点），但要自己装 Python。
 *
 * 用法：
 *   node healthcheck/quick.mjs              # 完整体检
 *   node healthcheck/quick.mjs --quick      # 只跑 8K/16K
 *   node healthcheck/quick.mjs --json       # 机器可读（控制台用这个）
 *   node healthcheck/quick.mjs --selftest   # 不连模型，只验判分器
 *
 * 退出码：0 达标 / 2 有不达标 / 1 环境问题
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.LOCAL_AI_BASE_URL || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1';
const MODEL = process.env.LOCAL_AI_MODEL || 'qwen3.8:27b';
const API_KEY = process.env.LOCAL_AI_API_KEY || 'ollama';

const SEED = 42;
const MAX_TOKENS = 512;
const THRESH_EVAL = 0.9;
const THRESH_STABILITY = 0.8;
const JSON_MODE = process.argv.includes('--json');

/** 控制台里以 JSON 行输出，避免刷屏 */
function emit(obj) {
  if (JSON_MODE) process.stdout.write(JSON.stringify(obj) + '\n');
  else if (obj.text) console.log(obj.text);
}

const log = (s = '') => emit({ type: 'log', text: s });

/* ------------------------------------------------------------------ 判分 */

function stripFence(text) {
  const m = String(text || '').match(/```[a-zA-Z0-9_+-]*\n([\s\S]*?)```/);
  return (m ? m[1] : String(text || '')).trim();
}

const norm = (t) => stripFence(t).replace(/\s+/g, '').trim();

/** golden.jsonl 用的是 Python 正则（支持 (?i)/(?m) 内联标志），
 *  JS 没有这种写法，这里翻译成 flags。 */
function jsRegex(pattern) {
  let p = String(pattern);
  let flags = 's';
  const m = p.match(/^\(\?([ims]+)\)/);
  if (m) { flags += m[1]; p = p.slice(m[0].length); }
  return new RegExp(p, [...new Set(flags)].join(''));
}

export function check(kind, value, text) {
  const raw = String(text || '');
  if (kind === 'exact') {
    const got = norm(raw);
    return { ok: got === String(value) || got.replace(/[。.]$/, '') === String(value), why: `got=${got.slice(0, 30)}` };
  }
  if (kind === 'contains') return { ok: raw.includes(String(value)), why: `need=${value}` };
  if (kind === 'regex') {
    try { return { ok: jsRegex(value).test(raw), why: 'pattern' }; }
    catch { return { ok: false, why: 'bad regex' }; }
  }
  if (kind === 'json_keys' || kind === 'json_array') {
    let body = stripFence(raw);
    for (const [o, c] of [['{', '}'], ['[', ']']]) {
      const i = body.indexOf(o), j = body.lastIndexOf(c);
      if (i >= 0 && j > i) { body = body.slice(i, j + 1); break; }
    }
    let obj;
    try { obj = JSON.parse(body); } catch (e) { return { ok: false, why: 'json 解析失败' }; }
    if (kind === 'json_keys') {
      if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return { ok: false, why: '不是对象' };
      const miss = value.filter((k) => !(k in obj));
      return { ok: miss.length === 0, why: miss.length ? `缺 ${miss}` : 'ok' };
    }
    if (!Array.isArray(obj)) return { ok: false, why: '不是数组' };
    return { ok: obj.length === Number(value), why: `len=${obj.length}` };
  }
  return { ok: false, why: '未知类型' };
}

/* ------------------------------------------------------------------ 请求 */

async function chat(messages, { temperature = 0, seed = SEED } = {}) {
  const body = {
    model: MODEL, messages, temperature, seed,
    max_tokens: MAX_TOKENS, stream: false,
    chat_template_kwargs: { enable_thinking: false },
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${BASE.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(900_000),
    });
    if (res.status === 400 || res.status === 422) {
      // 有的服务端不认 chat_template_kwargs：去掉再试一次
      if (body.chat_template_kwargs) { delete body.chat_template_kwargs; continue; }
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    return { text: (j.choices?.[0]?.message?.content) || '', usage: j.usage || {} };
  }
  throw new Error('服务端拒绝了请求');
}

async function up() {
  try {
    const r = await fetch(`${BASE.replace(/\/$/, '')}/models`,
      { headers: { Authorization: `Bearer ${API_KEY}` }, signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch { return false; }
}

/**
 * 模型实际能吃多长上下文。
 *
 * 不能直接用安装时配的 contextWindow：用户可能之后换了模型、
 * 或 Ollama 用了不同的 num_ctx。窗口小于阶梯上限时，
 * 超出的那档会被**静默截断**，测出来的"零漂移"是假的。
 *
 * 顺序：配置.json → Ollama /api/ps → 未知（0）
 */
async function effectiveContext() {
  try {
    const cfgPath = path.join(HERE, '..', '配置.json');
    const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (c && c.contextWindow) return Number(c.contextWindow);
  } catch { /* 没有配置就往下问 Ollama */ }
  try {
    const root = BASE.replace(/\/v1\/?$/, '');
    const r = await fetch(`${root}/api/ps`, { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    const list = j.models || [];
    const m = list.find((x) => x.name === MODEL) || list[0];
    if (m && m.context_length) return Number(m.context_length);
  } catch { /* 不是 Ollama 或没加载 */ }
  return 0;
}

/* ------------------------------------------------------------------ 题库 */

function loadGolden() {
  const p = path.join(HERE, 'golden.jsonl');
  return fs.readFileSync(p, 'utf8').split(/\r?\n/)
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => JSON.parse(l));
}

/* ------------------------------------------------------------------ 语料 */

const WORDS = ['机架', '冷却', '光纤', '调度', '缓存', '索引', '分片', '副本', '心跳', '租约',
  '灰度', '回滚', '探针', '阈值', '告警', '熔断', '限流', '编排', '镜像', '内核'];

function filler(chars) {
  let out = '', i = 0;
  while (out.length < chars) {
    i++;
    const a = WORDS[(i * 7) % WORDS.length];
    const b = WORDS[(i * 13) % WORDS.length];
    out += `第 ${String(i).padStart(4, '0')} 条：${a}/${b} 在灰度阶段需要校验一致性与可回滚性。\n`;
  }
  return out;
}

const COUNT_TASK = '请从 1 开始逐行输出整数，每行一个，一直输出到 200。不要输出任何其它内容。';

function countMessages(targetTokens) {
  const chars = Math.max(0, Math.floor(targetTokens * 1.6) - COUNT_TASK.length - 64);
  return [
    { role: 'system', content: '你是一个严格遵循指令的助手，只输出被要求的内容。' },
    { role: 'user', content: `下面是一份无关的日志清单，请忽略它的内容，只回答最后的问题。\n\n${filler(chars)}\n\n=== 问题 ===\n${COUNT_TASK}` },
  ];
}

/* ------------------------------------------------------------------ 指标 */

/**
 * 首个分歧位置。
 *   >= 0 : 真的在某一位不同
 *   -1   : 完全相同
 *   -2   : 一方是另一方的前缀（逐字一致，只是长度不同）
 *
 * 原来的实现把 -2 的情况返回成"较短串的长度"，于是会出现
 * 「首分歧=451 但翻转率=0%」这种自相矛盾的输出 —— 长度不同不是分歧。
 */
export function firstDiv(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : -2;
}

/** 给人看的写法 */
function divLabel(d) {
  if (d === -1) return 'same';
  if (d === -2) return 'len≠';
  return String(d);
}

function flipRate(a, b, warm = 128) {
  const n = Math.min(a.length, b.length);
  if (n <= warm) return null;
  let m = 0;
  for (let i = warm; i < n; i++) if (a[i] !== b[i]) m++;
  return m / (n - warm);
}

/* ------------------------------------------------------------------ 自检 */

function selftest() {
  const cases = [
    ['exact', '391', '391', true],
    ['exact', '391', ' 391\n', true],
    ['exact', '391', '答案是 391', false],
    ['contains', '北京', '首都是北京', true],
    ['regex', '(?i)select\\s+\\*\\s+from', 'SELECT * FROM t', true],
    ['json_keys', ['a'], '{"a":1}', true],
    ['json_keys', ['a', 'b'], '{"a":1}', false],
    ['json_keys', ['name'], '```json\n{"name":"x"}\n```', true],
    ['json_array', 3, '["a","b","c"]', true],
    ['json_array', 3, '["a"]', false],
  ];
  let ok = true;
  for (const [k, v, t, want] of cases) {
    const got = check(k, v, t).ok;
    if (got !== want) { ok = false; log(`[FAIL] ${k} ${JSON.stringify(v)} → ${got}`); }
  }
  // 指标
  if (firstDiv('abc', 'abc') !== -1) { ok = false; log('[FAIL] firstDiv 相同'); }
  if (firstDiv('abc', 'abd') !== 2) { ok = false; log('[FAIL] firstDiv 差异'); }
  if (firstDiv('abc', 'abcdef') !== -2) { ok = false; log('[FAIL] firstDiv 前缀（应返回 -2 而不是 3）'); }
  if (flipRate('A'.repeat(400), 'A'.repeat(400)) !== 0) { ok = false; log('[FAIL] flipRate 相同'); }
  log(ok ? `[OK] 判分器 ${cases.length} 用例 + 指标检查全部通过` : '[FAIL] 自检未通过');
  return ok ? 0 : 1;
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  if (process.argv.includes('--selftest')) return selftest();

  if (!(await up())) {
    emit({ type: 'error', text: `连不上 ${BASE}，先确认服务已启动（桌面「启动本地AI」）` });
    return 1;
  }

  const quick = process.argv.includes('--quick');
  const eff = await effectiveContext();
  // 留出输出预算和模板开销，否则最后一档会被静默截断
  const limit = eff ? Math.max(2048, eff - MAX_TOKENS - 512) : 32768;
  const want = quick ? [8192, 16384] : [8192, 16384, 32768];
  let ctxs = want.filter((n) => n <= limit);
  if (ctxs.length < 2) {
    ctxs = [...new Set([Math.floor(limit * 0.4), limit])].filter((v) => v >= 1024);
  }
  if (eff) {
    log(`实际窗口 ${eff} tokens，阶梯上限 ${limit}` +
        (want.some((n) => n > limit) ? `（${want.filter((n) => n > limit).join('/')} 档超出，已跳过）` : ''));
  }
  const t0 = Date.now();

  /* --- 1. 质量基线 --- */
  log('【1/3】质量基线（21 题）');
  const items = loadGolden();
  const rows = [];
  for (const it of items) {
    let ok = false, why = '';
    try {
      const r = await chat([
        { role: 'system', content: '你是一个严格遵循指令的助手，只输出被要求的内容。' },
        { role: 'user', content: it.prompt },
      ]);
      ({ ok, why } = check(it.check.type, it.check.value, r.text));
    } catch (e) { why = `异常 ${e.message}`; }
    rows.push({ id: it.id, cat: it.cat, ok, why });
    emit({ type: 'item', id: it.id, cat: it.cat, ok });
  }
  const passed = rows.filter((r) => r.ok).length;
  const rate = passed / rows.length;
  const fails = rows.filter((r) => !r.ok).map((r) => r.id);
  log(`      通过 ${passed}/${rows.length} = ${(rate * 100).toFixed(0)}%${fails.length ? '，未过：' + fails.join(',') : ''}`);

  /* --- 2. 长上下文漂移 --- */
  log(`【2/3】长上下文漂移（${ctxs.join(' / ')}）`);
  const probes = [];
  for (const n of ctxs) {
    const t = Date.now();
    const r = await chat(countMessages(n));
    const sec = (Date.now() - t) / 1000;
    probes.push({ ctx: r.usage.prompt_tokens || n, text: r.text, sec });
    log(`      ctx≈${n} → 实际 ${probes.at(-1).ctx} tokens，${sec.toFixed(1)}s`);
  }
  const base = probes[0];
  const drift = probes.slice(1).map((p) => ({
    ctx: p.ctx,
    firstDiv: firstDiv(base.text, p.text),
    len: p.text.length,
    flip: flipRate(base.text, p.text),
    sec: p.sec,
  }));
  for (const d of drift) {
    const tag = d.firstDiv === -2 ? `len≠ ${base.text.length}/${d.len}` : divLabel(d.firstDiv);
    log(`      ${String(d.ctx).padStart(7)}  首分歧=${tag}  ` +
        `翻转=${d.flip === null ? 'n/a' : (d.flip * 100).toFixed(1) + '%'}  ${d.sec.toFixed(1)}s`);
  }
  const alarm = drift.find((d) => (d.flip || 0) > 0.05);

  /* --- 3. 稳定性 --- */
  log('【3/3】采样稳定性（3 次，temp 0.7）');
  const sigs = [];
  for (let i = 0; i < 3; i++) {
    const r = await chat(
      [{ role: 'system', content: '只输出被要求的内容。' },
       { role: 'user', content: '列出 1 到 5，每行一个数字。不要解释。' }],
      { temperature: 0.7, seed: SEED + i });
    sigs.push(r.text.trim().replace(/\s+/g, ' '));
    log(`      seed=${SEED + i}  ${JSON.stringify(sigs.at(-1).slice(0, 40))}`);
  }
  const uniq = [...new Set(sigs)];
  const share = sigs.filter((s) => s === sigs[0]).length / sigs.length;

  /* --- 判据 --- */
  const verdicts = [
    ['质量基线', rate >= THRESH_EVAL, `${passed}/${rows.length} = ${(rate * 100).toFixed(0)}%`],
    ['长上下文漂移', !alarm, alarm ? `ctx ${alarm.ctx} 翻转 ${(alarm.flip * 100).toFixed(1)}%` : '全程 <5%'],
    ['采样稳定性', share >= THRESH_STABILITY, `同一答案占比 ${(share * 100).toFixed(0)}%`],
  ];
  log('');
  log('判据：');
  for (const [n, ok, d] of verdicts) log(`  [${ok ? 'PASS' : 'FAIL'}] ${n}  ${d}`);

  const summary = {
    stamp: new Date().toISOString().slice(0, 19).replace(/[-:T]/g, ''),
    model: MODEL, base: BASE,
    eval: { passed, total: rows.length, rate, fails },
    probe: drift, stability: { distinct: uniq.length, share },
    verdicts: verdicts.map(([n, ok, d]) => ({ name: n, ok, detail: d })),
    elapsed_s: Math.round((Date.now() - t0) / 1000),
  };

  const outDir = path.join(HERE, 'check_out', summary.stamp);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'run.json'), JSON.stringify(summary, null, 2), 'utf8');

  const allOk = verdicts.every((v) => v[1]);
  emit({ type: 'done', ok: allOk, summary });
  log(`\n报告：${path.join(outDir, 'run.json')}  耗时 ${summary.elapsed_s}s`);
  log(allOk ? '结果：全部达标' : '结果：存在不达标项');
  return allOk ? 0 : 2;
}

main().then((c) => process.exit(c)).catch((e) => {
  emit({ type: 'error', text: String(e && e.message || e) });
  process.exit(1);
});
