#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eval_runner.py —— 黄金评测集跑分器（对应评估报告 A7 / R8）

为什么需要它
------------
项目里有大量**速度**实测，却没有**质量**基线。结果是"变笨"只能靠感觉，
既无法归因，也无法在改配置后验证是否真的变好。这个跑分器把"感觉"变成"数字"。

判据设计
--------
每题带一个机器可判的 check，四类：
    exact       归一化后完全相等
    contains    包含指定子串（大小写敏感）
    regex       正则命中（re.DOTALL）
    json_keys   能解析成 JSON 对象且含指定键
    json_array  能解析成 JSON 数组且长度等于指定值

解码固定 temperature=0、seed=42、关闭思考链 —— 保证同一配置可复现。

用法
----
    python eval_runner.py --selftest         # 不联网，验证判分器
    python eval_runner.py --dry-run          # 只看题库
    python eval_runner.py                    # 跑全部
    python eval_runner.py --cat 算术,代码     # 只跑某几类
    python eval_runner.py --baseline prev.csv # 与上次结果对比

零第三方依赖。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE_URL = os.environ.get("LOCAL_AI_BASE_URL") or os.environ.get("OLLAMA_BASE_URL") or "http://127.0.0.1:11434/v1"
API_KEY = os.environ.get("LOCAL_AI_API_KEY") or os.environ.get("OLLAMA_API_KEY") or "ollama"
MODEL = os.environ.get("LOCAL_AI_MODEL") or "qwen3.8:27b"

SEED = 42
MAX_TOKENS = 512
GOLDEN = Path(os.environ.get("GOLDEN_PATH", Path(__file__).with_name("golden.jsonl")))
OUT_DIR = Path("eval_out")

_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


# ---------------------------------------------------------------- 判分

def _strip_fence(text: str) -> str:
    """去掉 ```lang ... ``` 包裹，很多模型会自作主张加代码块。"""
    m = re.search(r"```[a-zA-Z0-9_+-]*\n(.*?)```", text, re.S)
    return m.group(1).strip() if m else text.strip()


def _norm(text: str) -> str:
    return re.sub(r"\s+", "", _strip_fence(text)).strip()


def check(kind: str, value, text: str) -> tuple[bool, str]:
    """返回 (是否通过, 说明)。"""
    raw = text or ""
    if kind == "exact":
        got = _norm(raw)
        want = str(value)
        ok = got == want or got.rstrip("。.") == want
        return ok, f"got={got[:40]!r} want={want!r}"

    if kind == "contains":
        ok = str(value) in raw
        return ok, f"need={value!r}"

    if kind == "regex":
        ok = re.search(str(value), raw, re.S) is not None
        return ok, f"pattern={value!r}"

    if kind in ("json_keys", "json_array"):
        body = _strip_fence(raw)
        # 容忍模型在 JSON 前后加一句话：截取第一个 { 或 [ 到最后一个 } 或 ]
        for op, cl in (("{", "}"), ("[", "]")):
            i, j = body.find(op), body.rfind(cl)
            if i >= 0 and j > i:
                body = body[i:j + 1]
                break
        try:
            obj = json.loads(body)
        except Exception as e:
            return False, f"json 解析失败: {e}"
        if kind == "json_keys":
            if not isinstance(obj, dict):
                return False, "不是 JSON 对象"
            missing = [k for k in value if k not in obj]
            return not missing, f"missing={missing}" if missing else "ok"
        if not isinstance(obj, list):
            return False, "不是 JSON 数组"
        return len(obj) == int(value), f"len={len(obj)} want={value}"

    return False, f"未知判分类型 {kind}"


# ---------------------------------------------------------------- 采样

