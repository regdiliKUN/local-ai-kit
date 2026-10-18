#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
flip_probe.py —— 长上下文 top-1 翻转率探针（对应评估报告 A7b）

背景
----
参考视频（BV1ifpQ6PEk5）的做法：固定模型、固定权重，只改一个变量（attention 后端 /
KV 精度 / 权重量化），用同一批 prompt 在长上下文下比对"每个位置选出来的下一个字"。
差异一旦出现，说明数值路径已经把 top-1 挤掉了。

本探针只做其中一件最基础、最可复现的事：
    **在上下文长度递增的情况下，测量同一段续写的逐位漂移。**

口径（重要，不看会误读）
------------------------
统计对象 : 模型对**固定 probe prompt** 生成的续写（greedy 解码，temperature=0）
基线     : 最短上下文（默认 8192 tokens）那次输出
判定口径 : 同一序号位置上，字符不同 → 记一次「翻转」
           token 级（若服务端支持 logprobs）→ 比较同一位置的 token 文本
统计窗口 : 前 WARMUP 个字符不计（避开开头格式差异），之后到两串公共长度为统计窗口
输出指标 : flip_rate      窗口内逐位不同占比        ← 主指标
           first_div      首个分歧位置（字符序号）  ← 最有用：从第几个字开始跑偏
           events         连续差异块个数（1 段连续错 = 1 次事件）
           lev            编辑距离比率（对插入/删除稳健）
           token_flip     token 级翻转率（有 logprobs 时）

用法
----
    python flip_probe.py --selftest          # 不联网，验证指标逻辑
    python flip_probe.py --dry-run           # 只构建 prompt，不调模型
    python flip_probe.py --health            # 检查引擎在线
    python flip_probe.py                     # 完整跑（需要引擎已启动且显存够）
    python flip_probe.py --contexts 8192,32768,65536 --task count

零第三方依赖。
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# ---------------------------------------------------------------- 配置

BASE_URL = os.environ.get("LOCAL_AI_BASE_URL") or os.environ.get("OLLAMA_BASE_URL") or "http://127.0.0.1:11434/v1"
API_KEY = os.environ.get("LOCAL_AI_API_KEY") or os.environ.get("OLLAMA_API_KEY") or "ollama"
MODEL = os.environ.get("LOCAL_AI_MODEL") or "qwen3.8:27b"

SEED = 42
MAX_TOKENS = 800             # 200 行计数约需 600-700 token；太小会被截断在随机位置
WARMUP = 128                 # 前 128 字符不计入统计窗口
DEFAULT_CONTEXTS = "8192,32768,65536"
DEFAULT_LADDER = "8192,16384,32768,49152,65536"   # 阶梯：看趋势用这个
ALARM_RATE = 0.05            # 翻转率告警阈值 5%
OUT_DIR = Path("probe_out")

_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


# ---------------------------------------------------------------- 语料

# 固定词表：用固定 seed 抽样，保证每次跑出来填料的字节完全一致
_WORDS = [
    "机架", "冷却", "光纤", "调度", "缓存", "索引", "分片", "副本", "心跳", "租约",
    "灰度", "回滚", "探针", "阈值", "告警", "熔断", "限流", "编排", "镜像", "内核",
    "批处理", "流水线", "一致性", "幂等", "补偿", "对账", "摘要", "签名", "盐值", "证书",
]


def build_filler(target_chars: int, seed: int = 7) -> str:
    """生成确定性长文本（非重复段落，避免模型锁死到重复模式上）。

    每行形如：第 0001 条：缓存/副本 在 灰度 阶段需要 幂等 与 对账。
    """
    rnd = random.Random(seed)
    lines: list[str] = []
    total = 0
    i = 0
    while total < target_chars:
        i += 1
        a, b, c = rnd.sample(_WORDS, 3)
        line = f"第 {i:04d} 条：{a}/{b} 在 {c} 阶段需要校验一致性与可回滚性。\n"
        lines.append(line)
        total += len(line)
    return "".join(lines)


TASKS = {
    # 高度可预测、位置多，任何偏离都值得解释
    "count": "请从 1 开始逐行输出整数，每行一个，一直输出到 200。不要输出任何其它内容。",
    # 复述任务：续写几乎完全由 prompt 决定，漂移最容易暴露
    "repeat": (
        "请把下面这段文本原样重复一遍，不要增删任何字符，不要加解释：\n"
        "本地模型的表现取决于推理栈的数值一致性。注意力核函数、缓存精度、"
        "权重量化与跨卡通信，每一层都会引入舍入差异。短对话里察觉不到，"
        "上下文拉长后误差会累积，最终在关键位置改变模型的选择。"
    ),
    # 结构化输出：模拟工具调用前的格式化推理
    "code": "用 Python 写一个函数 fib(n)，返回前 n 个斐波那契数。只输出代码，不要解释。",
    # 针测：答案必须从长上下文里捞，模型不读上下文就必错
    "needle": (
        "上面日志里夹着若干「校验码 KX-xxxx」。请按它们出现的先后顺序，"
        "把所有校验码逐行输出，每行一个，不要编号、不要解释。"
    ),
}

NEEDLE_MARKS = 8          # 埋几根针
NEEDLE_PREFIX = "※ 校验码 "


def needle_codes() -> list[str]:
    return [f"KX-{i * 137 + 4821}" for i in range(NEEDLE_MARKS)]


