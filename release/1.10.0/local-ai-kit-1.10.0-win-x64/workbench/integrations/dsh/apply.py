#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
apply.py -- wire a local Strata engine into DeepSeek Harness (dsh).

WHY A TEXT PATCHER AND NOT A YAML PARSER
----------------------------------------
dsh's cordis.patch.yml contains custom YAML tags (!!js) and a lot of
plugin boilerplate. Loading it with PyYAML would either explode or
round-trip the file into something dsh no longer accepts. So this
script edits the file as TEXT, touching only the lines it needs.

WHAT IT DOES
------------
1. Adds a `strata-local` provider under the `llm-pi-ai` plugin's
   `config.providers` map in every dsh profile it finds.
2. Points `agent-default-model` at that provider (optional).
3. Adds STRATA_API_KEY to ~/.dsh/.credentials.yaml.
4. Backs up every file it touches before writing.

SAFE BY DEFAULT
---------------
Run without --apply to see a dry-run diff. Nothing is written.

USAGE
-----
    python apply.py                      # dry run, show what would change
    python apply.py --apply              # write changes (with backups)
    python apply.py --apply --no-default # do not touch agent-default-model
    python apply.py --restore            # roll back to the newest backup
    python apply.py --base-url http://127.0.0.1:8080/v1 --port 8080