def ask(prompt: str, timeout: int = 600, retries: int = 1) -> str:
    body = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": "你是一个严格遵循指令的助手，只输出被要求的内容。"},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0,
        "seed": SEED,
        "max_tokens": MAX_TOKENS,
        "stream": False,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    req = urllib.request.Request(
        BASE_URL.rstrip("/") + "/chat/completions",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + API_KEY},
        method="POST",
    )
    # 一次瞬时失败就把这道题记成"没通过"，会被误读成能力退化。
    # 所以对网络类错误与 5xx 重试一次；4xx 是配置问题，直接报错退出。
    last: Exception | None = None
    for attempt in range(retries + 1):
        try:
            raw = _OPENER.open(req, timeout=timeout).read()
            break
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "ignore")[:300]
            # 有的服务端不认 chat_template_kwargs：去掉后再试一次
            if e.code in (400, 422) and body.get("chat_template_kwargs") is not None:
                body.pop("chat_template_kwargs", None)
                req.data = json.dumps(body, ensure_ascii=False).encode("utf-8")
                continue
            if e.code >= 500 and attempt < retries:
                last = e
                time.sleep(2)
                continue
            raise SystemExit(f"[HTTP {e.code}] {detail}")
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last = e
            if attempt < retries:
                time.sleep(2)
                continue
            raise
    else:
        raise RuntimeError(f"请求失败且重试无效：{last}")
    obj = json.loads(raw.decode("utf-8", "ignore"))
    return (obj["choices"][0].get("message", {}) or {}).get("content") or ""


def health() -> bool:
    try:
        req = urllib.request.Request(BASE_URL.rstrip("/") + "/models",
                                     headers={"Authorization": "Bearer " + API_KEY})
        with _OPENER.open(req, timeout=8) as r:
            return r.status == 200
    except Exception:
        return False


# ---------------------------------------------------------------- 题库