def build_needle_messages(target_tokens: int, chars_per_token: float) -> tuple[list[dict], list[str]]:
    """在填料里等距埋针，返回 (messages, 期望的校验码顺序)。"""
    target_chars = max(4000, int(target_tokens * chars_per_token))
    lines = build_filler(target_chars).splitlines(keepends=True)
    n = len(lines)
    codes = needle_codes()
    for i, code in enumerate(codes):
        pos = int(n * (i + 1) / (NEEDLE_MARKS + 1))
        pos = min(pos, n - 1)
        lines[pos] = lines[pos].rstrip("\n") + f"  {NEEDLE_PREFIX}{code}\n"
    user = (
        "下面是一份日志清单，里面夹着若干校验码。\n\n"
        + "".join(lines)
        + "\n=== 问题 ===\n"
        + TASKS["needle"]
    )
    return [
        {"role": "system", "content": "你是一个严格遵循指令的助手，只输出被要求的内容。"},
        {"role": "user", "content": user},
    ], codes


def score_needles(text: str, expected: list[str]) -> dict:
    """从输出里抽出校验码，算召回与顺序正确性。"""
    import re
    got = re.findall(r"KX-\d+", text)
    hit = [c for c in expected if c in got]
    order_ok = got[:len(expected)] == expected if got else False
    return {
        "recall": len(hit) / len(expected) if expected else 0.0,
        "found": len(hit),
        "expected_n": len(expected),
        "order_ok": order_ok,
        "dupes": len(got) - len(set(got)),
    }


def build_messages(task: str, target_tokens: int, chars_per_token: float) -> list[dict]:
    """构造 messages：长填料在前，probe 问题固定在最后（模拟真实的长上下文场景）。

    needle 任务需要把期望答案一并带出，所以走 build_needle_messages，
    这里只负责非针测的普通任务。
    """
    target_chars = max(0, int(target_tokens * chars_per_token) - len(TASKS[task]) - 64)
    filler = build_filler(target_chars)
    user = (
        "下面是一份无关的日志清单，请忽略它的内容，只回答最后的问题。\n\n"
        + filler
        + "\n\n=== 问题 ===\n"
        + TASKS[task]
    )
    return [
        {"role": "system", "content": "你是一个严格遵循指令的助手，只输出被要求的内容。"},
        {"role": "user", "content": user},
    ]


# ---------------------------------------------------------------- HTTP

def post_chat(messages: list[dict], use_logprobs: bool = True,
              thinking: bool = False, temperature: float = 0.0,
              seed: int = SEED) -> dict:
    body = {
        "model": MODEL,
        "messages": messages,
        "temperature": temperature,   # 翻转探针用 0；稳定性探针会调高
        "seed": seed,
        "max_tokens": MAX_TOKENS,
        "stream": False,
    }
    if not thinking:
        # 默认关掉思考链：否则 300 token 里大半是 reasoning，
        # 真正 content 只剩几十字节，两次生成会截断在不同位置，比较失去意义。
        body["chat_template_kwargs"] = {"enable_thinking": False}
    if use_logprobs:
        body["logprobs"] = True
        body["top_logprobs"] = 5

    req = urllib.request.Request(
        BASE_URL.rstrip("/") + "/chat/completions",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + API_KEY,
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        raw = _OPENER.open(req, timeout=1800).read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")[:400]
        # 不同服务端对可选字段的宽容度不同：先去掉 logprobs，再去掉 chat_template_kwargs。
        # 两次都失败才认为是真错误。
        if use_logprobs and e.code in (400, 422):
            print(f"[warn] logprobs 不被支持（HTTP {e.code}），退回字符级比较", flush=True)
            return post_chat(messages, use_logprobs=False, thinking=thinking,
                             temperature=temperature, seed=seed)
        if not thinking and e.code in (400, 422):
            print(f"[warn] 服务端不认 chat_template_kwargs（HTTP {e.code}），去掉后重试", flush=True)
            return post_chat(messages, use_logprobs=False, thinking=True,
                             temperature=temperature, seed=seed)
        raise SystemExit(f"[HTTP {e.code}] {detail}") from None
    return json.loads(raw.decode("utf-8", "ignore"))


def health() -> bool:
    try:
        req = urllib.request.Request(
            BASE_URL.rstrip("/") + "/models",
            headers={"Authorization": "Bearer " + API_KEY},
        )
        with _OPENER.open(req, timeout=8) as r:
            return r.status == 200
    except Exception:
        return False


# ---------------------------------------------------------------- 指标

def first_divergence(a: str, b: str) -> int:
    """首个不同的字符序号；完全相同返回 -1；一方是另一方前缀则返回较短长度。"""
    n = min(len(a), len(b))
    for i in range(n):
        if a[i] != b[i]:
            return i
    if len(a) != len(b):
        return n
    return -1


def flip_rate(base: str, test: str, warmup: int = WARMUP) -> float | None:
    """统计窗口内逐位不同占比。窗口 = [warmup, min(len))。"""
    n = min(len(base), len(test))
    if n <= warmup:
        return None
    mism = sum(1 for i in range(warmup, n) if base[i] != test[i])
    return mism / (n - warmup)


def divergence_events(base: str, test: str, warmup: int = WARMUP) -> int:
    """连续差异块计数：一段连续错位算 1 次事件，而不是每个字符各算一次。"""
    n = min(len(base), len(test))
    events, in_run = 0, False
    for i in range(warmup, n):
        diff = base[i] != test[i]
        if diff and not in_run:
            events += 1
            in_run = True
        elif not diff:
            in_run = False
    return events


LEV_MAX_CHARS = 3000          # 编辑距离的计算上限（O(n*m)，再长会拖慢）


def levenshtein_ratio(a: str, b: str) -> float | None:
    """编辑距离 / 较长串长度。对插入删除稳健，补 flip_rate 的盲区。

    超过 LEV_MAX_CHARS 返回 None（不计算），而不是截断后硬算——
    截断会把长输出的差异算少，得到一个看起来正常、实际偏低的假数字。
    """
    if not a and not b:
        return 0.0
    if len(a) > LEV_MAX_CHARS or len(b) > LEV_MAX_CHARS:
        return None
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1] / max(len(a), len(b))