"""

import argparse
import datetime
import os
import re
import shutil
import sys
from pathlib import Path

# ---------------------------------------------------------------- defaults
DEFAULT_BASE_URL = "http://127.0.0.1:8080/v1"
DEFAULT_API_KEY = "sk-local-qwen"
DEFAULT_API_KEY_ENV = "STRATA_API_KEY"
DEFAULT_PROVIDER_ID = "strata-local"
DEFAULT_DISPLAY = "Strata Local (Qwen3.8-Flash-Next 125B MoE)"
DEFAULT_MODEL_ID = "qwen3.8-flash-next-iq2_xs"
DEFAULT_MODEL_NAME = "Qwen3.8-Flash-Next IQ2_XS (125B MoE, 128K)"
DEFAULT_CONTEXT = 131072
DEFAULT_MAX_TOKENS = 32768

PROFILE_NAMES = ("web", "headless", "desktop")
STAMP = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")


# ---------------------------------------------------------------- helpers
def dsh_home() -> Path:
    env = os.environ.get("DSH_HOME")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".dsh"


def say(msg=""):
    print(msg, flush=True)


def find_profiles(home: Path):
    """Return existing profile directories that have a cordis.patch.yml."""
    root = home / "profiles"
    found = []
    if not root.is_dir():
        return found

    def is_backup(name: str) -> bool:
        # 跳过我们自己（和 dsh）留下的备份目录，例如
        # web.bak-20261014-191433
        return ".bak-" in name or name.endswith(".bak") or name.endswith(".backup")

    for name in PROFILE_NAMES:
        patch = root / name / "cordis.patch.yml"
        if patch.is_file():
            found.append(patch)
    # any other profile dir that happens to have a patch file
    for child in sorted(root.iterdir()):
        if not child.is_dir():
            continue
        if child.name in PROFILE_NAMES or is_backup(child.name):
            continue
        patch = child / "cordis.patch.yml"
        if patch.is_file():
            found.append(patch)
    return found


def provider_block(indent: str, cfg: dict) -> str:
    """Render the provider YAML fragment at the given indentation."""
    i = indent
    lines = [
        f"{i}{cfg['provider_id']}:",
        f"{i}  displayName: {cfg['display']}",
        f"{i}  apiKeyEnv: {cfg['api_key_env']}",
        f"{i}  api: openai-completions",
        f"{i}  baseURL: {cfg['base_url']}",
        f"{i}  models:",
        f"{i}    - id: {cfg['model_id']}",
        f"{i}      name: {cfg['model_name']}",
        f"{i}      contextWindow: {cfg['context']}",
        f"{i}      maxTokens: {cfg['max_tokens']}",
        f"{i}      input: [ text, image ]",
    ]
    return "\n".join(lines) + "\n"


def llm_plugin_block(cfg: dict) -> str:
    """Render a whole llm-pi-ai patch entry for profiles that lack one."""
    return (
        "- id: llm-pi-ai\n"
        "  name: '@deepseek-ai/dsh-llm-pi-ai'\n"
        "  config:\n"
        "    providers:\n"
        + provider_block("      ", cfg)
    )


def patch_cordis(text: str, cfg: dict, set_default: bool):
    """
    Returns (new_text, list_of_notes, changed_bool).
    """
    notes = []
    lines = text.split("\n")
    pid = cfg["provider_id"]

    # ---- locate the llm-pi-ai plugin block -------------------
    llm_start = None
    for idx, ln in enumerate(lines):
        if re.match(r"^\s*-\s*id:\s*llm-pi-ai\s*$", ln):
            llm_start = idx
            break

    changed = False
    if llm_start is None:
        # Some dsh builds keep the browser/Electron profile very small and do
        # not materialise llm-pi-ai in cordis.patch.yml. A valid id-targeted
        # patch entry can still be added; the loader merges it with the bundle.
        insert_at = 0
        for idx, ln in enumerate(lines):
            if re.match(r"^\s*-\s*id:\s*\S+", ln):
                insert_at = idx
                break
        block = llm_plugin_block(cfg).rstrip("\n").split("\n")
        lines[insert_at:insert_at] = block + [""]
        notes.append("added llm-pi-ai patch entry with Strata provider")
        changed = True
        llm_start = insert_at

    # block ends at the next top-level list item
    llm_end = len(lines)
    for idx in range(llm_start + 1, len(lines)):
        if re.match(r"^\s*-\s*id:\s*\S+", lines[idx]) and \
           len(lines[idx]) - len(lines[idx].lstrip()) == 0:
            llm_end = idx
            break

    # ---- find `providers:` inside that block -----------------
    prov_idx = None
    prov_indent = 0
    for idx in range(llm_start, llm_end):
        m = re.match(r"^(\s*)providers:\s*$", lines[idx])
        if m:
            prov_idx = idx
            prov_indent = len(m.group(1))
            break
    if prov_idx is None:
        return text, ["`providers:` map not found under llm-pi-ai"], False

    child_indent = " " * (prov_indent + 2)

    # ---- is our provider already there? ----------------------
    existing = None
    for idx in range(prov_idx + 1, llm_end):
        if re.match(rf"^{re.escape(child_indent)}{re.escape(pid)}:\s*$", lines[idx]):
            existing = idx
            break

    if existing is not None:
        # replace until the next key at the same indent
        stop = llm_end
        for idx in range(existing + 1, llm_end):
            if re.match(rf"^{re.escape(child_indent)}\S", lines[idx]):
                stop = idx
                break
        block = provider_block(child_indent, cfg).rstrip("\n").split("\n")
        lines[existing:stop] = block
        notes.append(f"replaced existing `{pid}` provider")
        changed = True
    else:
        # insert right after `providers:`
        block = provider_block(child_indent, cfg).rstrip("\n").split("\n")
        lines[prov_idx + 1:prov_idx + 1] = block
        notes.append(f"added `{pid}` provider")
        changed = True

    # ---- optionally repoint agent-default-model --------------
    if set_default:
        for idx, ln in enumerate(lines):
            if re.match(r"^\s*-\s*id:\s*agent-default-model\s*$", ln):
                for j in range(idx, min(idx + 8, len(lines))):
                    if re.match(r"^\s*provider:\s*\S+", lines[j]):
                        indent = lines[j][: len(lines[j]) - len(lines[j].lstrip())]
                        lines[j] = f"{indent}provider: {pid}"
                        if j + 1 < len(lines) and re.match(r"^\s*model:\s*\S+", lines[j + 1]):
                            lines[j + 1] = f"{indent}model: {cfg['model_id']}"
                        notes.append("agent-default-model now points at Strata")
                        break
                break

    return "\n".join(lines), notes, changed


def patch_credentials(text: str, cfg: dict):
    """Ensure the api key exists in the refs: section."""
    lines = text.split("\n")
    key = cfg["api_key_env"]

    for idx, ln in enumerate(lines):
        if re.match(rf"^\s*{re.escape(key)}\s*:", ln):
            indent = ln[: len(ln) - len(ln.lstrip())]
            lines[idx] = f"{indent}{key}: {cfg['api_key']}"
            return "\n".join(lines), [f"{key} updated"], True

    refs_idx = None
    for idx, ln in enumerate(lines):
        if re.match(r"^refs:\s*$", ln):
            refs_idx = idx
            break

    if refs_idx is None:
        if lines and lines[-1].strip() != "":
            lines.append("")
        lines.append("refs:")
        refs_idx = len(lines) - 1
        lines.append(f"  {key}: {cfg['api_key']}")
        return "\n".join(lines), ["created refs: section", f"{key} added"], True

    # insert before the next top-level key
    insert_at = len(lines)
    for idx in range(refs_idx + 1, len(lines)):
        if re.match(r"^\S", lines[idx]) and lines[idx].strip():
            insert_at = idx
            break
    lines.insert(insert_at, f"  {key}: {cfg['api_key']}")
    return "\n".join(lines), [f"{key} added"], True


def backup(path: Path) -> Path:
    dest = path.with_name(path.name + f".bak-{STAMP}")
    shutil.copy2(path, dest)
    return dest


def do_restore(home: Path):
    restored = 0
    for target in list(find_profiles(home)) + [home / ".credentials.yaml"]:
        parent = target.parent
        if not parent.is_dir():
            continue
        cands = sorted(parent.glob(target.name + ".bak-*"))
        if not cands:
            continue
        newest = cands[-1]
        shutil.copy2(newest, target)
        say(f"  restored {target.name} from {newest.name}")
        restored += 1
    say(f"\n{restored} file(s) restored.")
    return 0


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description="Wire Strata into DeepSeek Harness")
    ap.add_argument("--apply", action="store_true", help="actually write changes")
    ap.add_argument("--restore", action="store_true", help="roll back to newest backups")
    ap.add_argument("--no-default", action="store_true",
                    help="do not repoint agent-default-model")
    ap.add_argument("--base-url", default=DEFAULT_BASE_URL)
    ap.add_argument("--api-key", default=DEFAULT_API_KEY)
    ap.add_argument("--provider-id", default=DEFAULT_PROVIDER_ID)
    ap.add_argument("--model-id", default=DEFAULT_MODEL_ID)
    ap.add_argument("--model-name", default=DEFAULT_MODEL_NAME)
    ap.add_argument("--display", default=DEFAULT_DISPLAY)
    ap.add_argument("--context", type=int, default=DEFAULT_CONTEXT)
    ap.add_argument("--max-tokens", type=int, default=DEFAULT_MAX_TOKENS)
    args = ap.parse_args()

    home = dsh_home()
    say("=" * 62)
    say("  Strata  ->  DeepSeek Harness   integration")
    say("=" * 62)
    say(f"  dsh home   : {home}")
    say(f"  base URL   : {args.base_url}")
    say(f"  provider   : {args.provider_id}")
    say(f"  model      : {args.model_id}")
    say("")

    if not home.is_dir():
        say(f"[ERROR] dsh home not found: {home}")
        say("        Install DeepSeek Harness first, or set DSH_HOME.")
        return 1

    if args.restore:
        return do_restore(home)

    cfg = {
        "provider_id": args.provider_id,
        "display": args.display,
        "api_key_env": DEFAULT_API_KEY_ENV,
        "base_url": args.base_url,
        "model_id": args.model_id,
        "model_name": args.model_name,
        "context": args.context,
        "max_tokens": args.max_tokens,
        "api_key": args.api_key,
    }

    profiles = find_profiles(home)
    if not profiles:
        say("[ERROR] no cordis.patch.yml found under profiles\\")
        say("        Is DeepSeek Harness initialised? Try running `dsh web` once.")
        return 1

    say(f"  profiles   : {', '.join(p.parent.name for p in profiles)}")
    say("")
    if not args.apply:
        say("  DRY RUN -- nothing will be written. Add --apply to commit.")
        say("")

    pending = []          # (path, new_text, notes)

    for patch in profiles:
        original = patch.read_text(encoding="utf-8", errors="surrogateescape")
        new_text, notes, changed = patch_cordis(
            original, cfg, set_default=not args.no_default
        )
        say(f"  [{patch.parent.name}] {patch}")
        for n in notes:
            say(f"      - {n}")
        if not changed:
            say("      - no change")
        if changed:
            pending.append((patch, new_text))

    cred = home / ".credentials.yaml"
    if cred.is_file():
        original = cred.read_text(encoding="utf-8", errors="surrogateescape")
        new_text, notes, changed = patch_credentials(original, cfg)
        say(f"  [credentials] {cred}")
        for n in notes:
            say(f"      - {n}")
        if changed:
            pending.append((cred, new_text))
    else:
        say(f"  [credentials] not found at {cred} -- skipped")

    say("")
    if not pending:
        say("  Nothing to do.")
        return 0

    if not args.apply:
        say("  Dry run finished. Re-run with --apply to write.")
        return 0

    for path, new_text in pending:
        b = backup(path)
        path.write_text(new_text, encoding="utf-8", errors="surrogateescape")
        say(f"  written : {path.name}")
        say(f"  backup  : {b.name}")

    say("")
    say("  Done. Restart dsh, then pick the Strata entry in Settings - Models.")
    say("  Roll back any time with:  python apply.py --restore")
    return 0


if __name__ == "__main__":
    sys.exit(main())
