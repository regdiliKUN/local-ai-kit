#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
run_all.py —— 一条命令跑完本地模型体检

做三件事：
  1. 判分器自检（确认体检工具本身没坏）
  2. 质量基线（21 题，看能力有没有掉）
  3. 长上下文漂移 + 采样稳定性（看数值有没有漂、候选有没有被压平）

不负责启停模型服务——Ollama 常驻即可，脚本只连它。

用法：
    python run_all.py                 # 完整体检
    python run_all.py --quick         # 只跑 8K/16K/32K，快一倍
    python run_all.py --baseline      # 与上一次结果对比，报退步
    python run_all.py --selftest      # 只跑工具自检，不连模型

环境变量：
    LOCAL_AI_BASE_URL   默认 http://127.0.0.1:11434/v1
    LOCAL_AI_MODEL      默认 qwen3.8:27b
    LOCAL_AI_API_KEY    默认 ollama

退出码：0 全部达标 / 2 有不达标 / 1 环境问题
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT_DIR = HERE / "check_out"

THRESH_EVAL = 0.90
THRESH_DROP = 0.05
THRESH_STABILITY = 0.80

sys.path.insert(0, str(HERE))

_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def say(msg: str = "") -> None:
    print(msg, flush=True)


def head(title: str) -> None:
    say()
    say("=" * 60)
    say(f"  {title}")
    say("=" * 60)


def wire(mod) -> None:
    """把地址/密钥注入被导入的检查模块（它们在 import 时固化了常量）。"""
    import eval_runner as E
    mod.BASE_URL = E.BASE_URL
    mod.API_KEY = E.API_KEY
    mod.MODEL = E.MODEL


def health() -> bool:
    import eval_runner as E
    try:
        req = urllib.request.Request(
            E.BASE_URL.rstrip("/") + "/models",
            headers={"Authorization": "Bearer " + E.API_KEY})
        with _OPENER.open(req, timeout=6) as r:
            return r.status == 200
    except Exception:
        return False


def load_prev() -> dict | None:
    for d in sorted(OUT_DIR.glob("*/run.json"), reverse=True):
        try:
            return json.loads(d.read_text(encoding="utf-8"))
        except Exception:
            continue
    return None