def token_flips(base_tokens: list[str], test_tokens: list[str]) -> float | None:
    n = min(len(base_tokens), len(test_tokens))
    if n == 0:
        return None
    mism = sum(1 for i in range(n) if base_tokens[i] != test_tokens[i])
    return mism / n


def extract_logprobs(resp: dict) -> list[str]:
    """从 OpenAI 兼容响应里取 token 序列；没有就返回空列表。"""
    try:
        content = resp["choices"][0].get("logprobs", {}).get("content") or []
        return [c.get("token", "") for c in content]
    except (KeyError, IndexError, TypeError):
        return []


# ---------------------------------------------------------------- 单次采样

def run_one(task: str, target_tokens: int, chars_per_token: float,
            temperature: float = 0.0, seed: int = SEED) -> dict:
    expected: list[str] = []
    if task == "needle":
        msgs, expected = build_needle_messages(target_tokens, chars_per_token)
    else:
        msgs = build_messages(task, target_tokens, chars_per_token)

    t0 = time.time()
    resp = post_chat(msgs, temperature=temperature, seed=seed)
    dt = time.time() - t0

    choice = resp["choices"][0]
    msg = choice.get("message", {}) or {}
    text = msg.get("content") or ""
    reasoning = msg.get("reasoning_content") or ""
    usage = resp.get("usage") or {}
    tokens = extract_logprobs(resp)

    out = {
        "target_tokens": target_tokens,
        "prompt_tokens": usage.get("prompt_tokens"),
        "completion_tokens": usage.get("completion_tokens"),
        "elapsed_s": round(dt, 2),
        "text": text,
        "tokens": tokens,
        "reasoning_chars": len(reasoning),
        "finish_reason": choice.get("finish_reason"),
    }
    if expected:
        out["needle"] = score_needles(text, expected)
        out["expected"] = expected
    return out


# ---------------------------------------------------------------- 报告

def compare(base: dict, test: dict) -> dict:
    b, t = base["text"], test["text"]
    return {
        "ctx": test["prompt_tokens"],
        "first_div": first_divergence(b, t),
        "flip_rate": flip_rate(b, t),
        "events": divergence_events(b, t),
        "lev": levenshtein_ratio(b, t),
        "token_flip": token_flips(base["tokens"], test["tokens"]) if base["tokens"] and test["tokens"] else None,
        "len_base": len(b),
        "len_test": len(t),
        # 延迟一并留下：不同次运行的差异可能大到 20 倍，不记录就没法解释
        "elapsed_s": test.get("elapsed_s"),
    }


def print_table(rows: list[dict]) -> None:
    print()
    print(f"{'上下文':>9} {'首分歧':>7} {'翻转率':>8} {'事件':>5} {'编辑距':>8} {'耗时':>8}")
    print("-" * 58)
    for r in rows:
        fr = "  n/a" if r["flip_rate"] is None else f"{r['flip_rate']:6.1%}"
        fd = "same" if r["first_div"] == -1 else str(r["first_div"])
        sec = "     n/a" if r.get("elapsed_s") is None else f"{r['elapsed_s']:6.1f}s"
        lev = "     n/a" if r.get("lev") is None else f"{r['lev']:8.3f}"
        print(f"{r['ctx']:>9} {fd:>7} {fr:>8} {r['events']:>5} {lev:>8} {sec:>8}")
    print("-" * 58)
    print(f"统计窗口：跳过前 {WARMUP} 字符；基线 = 最短上下文那一次")
    print("判读：翻转率 >5% 需要查因；首分歧位置比翻转率更能说明「从哪儿开始坏」")
    print("      耗时波动可能很大（引擎冷/热、专家缓存、KV 是否常驻），比较时看同一轮的相对变化")


# ---------------------------------------------------------------- 拐点与曲线

def print_needle_table(results: list[dict]) -> None:
    """针测专用：召回率是绝对指标，不依赖基线。"""
    print()
    print(f"{'上下文':>9} {'召回':>6} {'命中':>7} {'顺序':>5} {'重复':>5} {'耗时':>7}")
    print("-" * 48)
    for r in results:
        n = r.get("needle")
        if not n:
            continue
        print(f"{r['prompt_tokens']:>9} {n['recall']:>6.0%} "
              f"{n['found']}/{n['expected_n']:<5} "
              f"{'OK' if n['order_ok'] else 'NG':>5} {n['dupes']:>5} {r['elapsed_s']:>6.1f}s")
    print("-" * 48)
    print("召回 = 找对的针数 / 埋的针数；这是绝对指标，不依赖基线")