def load_golden() -> list[dict]:
    if not GOLDEN.exists():
        raise SystemExit(f"[FAIL] 找不到题库：{GOLDEN}")
    items = []
    for n, line in enumerate(GOLDEN.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            items.append(json.loads(line))
        except Exception as e:
            raise SystemExit(f"[FAIL] 第 {n} 行不是合法 JSON：{e}")
    return items


# ---------------------------------------------------------------- 自检

def selftest() -> int:
    cases = [
        ("exact", "391", "391", True),
        ("exact", "391", " 391\n", True),
        ("exact", "391", "答案是 391", False),
        ("exact", "391", "391。", True),
        ("contains", "北京", "中国的首都是北京。", True),
        ("contains", "北京", "上海", False),
        ("regex", r"(?m)^-\s*苹果", "- 苹果\n- 香蕉", True),
        ("regex", r"(?i)select\s+\*\s+from\s+users", "SELECT * FROM users;", True),
        ("json_keys", ["a"], '{"a":1}', True),
        ("json_keys", ["a", "b"], '{"a":1}', False),
        ("json_keys", ["name", "arguments"], '```json\n{"name":"add","arguments":{}}\n```', True),
        ("json_keys", ["a"], '结果如下：{"a":1} 完毕', True),
        ("json_array", 3, '["a","b","c"]', True),
        ("json_array", 3, '["a","b"]', False),
        ("json_keys", ["a"], 'not json', False),
    ]
    ok = True
    print("=== selftest：判分器 ===")
    for kind, value, text, want in cases:
        got, why = check(kind, value, text)
        good = got == want
        ok &= good
        print(f"[{'OK ' if good else 'FAIL'}] {kind:<11} {str(value)[:18]:<18} "
              f"→ {got}" + ("" if good else f"（期望 {want}；{why}）"))

    # 题库自检：每条都能被解析，且 check 类型合法
    print("\n=== selftest：题库 ===")
    try:
        items = load_golden()
        valid = {"exact", "contains", "regex", "json_keys", "json_array"}
        bad = [i["id"] for i in items if i.get("check", {}).get("type") not in valid]
        dup = len(items) - len({i["id"] for i in items})
        print(f"[{'OK ' if not bad and not dup else 'FAIL'}] {len(items)} 题，"
              f"非法类型 {len(bad)}，重复 id {dup}")
        ok &= not bad and not dup
    except SystemExit as e:
        print(f"[FAIL] {e}")
        ok = False

    print("\n结果:", "全部通过" if ok else "存在失败项")
    return 0 if ok else 1


# ---------------------------------------------------------------- 主流程

def main() -> int:
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    ap = argparse.ArgumentParser(description="黄金评测集跑分器")
    ap.add_argument("--selftest", action="store_true", help="不联网，验证判分器与题库")
    ap.add_argument("--dry-run", action="store_true", help="只列出题库，不调模型")
    ap.add_argument("--cat", default=None, help="只跑指定类别，逗号分隔")
    ap.add_argument("--limit", type=int, default=0, help="最多跑几题")
    ap.add_argument("--baseline", default=None, help="与上一次的 results.csv 对比")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    items = load_golden()
    if args.cat:
        want = {c.strip() for c in args.cat.split(",") if c.strip()}
        items = [i for i in items if i.get("cat") in want]
    if args.limit:
        items = items[:args.limit]

    if args.dry_run:
        print(f"题库：{GOLDEN}  共 {len(items)} 题")
        for i in items:
            print(f"  {i['id']:<10} [{i['cat']}] {i['check']['type']:<10} {i['prompt'][:40]}")
        return 0

    if not health():
        print(f"[FAIL] 连不上 {BASE_URL}")
        print("       先启动引擎（python strata_guard.py --start）")
        return 1

    stamp = time.strftime("%Y%m%d-%H%M%S")
    outdir = OUT_DIR / stamp
    outdir.mkdir(parents=True, exist_ok=True)

    rows = []
    print(f"跑 {len(items)} 题，temp=0 seed={SEED} max_tokens={MAX_TOKENS}\n")
    for it in items:
        t0 = time.time()
        try:
            text = ask(it["prompt"])
            ok, why = check(it["check"]["type"], it["check"].get("value"), text)
        except SystemExit:
            raise
        except Exception as e:
            text, ok, why = "", False, f"请求异常: {e}"
        dt = time.time() - t0
        rows.append({"id": it["id"], "cat": it["cat"], "ok": ok,
                     "why": why, "sec": round(dt, 2), "answer": text[:300]})
        print(f"[{'PASS' if ok else 'FAIL'}] {it['id']:<10} {it['cat']:<6} "
              f"{dt:>5.1f}s  {'' if ok else why}")

    # 汇总
    by_cat: dict[str, list[bool]] = {}
    for r in rows:
        by_cat.setdefault(r["cat"], []).append(r["ok"])
    print("\n" + "-" * 50)
    for cat, oks in by_cat.items():
        print(f"{cat:<10} {sum(oks)}/{len(oks)}  {sum(oks)/len(oks):.0%}")
    total = sum(r["ok"] for r in rows)
    rate = total / len(rows) if rows else 0
    print("-" * 50)
    print(f"{'合计':<10} {total}/{len(rows)}  {rate:.0%}")

    csv = outdir / "results.csv"
    with csv.open("w", encoding="utf-8") as f:
        f.write("id,cat,ok,why,sec\n")
        for r in rows:
            f.write(f"{r['id']},{r['cat']},{int(r['ok'])},\"{r['why']}\",{r['sec']}\n")

    # 原文另存一份：失败时不用重跑就能看模型到底答了什么
    ans = outdir / "answers.jsonl"
    with ans.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    print(f"\n结果：{csv}")
    print(f"原文：{ans}")

    # 与基线对比
    if args.baseline and Path(args.baseline).exists():
        import csv as _csv
        prev = {}
        # 必须用 csv 解析：why 字段里可能出现逗号（如 missing=['a', 'b']），
        # 直接 split(",") 会错位。
        with Path(args.baseline).open(encoding="utf-8", newline="") as f:
            for row in _csv.DictReader(f):
                if row.get("id"):
                    prev[row["id"]] = row.get("ok") == "1"
        regress = [r["id"] for r in rows if prev.get(r["id"]) is True and not r["ok"]]
        gain = [r["id"] for r in rows if prev.get(r["id"]) is False and r["ok"]]
        print(f"对比基线：退步 {len(regress)} 题 {regress}；进步 {len(gain)} 题 {gain}")

    return 0 if rate >= 0.8 else 2


if __name__ == "__main__":
    sys.exit(main())