def main() -> int:
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    ap = argparse.ArgumentParser(description="本地模型体检")
    ap.add_argument("--quick", action="store_true", help="只跑 8K/16K/32K")
    ap.add_argument("--baseline", action="store_true", help="与上一次对比")
    ap.add_argument("--selftest", action="store_true", help="只跑工具自检")
    args = ap.parse_args()

    import eval_runner as E
    import flip_probe as P
    wire(P)

    head("工具自检")
    guard_ok = True
    try:
        import command_guard as G
        g = G.classify("rm -rf /")
        guard_ok = g["verdict"] == G.DENY and G.classify("ls -la")["verdict"] == G.ALLOW
        say(f"[guard] 拦截器判定正确={guard_ok}")
    except Exception as e:
        say(f"[guard] 自检失败: {e}")
        guard_ok = False

    say(f"[eval] 题库 {len(E.load_golden())} 题")
    if args.selftest:
        say("\n结果: " + ("工具就绪" if guard_ok else "工具异常"))
        return 0 if guard_ok else 1

    if not health():
        say(f"\n[FAIL] 连不上 {E.BASE_URL}")
        say("       先确认 Ollama 在跑：ollama list / ollama ps")
        return 1

    stamp = time.strftime("%Y%m%d-%H%M%S")
    cur: dict = {"stamp": stamp, "base_url": E.BASE_URL, "model": E.MODEL,
                 "guard_ok": guard_ok}
    t0 = time.time()

    head("质量基线")
    items = E.load_golden()
    rows = []
    for it in items:
        s = time.time()
        try:
            text = E.ask(it["prompt"])
            ok, why = E.check(it["check"]["type"], it["check"].get("value"), text)
        except Exception as e:
            text, ok, why = "", False, f"异常: {e}"
        rows.append({"id": it["id"], "cat": it["cat"], "ok": ok, "why": why,
                     "sec": round(time.time() - s, 2)})
    passed = sum(r["ok"] for r in rows)
    rate = passed / len(rows) if rows else 0.0
    fails = [r["id"] for r in rows if not r["ok"]]
    say(f"[eval] {passed}/{len(rows)} = {rate:.0%}" + (f"  未过：{fails}" if fails else ""))
    cur["eval"] = {"total": len(rows), "passed": passed, "rate": rate, "fails": fails}

    head("长上下文漂移")
    ctxs = [8192, 16384, 32768] if args.quick else [8192, 16384, 32768, 49152, 65536]
    results = []
    for n in ctxs:
        r = P.run_one("count", n, 1.6)
        results.append(r)
        say(f"   ctx≈{n:>6} → 实际 {r['prompt_tokens']:>6} tokens，{r['elapsed_s']:>6.1f}s")
    prows = [P.compare(results[0], r) for r in results[1:]]
    P.print_table(prows)
    knee = P.find_knee(prows)
    cur["probe"] = {
        "onset": knee["onset"]["ctx"] if knee["onset"] else None,
        "alarm": knee["alarm"]["ctx"] if knee["alarm"] else None,
        "rows": prows,
    }
    say(f"[probe] onset={cur['probe']['onset']}  alarm={cur['probe']['alarm']}")

    head("采样稳定性")
    from collections import Counter
    sigs = []
    for i in range(3):
        r = P.run_one("needle", 16384, 1.6, temperature=0.7, seed=P.SEED + i)
        sig = P.answer_signature("needle", r["text"])
        sigs.append(sig)
        say(f"   seed={P.SEED + i:<4} 召回={r['needle']['recall']:.0%}")
    counter = Counter(sigs)
    share = counter.most_common(1)[0][1] / len(sigs)
    say(f"[stability] 不同答案 {len(counter)}，众数占比 {share:.0%}")
    cur["stability"] = {"distinct": len(counter), "share": share}

    head("判据")
    verdicts = [
        ("拦截器自检", guard_ok, "通过" if guard_ok else "失败"),
        (f"质量基线 ≥{THRESH_EVAL:.0%}", rate >= THRESH_EVAL,
         f"{passed}/{len(rows)} = {rate:.0%}"),
        ("漂移未超阈值", cur["probe"]["alarm"] is None,
         f"alarm={cur['probe']['alarm']}" if cur["probe"]["alarm"] else "全程 <5%"),
        (f"稳定性 ≥{THRESH_STABILITY:.0%}", share >= THRESH_STABILITY,
         f"众数占比 {share:.0%}"),
    ]
    prev = load_prev() if args.baseline else None
    if prev and prev.get("eval"):
        drop = prev["eval"]["rate"] - rate
        verdicts.append((f"对比上次跌幅 ≤{THRESH_DROP:.0%}", drop <= THRESH_DROP,
                         f"上次 {prev['eval']['rate']:.0%}，本次 {rate:.0%}，差 {drop:+.0%}"))

    for name, ok, detail in verdicts:
        say(f"  [{'PASS' if ok else 'FAIL'}] {name:<24} {detail}")

    cur["elapsed_s"] = round(time.time() - t0, 1)
    outdir = OUT_DIR / stamp
    outdir.mkdir(parents=True, exist_ok=True)
    (outdir / "run.json").write_text(json.dumps(cur, ensure_ascii=False, indent=2),
                                     encoding="utf-8")
    lines = [f"# 体检报告 {stamp}", "",
             f"- 模型：`{E.MODEL}`", f"- 接口：{E.BASE_URL}", "",
             "| 判据 | 结果 | 数值 |", "|---|---|---|"]
    for name, ok, detail in verdicts:
        lines.append(f"| {name} | {'✅' if ok else '❌'} | {detail} |")
    lines += ["", "## 未通过的题", ""]
    lines += [f"- {f}" for f in fails] if fails else ["（无）"]
    (outdir / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

    say(f"\n报告：{outdir / 'summary.md'}  总耗时 {cur['elapsed_s']}s")
    all_ok = all(ok for _, ok, _ in verdicts)
    say("\n结果: " + ("全部达标" if all_ok else "存在不达标项"))
    return 0 if all_ok else 2


if __name__ == "__main__":
    sys.exit(main())