def find_knee(rows: list[dict], alarm: float = ALARM_RATE) -> dict:
    """在阶梯结果里找两个拐点。

    onset : 第一个出现任何分歧的上下文 —— “开始跑偏”
    alarm : 第一个翻转率超过阈值的上下文 —— “显著崩坏”
    """
    onset = next((r for r in rows if r["first_div"] not in (-1, None)), None)
    trip = next((r for r in rows if (r["flip_rate"] or 0) > alarm), None)
    return {"onset": onset, "alarm": trip}


def render_ascii_curve(rows: list[dict]) -> None:
    """终端里画一条翻转率曲线，横条长度按最大值归一。"""
    if not rows:
        return
    rates = [(r["flip_rate"] or 0.0) for r in rows]
    peak = max(rates) or 1e-9
    print()
    print("翻转率随上下文变化")
    print("-" * 66)
    for r, rate in zip(rows, rates):
        width = int(rate / peak * 34)
        bar = "█" * width + ("·" if width == 0 else "")
        fd = "same" if r["first_div"] in (-1, None) else f"@{r['first_div']}"
        flag = "  ⚠" if rate > ALARM_RATE else ""
        print(f"{r['ctx']:>7} │{bar:<35}{rate:7.2%}  首分歧 {fd}{flag}")
    print("-" * 66)
    print(f"阈值 {ALARM_RATE:.0%}；条形按本次峰值 {peak:.2%} 归一")


def write_svg(rows: list[dict], path: Path, title: str = "") -> None:
    """不依赖任何库，手写一张折线图：x=上下文 token，y=翻转率。"""
    W, H = 760, 340
    L, R, T, B = 70, 30, 40, 55
    pw, ph = W - L - R, H - T - B

    rates = [(r["flip_rate"] or 0.0) for r in rows]
    ymax = max([ALARM_RATE * 1.5] + [x * 1.15 for x in rates]) or 0.01
    xs = [r["ctx"] for r in rows]
    xmin, xmax = min(xs), max(xs)
    xspan = max(1, xmax - xmin)

    def px(i: int) -> float:
        return L + (xs[i] - xmin) / xspan * pw

    def py(v: float) -> float:
        return T + ph - (v / ymax) * ph

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
        f'viewBox="0 0 {W} {H}" font-family="Segoe UI,Microsoft YaHei,sans-serif">',
        f'<rect width="{W}" height="{H}" fill="#ffffff"/>',
        f'<text x="{L}" y="24" font-size="15" font-weight="600" fill="#1f2328">'
        f'{title or "top-1 翻转率 vs 上下文长度"}</text>',
    ]
    # y 轴网格
    for k in range(5):
        v = ymax * k / 4
        y = py(v)
        parts.append(f'<line x1="{L}" y1="{y:.1f}" x2="{L+pw}" y2="{y:.1f}" '
                     f'stroke="#e8eaed" stroke-width="1"/>')
        parts.append(f'<text x="{L-10}" y="{y+4:.1f}" font-size="11" fill="#6b7280" '
                     f'text-anchor="end">{v:.1%}</text>')
    # 阈值线
    ty = py(ALARM_RATE)
    parts.append(f'<line x1="{L}" y1="{ty:.1f}" x2="{L+pw}" y2="{ty:.1f}" '
                 f'stroke="#d97706" stroke-width="1.5" stroke-dasharray="6 4"/>')
    parts.append(f'<text x="{L+pw-4}" y="{ty-6:.1f}" font-size="11" fill="#d97706" '
                 f'text-anchor="end">告警阈值 {ALARM_RATE:.0%}</text>')
    # 折线
    pts = " ".join(f"{px(i):.1f},{py(v):.1f}" for i, v in enumerate(rates))
    parts.append(f'<polyline points="{pts}" fill="none" stroke="#dc2626" stroke-width="2.2"/>')
    for i, v in enumerate(rates):
        parts.append(f'<circle cx="{px(i):.1f}" cy="{py(v):.1f}" r="4" fill="#dc2626"/>')
        parts.append(f'<text x="{px(i):.1f}" y="{py(v)-10:.1f}" font-size="11" '
                     f'fill="#b91c1c" text-anchor="middle">{v:.2%}</text>')
    # x 轴标签
    for i, x in enumerate(xs):
        parts.append(f'<text x="{px(i):.1f}" y="{T+ph+22}" font-size="11" fill="#374151" '
                     f'text-anchor="middle">{x//1024}K</text>')
    parts.append(f'<line x1="{L}" y1="{T+ph}" x2="{L+pw}" y2="{T+ph}" stroke="#9ca3af"/>')
    parts.append(f'<text x="{L+pw/2}" y="{H-12}" font-size="12" fill="#6b7280" '
                 f'text-anchor="middle">上下文长度（tokens）</text>')
    parts.append("</svg>")
    path.write_text("\n".join(parts), encoding="utf-8")


# ---------------------------------------------------------------- 自检

