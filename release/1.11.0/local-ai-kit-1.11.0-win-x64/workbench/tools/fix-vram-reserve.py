#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fix-vram-reserve.py -- 修正 Strata 配置里的 --vram-reserve-mib

问题
----
Strata 的默认 `--vram-reserve-mib` 是 700 MiB。这个默认值假设显卡是
"独占"的。如果同一块卡还要驱动桌面（Windows 上几乎所有情况），桌面本身
就会常驻占用 1.5-2.5 GB 显存，700 MiB 根本不够。

后果（上游文档 DETAILS.md / AMD_HIP.md 明确写过）：
  * WDDM 下超额分配不会报错，而是把显存悄悄换页到系统内存
    —— "启动看起来正常，只是速度崩掉"
  * 显存被缓存填满后，桌面下一次要显存时驱动会把 GPU 内存挪到系统 RAM，
    系统的 OOM killer 随即结束进程
  * 引擎日志里的典型症状：
        strata serve: 342 MiB of VRAM free with everything loaded
        strata serve: WARNING: only 0 MiB of VRAM free at the start of this request
                      ... Add --vram-reserve-mib 1728 to the config's args

本脚本做什么
------------
1. 读 nvidia-smi，量出"桌面当前占了多少显存"
2. 按「桌面占用 + 安全余量」算出应该预留多少
3. 写回 strata-<profile>.json 的 --vram-reserve-mib（先备份）

用法
----
    python fix-vram-reserve.py                 # 只诊断，不改
    python fix-vram-reserve.py --apply         # 写回配置
    python fix-vram-reserve.py --apply --min 4096
    python fix-vram-reserve.py --config "F:\\Strata\\strata-iq2_xs.json"
