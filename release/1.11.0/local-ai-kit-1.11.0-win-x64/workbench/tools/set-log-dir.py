#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
set-log-dir.py -- 把 Strata 引擎自己的日志搬到别的位置

为什么需要单独的脚本
--------------------
启动器的日志（workbench.log / webui.log / install-strata.log）由
config\\paths.bat 里的 LOG_DIR 控制，改一处即可。

但**引擎自己的日志不受脚本控制**：serve/server.py 没有 --log 参数，
日志路径写死在 Strata 的配置文件里：

    STRATA_HOME\\strata-<profile>.json
        "log": "F:\\\\Strata\\\\strata-iq2_xs.log"

所以只能改这个 JSON 字段。本脚本负责改，并且自动备份。

用法
----
    python tools\\set-log-dir.py                    # 只看当前值和建议值
    python tools\\set-log-dir.py --apply            # 改到 LOG_DIR
    python tools\\set-log-dir.py --apply --dir "D:\\logs\\strata"
    python tools\\set-log-dir.py --restore          # 从最新备份还原

日志文件名保持不变（strata-<profile>.log），只换目录。
"""

import argparse
import datetime
import json
import os
import re
import shutil
import sys
from pathlib import Path

DEFAULT_LOG_DIR = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "strata-dsh-workbench" / "logs"


def say(msg=""):
    print(msg, flush=True)


def workbench_root() -> Path:
    """tools\\set-log-dir.py -> 仓库根目录"""
    return Path(__file__).resolve().parent.parent


def log_dir_from_paths_bat() -> Path:
    """
    从 config\\paths.bat 读 LOG_DIR。
    读不到就回退到默认目录。
    """
    cfg = workbench_root() / "config" / "paths.bat"
    if cfg.is_file():
        try:
            txt = cfg.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            txt = ""
        m = re.search(r'^\s*set\s+"LOG_DIR=([^"]*)"', txt, re.M)
        if m and m.group(1).strip():
            return Path(os.path.expandvars(m.group(1).strip()))
    return DEFAULT_LOG_DIR


def find_configs(explicit: str):
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


def current_log(cfg_path: Path):
    try:
        data = json.loads(cfg_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        say(f"  [ERROR] 读不了 {cfg_path}: {e}")
        return None
    return data.get("log")


def patch(cfg_path: Path, new_log: str, apply: bool):
    raw = cfg_path.read_text(encoding="utf-8")
    if not re.search(r'"log"\s*:', raw):
        say("  [ERROR] 配置里没有 \"log\" 字段，跳过。")
        return False

    new_raw, n = re.subn(
        r'("log"\s*:\s*")([^"]*)(")',
        # json.dumps 负责反斜杠和引号的转义，[1:-1] 去掉外层引号
        lambda m: m.group(1) + json.dumps(new_log)[1:-1] + m.group(3),
        raw,
    )
    if n == 0:
        say("  [ERROR] 替换失败，跳过。")
        return False
    if new_raw == raw:
        say("  - 值没变化，无需写入。")
        return False

    if not apply:
        say(f"  - 将改为: {new_log}")
        return True

    backup = cfg_path.with_name(
        cfg_path.name + ".bak-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    )
    shutil.copy2(cfg_path, backup)
    cfg_path.write_text(new_raw, encoding="utf-8")
    say(f"  - 已写入 {cfg_path.name}")
    say(f"  - 备份   {backup.name}")
    return True


def do_restore(configs):
    n = 0
    for cfg in configs:
        cands = sorted(cfg.parent.glob(cfg.name + ".bak-*"))
        if not cands:
            continue
        shutil.copy2(cands[-1], cfg)
        say(f"  已还原 {cfg.name}  <- {cands[-1].name}")
        n += 1
    say(f"\n{n} 个文件已还原。")
    return 0


def main():
    ap = argparse.ArgumentParser(description="把 Strata 引擎日志搬到指定目录")
    ap.add_argument("--apply", action="store_true", help="真正写入（默认只诊断）")
    ap.add_argument("--dir", help="目标日志目录；不给则用 config\\paths.bat 的 LOG_DIR")
    ap.add_argument("--config", help="指定 strata-*.json")
    ap.add_argument("--restore", action="store_true", help="从最新备份还原")
    args = ap.parse_args()

    say("=" * 64)
    say("  Strata 引擎日志  迁移")
    say("=" * 64)
    say()

    configs = find_configs(args.config)
    if not configs:
        say("[ERROR] 没找到 strata-*.json。用 --config 指定路径。")
        return 1

    if args.restore:
        return do_restore(configs)

    target_dir = Path(os.path.expandvars(args.dir)) if args.dir else log_dir_from_paths_bat()
    say(f"  目标目录 : {target_dir}")
    say(f"      （来自 {'--dir' if args.dir else 'config\\\\paths.bat 的 LOG_DIR'}）")
    say()

    if args.apply:
        try:
            target_dir.mkdir(parents=True, exist_ok=True)
            say(f"  目录已就绪。")
        except OSError as e:
            say(f"  [ERROR] 无法创建目录: {e}")
            return 1
    else:
        say("  （干跑，不会创建目录，也不会写文件）")
    say()

    changed = 0
    for cfg in configs:
        say(f"  [{cfg}]")
        cur = current_log(cfg)
        if cur is None:
            continue
        say(f"  - 当前: {cur}")

        cur_dir = os.path.dirname(cur)
        if os.path.normcase(os.path.abspath(cur_dir)) == os.path.normcase(os.path.abspath(str(target_dir))):
            say("  - 已经在目标目录里，无需修改。")
            say()
            continue

        # 文件名保持不变，只换目录
        fname = os.path.basename(cur) or f"strata-{cfg.stem.replace('strata-', '')}.log"
        new_log = str(target_dir / fname)
        if patch(cfg, new_log, args.apply):
            changed += 1
        say()

    if not args.apply:
        say("  这是干跑。确认无误后加 --apply 执行。")
    else:
        say(f"  完成，修改了 {changed} 个文件。重启引擎后生效。")
        say("  验证方法：启动引擎，确认新目录里出现了 strata-*.log")
    return 0


if __name__ == "__main__":
    sys.exit(main())