def selftest() -> int:
    """不联网验证指标逻辑。这是"关键路径验证"的第一道闸。"""
    cases = []

    # 1) 完全相同 → 0%
    a = "A" * 400
    cases.append(("完全相同", a, a, 0.0, -1, 0))

    # 2) 窗口后单点不同 → 1/(400-128)
    b = list(a); b[200] = "B"
    cases.append(("单点差异@200", a, "".join(b), 1 / (400 - 128), 200, 1))

    # 3) 从 128 开始全不同 → 100%
    c = a[:128] + "C" * (400 - 128)
    cases.append(("128 后全错", a, c, 1.0, 128, 1))

    # 4) 前 128 不同、之后相同 → 0%（验证 warmup 生效）
    d = "Z" * 128 + a[128:]
    cases.append(("仅 warmup 内不同", a, d, 0.0, 0, 0))

    # 5) 短串（短于窗口）→ n/a
    cases.append(("短于窗口", "x" * 50, "y" * 50, None, 0, 0))

    ok = True
    print("=== selftest：指标口径 ===")
    for name, base, test, want_rate, want_div, want_events in cases:
        got_rate = flip_rate(base, test)
        got_div = first_divergence(base, test)
        got_ev = divergence_events(base, test)
        good = (
            (got_rate is None and want_rate is None) or
            (got_rate is not None and want_rate is not None and abs(got_rate - want_rate) < 1e-9)
        ) and got_div == want_div and got_ev == want_events
        ok &= good
        print(f"[{'OK ' if good else 'FAIL'}] {name:<14} rate={got_rate} div={got_div} ev={got_ev}"
              + ("" if good else f"  期望 rate={want_rate} div={want_div} ev={want_events}"))

    # 编辑距离
    print("\n=== selftest：编辑距离 ===")
    lev_cases = [("相同", "abcd", "abcd", 0.0), ("单替换", "abcd", "abce", 0.25),
                 ("超长不硬算", "x" * (LEV_MAX_CHARS + 1), "y" * (LEV_MAX_CHARS + 1), None)]
    for name, x, y, want in lev_cases:
        got = levenshtein_ratio(x, y)
        if want is None:
            good = got is None
            shown = "None" if got is None else f"{got:.3f}"
            print(f"[{'OK ' if good else 'FAIL'}] {name:<10} lev={shown} 期望=None（不计算）")
        else:
            good = got is not None and abs(got - want) < 1e-9
            print(f"[{'OK ' if good else 'FAIL'}] {name:<10} lev={got:.3f} 期望={want:.3f}")
        ok &= good

    # 确定性填料
    print("\n=== selftest：填料确定性 ===")
    f1, f2 = build_filler(5000), build_filler(5000)
    good = f1 == f2 and len(f1) >= 5000
    ok &= good
    print(f"[{'OK ' if good else 'FAIL'}] 两次生成一致={f1 == f2} 长度={len(f1)}")

    print("\n结果:", "全部通过" if ok else "存在失败项")
    return 0 if ok else 1


# ---------------------------------------------------------------- 端到端自证

def e2e() -> int:
    """起一个进程内 mock OpenAI 服务，把整条链路跑通（不碰真模型、不占显存）。

    验证的是最容易出错的部分：HTTP 请求 → 响应解析 → logprobs 提取 →
    指标计算 → 落盘。mock 会按 prompt 长度制造不同程度的漂移，
    因此断言"越长的上下文翻转率越高"即可证明统计链路是对的。
    """
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    global BASE_URL

    def fake_text(plen: int) -> str:
        body = "".join(f"{i}\n" for i in range(1, 201))
        if plen > 30000:                      # 长上下文：制造 3 处漂移
            for pos in (150, 300, 450):
                body = body[:pos] + "X" + body[pos + 1:]
        elif plen > 12000:                    # 中上下文：制造 1 处漂移
            body = body[:300] + "Y" + body[301:]
        return body

    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def _send(self, obj):
            b = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)

        def do_GET(self):
            self._send({"object": "list", "data": [{"id": MODEL}]})

        def do_POST(self):
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n) or b"{}")
            prompt = json.dumps(req.get("messages"), ensure_ascii=False)
            text = fake_text(len(prompt))
            resp = {
                "id": "mock", "object": "chat.completion", "model": MODEL,
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": text},
                    "finish_reason": "stop",
                    "logprobs": {"content": [{"token": ch, "logprob": -0.1}
                                             for ch in text]},
                }],
                "usage": {"prompt_tokens": len(prompt), "completion_tokens": len(text)},
            }
            self._send(resp)

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    BASE_URL = f"http://127.0.0.1:{port}/v1"

    print(f"=== e2e：mock 服务 127.0.0.1:{port} ===")
    ok = True
    if not health():
        print("[FAIL] health 探不通")
        ok = False
    else:
        print("[OK ] /models 可达")

    # 用 chars_per_token=1.0 精确控制 prompt 字符数，让 mock 的分支可预测
    ctxs = [1000, 20000, 40000]
    results = [run_one("count", n, 1.0) for n in ctxs]
    for r in results:
        print(f"      目标={r['target_tokens']:>6} 实际prompt_tokens={r['prompt_tokens']:>6} "
              f"生成={r['completion_tokens']}")

    # logprobs 解析
    if results[0]["tokens"]:
        print(f"[OK ] logprobs 解析出 {len(results[0]['tokens'])} 个 token")
    else:
        print("[FAIL] logprobs 没解析出来")
        ok = False

    base = results[0]
    rows = [compare(base, r) for r in results[1:]]
    print(f"\n基线：prompt_tokens={base['prompt_tokens']}  长度={len(base['text'])}")
    print_table(rows)

    # 断言：mock 的分支是确定的，指标必须逐项对上
    if "X" in base["text"] or "Y" in base["text"]:
        print("[FAIL] 基线不该含漂移标记，mock 分支或构建逻辑有问题")
        ok = False
    else:
        print("[OK ] 基线是干净输出（无漂移标记）")

    if rows[0]["first_div"] != 300 or rows[0]["events"] != 1:
        print(f"[FAIL] 中上下文应 1 处漂移@300，实际 first_div={rows[0]['first_div']} "
              f"events={rows[0]['events']}")
        ok = False
    else:
        print("[OK ] 中上下文：1 处漂移 @300，事件数=1")

    if rows[1]["first_div"] != 150 or rows[1]["events"] != 3:
        print(f"[FAIL] 长上下文应 3 处漂移（首个@150），实际 first_div={rows[1]['first_div']} "
              f"events={rows[1]['events']}")
        ok = False
    else:
        print("[OK ] 长上下文：3 处漂移，首个 @150，事件数=3")

    if rows[1]["token_flip"] is None:
        print("[FAIL] token 级翻转率缺失")
        ok = False
    else:
        print(f"[OK ] token 级翻转率={rows[1]['token_flip']:.3%}")

    # ---- 阶段 2：服务端不支持 logprobs 时必须优雅降级 ----
    class Strict(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def do_POST(self):
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n) or b"{}")
            if req.get("logprobs"):
                b = b'{"error":"logprobs not supported"}'
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)
                return
            text = fake_text(1000)
            b = json.dumps({
                "choices": [{"index": 0, "finish_reason": "stop",
                             "message": {"role": "assistant", "content": text}}],
                "usage": {"prompt_tokens": 1000, "completion_tokens": len(text)},
            }, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)

    srv2 = ThreadingHTTPServer(("127.0.0.1", 0), Strict)
    port2 = srv2.server_address[1]
    threading.Thread(target=srv2.serve_forever, daemon=True).start()
    BASE_URL = f"http://127.0.0.1:{port2}/v1"

    print("\n=== e2e 阶段 2：logprobs 返回 400 时的降级 ===")
    try:
        resp = post_chat(build_messages("count", 1000, 1.0))
        text = resp["choices"][0]["message"]["content"]
        toks = extract_logprobs(resp)
        if text and not toks:
            print(f"[OK ] 已降级为纯文本比较（content {len(text)} 字符，tokens=0）")
        else:
            print(f"[FAIL] 降级异常：content={len(text)} tokens={len(toks)}")
            ok = False
    except SystemExit as e:
        print(f"[FAIL] 降级失败，直接退出了：{e}")
        ok = False
    srv2.shutdown()

    print("\n结果:", "全部通过" if ok else "存在失败项")
    return 0 if ok else 1