"""

import argparse
import datetime
import json
import locale
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

# 桌面占用的基础上再多留这么多，给 WDDM / 驱动 / 突发分配留余量
HEADROOM_MIB = 1024
# 上游文档给"显卡同时驱动桌面"的推荐值
DOC_RECOMMENDED = 3072
# 无论怎么算，不低于这个值
HARD_FLOOR = 2048
# 预留超过这个值就没有意义了 —— 与其预留 6GB，不如去关掉抢显存的程序
HARD_CEILING = 6144


def say(msg=""):
    print(msg, flush=True)


def run_text(cmd, timeout=20):
    """
    跑一个命令并返回它的输出文本。

    注意：中文 Windows 上 netstat / tasklist 输出的是 GBK，直接按 UTF-8
    解码会抛 UnicodeDecodeError。所以这里逐种编码尝试，最后兜底 latin-1。
    我们只关心进程名和端口号这些 ASCII 部分，乱码不影响判断。
    """
    try:
        p = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return None
    if p.returncode != 0:
        return None
    for enc in ("utf-8", locale.getpreferredencoding(False), "gbk", "latin-1"):
        if not enc:
            continue
        try:
            return p.stdout.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return p.stdout.decode("latin-1", errors="replace")


def nvidia_smi():
    """返回 (total_mib, used_mib, free_mib) 或 None。"""
    text = run_text(
        ["nvidia-smi",
         "--query-gpu=memory.total,memory.used,memory.free",
         "--format=csv,noheader,nounits"]
    )
    if not text:
        say("[WARN] 调用 nvidia-smi 失败或没输出。")
        return None
    line = text.strip().splitlines()
    if not line:
        return None
    parts = [p.strip() for p in line[0].split(",")]
    if len(parts) < 3:
        return None
    try:
        return int(parts[0]), int(parts[1]), int(parts[2])
    except ValueError:
        return None


def engine_running(port):
    """
    判断 Strata 引擎是否正在运行。

    这一步是必须的：引擎自己会占掉十几 GB 显存，如果它正在跑，
    nvidia-smi 报的 used 里就包含了它。拿这个数去算"桌面占用"会得出
    荒谬的结论（比如建议预留 8.6 GB）。
    """
    # 1) 端口是否有人监听
    text = run_text(["netstat", "-ano"])
    if text:
        for line in text.splitlines():
            if "LISTENING" in line and f":{port} " in line:
                return True, f"端口 {port} 正在被监听"

    # 2) 进程名
    text = run_text(["tasklist"])
    if text:
        for line in text.splitlines():
            low = line.lower()
            if low.startswith("strata.exe") or low.startswith("strata-vision.exe"):
                return True, f"发现进程 {line.split()[0]}"

    return False, ""


def find_configs(explicit):
    if explicit:
        return [Path(explicit)]
    env_home = os.environ.get("STRATA_HOME")
    roots = []
    if env_home:
        roots.append(Path(env_home))
    roots += [Path("F:/Strata"), Path("E:/Strata"), Path("D:/Strata"), Path("C:/Strata")]
    found = []
    for r in roots:
        if r.is_dir():
            found += sorted(r.glob("strata-*.json"))
    return found


def current_reserve(cfg_path):
    try:
        raw = cfg_path.read_text(encoding="utf-8")
    except OSError as e:
        say(f"[ERROR] 读不了 {cfg_path}: {e}")
        return None, None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        say(f"[ERROR] {cfg_path.name} 不是合法 JSON: {e}")
        return None, None

    args = data.get("args") or []
    for i, a in enumerate(args):
        if a == "--vram-reserve-mib" and i + 1 < len(args):
            try:
                return int(args[i + 1]), data
            except ValueError:
                return None, data
        m = re.match(r"^--vram-reserve-mib=(\d+)$", str(a))
        if m:
            return int(m.group(1)), data
    return None, data


def write_reserve(cfg_path, data, value):
    """按文本方式改写，尽量不动其它字段的排版。"""
    raw = cfg_path.read_text(encoding="utf-8")
    new_raw, n = re.subn(
        r'("--vram-reserve-mib"\s*,\s*")(\d+)(")',
        lambda m: m.group(1) + str(value) + m.group(3),
        raw,
    )
    if n == 0:
        # 配置里原本没有这个参数，追加到 args 数组末尾
        new_raw = re.sub(
            r'("args"\s*:\s*\[)',
            r'\1\n  "--vram-reserve-mib",\n  "%d",' % value,
            raw, count=1,
        )
        n = 1
    if new_raw == raw and n:
        say("      (值未变化，无需写入)")
        return False
    backup = cfg_path.with_name(cfg_path.name + ".bak-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))
    shutil.copy2(cfg_path, backup)
    cfg_path.write_text(new_raw, encoding="utf-8")
    say(f"      已写入  {cfg_path}")
    say(f"      备份    {backup.name}")
    return True


def main():
    ap = argparse.ArgumentParser(description="修正 Strata 的 --vram-reserve-mib")
    ap.add_argument("--apply", action="store_true", help="真正写入（默认只诊断）")
    ap.add_argument("--config", help="指定 strata-*.json；不给则自动搜索")
    ap.add_argument("--port", type=int, default=8080, help="引擎端口，用于判断它是否在运行")
    ap.add_argument("--min", type=int, default=0, help="强制一个下限")
    ap.add_argument("--assume-desktop", type=int, default=0, metavar="MIB",
                    help="引擎在跑时，手工指定桌面实际占用（跳过自动测量）")
    args = ap.parse_args()

    say("=" * 64)
    say("  Strata  --vram-reserve-mib  诊断")
    say("=" * 64)
    say()

    gpu = nvidia_smi()
    if not gpu:
        say("[ERROR] 读不到显卡信息，无法计算。请确认 nvidia-smi 可用。")
        return 1
    total, used, free = gpu
    say(f"  显存总量      : {total} MiB")
    say(f"  当前已用      : {used} MiB")
    say(f"  当前空闲      : {free} MiB")
    say()

    running, why = engine_running(args.port)
    if running:
        say(f"  [WARN] Strata 引擎正在运行（{why}）。")
        say(f"         引擎自己就占十几 GB，nvidia-smi 报的 {used} MiB 里包含它。")
        say(f"         直接拿这个数当『桌面占用』会严重高估。")
        say()
        if args.assume_desktop:
            desktop = args.assume_desktop
            say(f"         使用你指定的桌面占用：{desktop} MiB")
        else:
            desktop = None
            say(f"         回退到上游文档对『驱动桌面』的推荐值：{DOC_RECOMMENDED} MiB")
            say(f"         想要精确值：先  launchers\\Stop-Strata.bat  停掉引擎，再跑本脚本。")
    else:
        desktop = used
        say("  引擎未运行，所以『当前已用』就是桌面占用。")

    say()
    if desktop is None:
        suggest = DOC_RECOMMENDED
    else:
        suggest = max(desktop + HEADROOM_MIB, DOC_RECOMMENDED, HARD_FLOOR)
        if suggest > HARD_CEILING:
            say(f"  [WARN] 桌面占用 {desktop} MiB 偏高，计算值已收敛到上限 {HARD_CEILING} MiB。")
            say("         再往上预留就没意义了 —— 与其预留这么多，不如关掉抢显存的程序。")
            suggest = HARD_CEILING
    if args.min:
        suggest = max(suggest, args.min)

    say(f"  建议预留      : {suggest} MiB")
    if desktop is not None:
        say(f"      (= 桌面占用 {desktop} + 余量 {HEADROOM_MIB}，"
            f"下限取上游对『驱动桌面』的推荐 {DOC_RECOMMENDED})")
    say()

    configs = find_configs(args.config)
    if not configs:
        say("[ERROR] 没找到 strata-*.json。用 --config 指定路径。")
        return 1

    changed = 0
    for cfg in configs:
        say(f"  [{cfg}]")
        cur, data = current_reserve(cfg)
        if data is None:
            continue
        if cur is None:
            say("      - 配置里没有 --vram-reserve-mib（使用引擎默认 700）")
        else:
            say(f"      - 当前值 {cur} MiB")
            if cur >= suggest:
                say(f"      - 已经 >= 建议值 {suggest}，无需修改")
                continue
            if cur >= DOC_RECOMMENDED:
                say("      - 已达到上游对桌面场景的推荐值，通常够用")
        if args.apply:
            if write_reserve(cfg, data, suggest):
                changed += 1
        else:
            say(f"      - 将改为 {suggest} MiB（加 --apply 才会写入）")
        say()

    if not args.apply:
        say("  这是干跑。确认无误后加 --apply 执行。")
    else:
        say(f"  完成，修改了 {changed} 个文件。重启引擎后生效。")
        say("  验证方法：看启动日志里这一行，数字应明显大于 1024 ——")
        say("      strata serve: NNNN MiB of VRAM free with everything loaded")
    return 0


if __name__ == "__main__":
    sys.exit(main())