def mock_ladder() -> int:
    """阶梯 + 拐点 + 曲线 的自证：mock 按长度制造递增漂移，验证拐点能被抓到。"""
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    global BASE_URL

    def fake_text(plen: int) -> str:
        body = "".join(f"{i}\n" for i in range(1, 201))
        if plen < 6000:
            return body                                   # 干净
        if plen < 14000:
            pos = [300]                                   # 1 处
        elif plen < 22000:
            pos = [200, 400, 520]                         # 3 处
        elif plen < 30000:
            pos = list(range(200, 600, 50))               # 每 50 字符一处
        else:
            pos = list(range(200, 640, 8))                # 每 8 字符一处 → 超过 5%
        for p in pos:
            body = body[:p] + "X" + body[p + 1:]
        return body

    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def _send(self, obj):
            b = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)

        def do_GET(self):
            self._send({"object": "list", "data": [{"id": MODEL}]})

        def do_POST(self):
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n) or b"{}")
            plen = len(json.dumps(req.get("messages"), ensure_ascii=False))
            text = fake_text(plen)
            self._send({
                "choices": [{"index": 0, "finish_reason": "stop",
                             "message": {"role": "assistant", "content": text},
                             "logprobs": {"content": [{"token": c} for c in text]}}],
                "usage": {"prompt_tokens": plen, "completion_tokens": len(text)},
            })

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    BASE_URL = f"http://127.0.0.1:{port}/v1"

    ctxs = [2000, 8000, 16000, 24000, 32000]
    print(f"=== mock 阶梯：contexts={ctxs} ===")
    results = [run_one("count", n, 1.0) for n in ctxs]
    base = results[0]
    rows = [compare(base, r) for r in results[1:]]

    print_table(rows)
    render_ascii_curve(rows)
    knee = find_knee(rows)
    print()
    if knee["onset"]:
        print(f"onset（开始跑偏）：ctx={knee['onset']['ctx']}  首分歧@{knee['onset']['first_div']}")
    else:
        print("onset：未出现分歧")
    if knee["alarm"]:
        print(f"alarm（超阈值）  ：ctx={knee['alarm']['ctx']}  翻转率={knee['alarm']['flip_rate']:.2%}")
    else:
        print("alarm：未超阈值")

    outdir = OUT_DIR / "mock-ladder"
    outdir.mkdir(parents=True, exist_ok=True)
    svg = outdir / "curve.svg"
    write_svg(rows, svg, "mock 阶梯：翻转率 vs 上下文（自证用）")
    print(f"\n曲线已写出：{svg}")

    ok = True
    if not knee["onset"] or knee["onset"]["ctx"] > 16000:
        print("[FAIL] onset 应在 8000 那档（mock 从 6000 字符开始制造漂移）")
        ok = False
    else:
        print("[OK ] onset 落在预期档位")
    if not knee["alarm"]:
        print("[FAIL] 最后一档应超过 5% 阈值")
        ok = False
    else:
        print("[OK ] alarm 被正确触发")
    if not svg.exists() or svg.stat().st_size < 500:
        print("[FAIL] SVG 没写出来或内容过小")
        ok = False
    else:
        print(f"[OK ] SVG 写出成功（{svg.stat().st_size} 字节）")

    srv.shutdown()
    print("\n结果:", "全部通过" if ok else "存在失败项")
    return 0 if ok else 1


# ---------------------------------------------------------------- 稳定性探针

def answer_signature(task: str, text: str) -> tuple:
    """把一次输出归一成"答案签名"，用于判断多次采样是否给了同一个答案。"""
    if task == "needle":
        import re
        return tuple(re.findall(r"KX-\d+", text))
    return (text.strip(),)


def cmd_stability(task: str, target_tokens: int, chars_per_token: float,
                  n: int, temp: float) -> int:
    """多 seed 采样一致性 —— logprobs 拿不到时的替代观测手段。

    原理：top-1 翻转的本质是「第一名和第二名贴得很近」。
    分布很尖时，即使调高温度、换 seed，答案也不变；
    分布被量化噪声压平后，同一个 prompt 会摇摆出多个答案。
    所以「答案签名」的集中度可以间接反映分布的锐利程度。
    """
    print(f"=== 稳定性探针 ===")
    print(f"task={task}  ctx≈{target_tokens}  采样={n}  temperature={temp}  "
          f"seed={SEED}..{SEED + n - 1}")
    print("目的：拿不到 logprobs 时，用多 seed 采样看模型是否在几个候选之间摇摆。")
    print()

    runs: list[tuple[int, dict, tuple]] = []
    for i in range(n):
        seed = SEED + i
        r = run_one(task, target_tokens, chars_per_token, temperature=temp, seed=seed)
        sig = answer_signature(task, r["text"])
        runs.append((seed, r, sig))
        extra = ""
        if r.get("needle"):
            extra = f"  召回={r['needle']['recall']:.0%}"
        shown = str(sig)
        shown = shown if len(shown) <= 58 else shown[:55] + "…)"
        print(f"  seed={seed:<4} {r['elapsed_s']:>5.1f}s  签名={shown}{extra}")

    from collections import Counter
    counter = Counter(sig for _, _, sig in runs)
    mode_sig, mode_n = counter.most_common(1)[0]
    share = mode_n / n

    print()
    print("-" * 58)
    print(f"不同答案数：{len(counter)}")
    print(f"众数占比  ：{share:.0%}（{mode_n}/{n}）")
    if task == "needle":
        recalls = [r["needle"]["recall"] for _, r, _ in runs if r.get("needle")]
        if recalls:
            print(f"召回范围  ：{min(recalls):.0%} ~ {max(recalls):.0%}")
    print("-" * 58)

    if share >= 0.9:
        verdict = "分布很尖：温度调高、换 seed 都给出同一答案 → 量化噪声没有明显影响选择"
    elif share >= 0.6:
        verdict = "存在摇摆：同一 prompt 有 2-3 种答案 → 候选之间差距小，属于可疑区"
    else:
        verdict = "高度不稳定：答案分散 → 分布被压平，正是 top-1 翻转会发生的形态"
    print(f"判读：{verdict}")
    print("注意：这是间接指标。要拿 top-1 真值，仍需引擎输出 logprobs（见报告 R2b）。")
    return 0


def mock_stability() -> int:
    """稳定性探针的自证：mock 按 seed 奇偶返回不同答案，验证摇摆能被检出。"""
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    global BASE_URL
    codes = needle_codes()

    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def _send(self, obj):
            b = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)

        def do_GET(self):
            self._send({"object": "list", "data": [{"id": MODEL}]})

        def do_POST(self):
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n) or b"{}")
            seed = int(req.get("seed") or 0)
            seq = list(codes)
            if seed % 2:                       # 奇数 seed：交换前两个 → 另一种答案
                seq[0], seq[1] = seq[1], seq[0]
            text = "\n".join(seq)
            self._send({
                "choices": [{"index": 0, "finish_reason": "stop",
                             "message": {"role": "assistant", "content": text}}],
                "usage": {"prompt_tokens": 1000, "completion_tokens": 40},
            })

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    BASE_URL = f"http://127.0.0.1:{port}/v1"

    print("=== 稳定性探针自证：seed 奇偶交替，应检出 2 种答案 ===")
    rc = cmd_stability("needle", 1000, 1.0, 4, 0.7)
    srv.shutdown()

    ok = rc == 0
    print("\n结果:", "全部通过" if ok else "存在失败项")
    return 0 if ok else 1


# ---------------------------------------------------------------- main

def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    ap = argparse.ArgumentParser(description="长上下文 top-1 翻转率探针（A7b）")
    ap.add_argument("--contexts", default=None, help="逗号分隔的目标上下文 token 数")
    ap.add_argument("--ladder", action="store_true",
                    help=f"用阶梯 {DEFAULT_LADDER}（看趋势、找拐点）")
    ap.add_argument("--task", default="count", choices=sorted(TASKS), help="probe 任务")
    ap.add_argument("--chars-per-token", type=float, default=1.6,
                    help="构造填料用的字数/token 估算（中文约 1.5-1.7）")
    ap.add_argument("--selftest", action="store_true", help="不联网，验证指标逻辑")
    ap.add_argument("--e2e", action="store_true", help="内置 mock 服务，跑通整条链路")
    ap.add_argument("--mock-ladder", action="store_true", help="mock 阶梯：验证拐点与曲线输出")
    ap.add_argument("--mock-stability", action="store_true", help="mock 稳定性：验证摇摆检出")
    ap.add_argument("--stability", type=int, default=0, metavar="N",
                    help="稳定性探针：同一 prompt 采 N 次（配 --temp），看答案是否摇摆")
    ap.add_argument("--temp", type=float, default=0.7, help="稳定性探针的采样温度，默认 0.7")
    ap.add_argument("--stability-ctx", type=int, default=16384,
                    help="稳定性探针的上下文长度，默认 16384")
    ap.add_argument("--dry-run", action="store_true", help="只构建 prompt，不调模型")
    ap.add_argument("--health", action="store_true", help="检查引擎是否在线")
    args = ap.parse_args()

    if args.selftest:
        return selftest()
    if args.e2e:
        return e2e()
    if args.mock_ladder:
        return mock_ladder()
    if args.mock_stability:
        return mock_stability()

    if args.stability:
        if not health():
            print(f"[FAIL] 连不上 {BASE_URL}")
            return 1
        return cmd_stability(args.task, args.stability_ctx, args.chars_per_token,
                             args.stability, args.temp)

    if args.health:
        ok = health()
        print(f"[{'OK' if ok else 'FAIL'}] {BASE_URL}/models 可达={ok}")
        return 0 if ok else 1

    spec = args.contexts or (DEFAULT_LADDER if args.ladder else DEFAULT_CONTEXTS)
    ctxs = [int(x) for x in spec.split(",") if x.strip()]
    ctxs.sort()

    if args.dry_run:
        print(f"task={args.task}  目标上下文={ctxs}  chars/token={args.chars_per_token}")
        for n in ctxs:
            msgs = build_messages(args.task, n, args.chars_per_token)
            total = sum(len(m["content"]) for m in msgs)
            print(f"  ctx~{n:>6}  字符数={total:>7}  估算tokens={int(total / args.chars_per_token):>7}"
                  f"  messages={len(msgs)}")
        print("\n（dry-run 不调模型；实际 prompt_tokens 以响应里的 usage 为准）")
        return 0

    if not health():
        print(f"[FAIL] 连不上 {BASE_URL}")
        print("       先启动引擎：双击 F:\\本地AI\\menu.bat → [3] 只启动引擎")
        print("       注意：启动前先退出 Ollama，否则显存不够会触发换页崩速")
        return 1

    stamp = time.strftime("%Y%m%d-%H%M%S")
    outdir = OUT_DIR / stamp
    outdir.mkdir(parents=True, exist_ok=True)

    results: list[dict] = []
    print(f"task={args.task}  contexts={ctxs}  max_tokens={MAX_TOKENS}  temp=0  seed={SEED}")
    for n in ctxs:
        print(f"[run] 目标 ctx≈{n} …", flush=True)
        r = run_one(args.task, n, args.chars_per_token)
        (outdir / f"ctx-{n}.json").write_text(
            json.dumps(r, ensure_ascii=False, indent=2), encoding="utf-8")
        (outdir / f"ctx-{n}.txt").write_text(r["text"], encoding="utf-8")
        print(f"      实际 prompt_tokens={r['prompt_tokens']} 生成={r['completion_tokens']} "
              f"耗时={r['elapsed_s']}s finish={r['finish_reason']}"
              + (f"  reasoning={r['reasoning_chars']}字" if r["reasoning_chars"] else ""))
        if r["finish_reason"] == "length":
            print("      [warn] 被 max_tokens 截断：不同档位截断点不同，"
                  "逐位比较会失真（可调大 MAX_TOKENS 或换更短的 task）")
        results.append(r)

    base = results[0]
    rows = [compare(base, r) for r in results[1:]]
    if args.task == "needle":
        print_needle_table(results)
    print_table(rows)
    render_ascii_curve(rows)

    knee = find_knee(rows)
    print()
    if knee["onset"]:
        print(f"onset（开始跑偏）：ctx={knee['onset']['ctx']}  "
              f"首分歧@{knee['onset']['first_div']}")
    else:
        print("onset：全程无分歧（这套配置在本次阶梯内稳定）")
    if knee["alarm"]:
        print(f"alarm（超阈值）  ：ctx={knee['alarm']['ctx']}  "
              f"翻转率={knee['alarm']['flip_rate']:.2%}")
    else:
        print(f"alarm：未超 {ALARM_RATE:.0%} 阈值")

    summary = outdir / "summary.csv"
    with summary.open("w", encoding="utf-8") as f:
        f.write("ctx,first_div,flip_rate,events,lev,token_flip,len_base,len_test\n")
        for r in rows:
            lev = "" if r.get("lev") is None else f"{r['lev']:.4f}"
            f.write(f"{r['ctx']},{r['first_div']},{r['flip_rate']},{r['events']},"
                    f"{lev},{r['token_flip']},{r['len_base']},{r['len_test']}\n")

    svg = outdir / "curve.svg"
    write_svg(rows, svg, f"{args.task} · {MODEL}")
    print(f"\n原始输出：{outdir}")
    print(f"汇总：{summary}")
    print(f"曲线：{svg}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
