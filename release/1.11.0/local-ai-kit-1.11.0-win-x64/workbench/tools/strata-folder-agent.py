#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Strata Folder Agent - 轻量本地文件夹 AI 助手（零第三方依赖）

用法:
    python strata_folder_agent.py [文件夹路径]

功能:
    - 读取指定文件夹内的文本文件
    - 把内容发给本地 Strata 模型分析
    - 支持让模型生成文件修改建议，并确认后写入

只使用 Python 标准库，不需要安装任何第三方包。
"""

import json
import os
import sys
import urllib.request
import urllib.error

# ============ 配置区 ============
API_BASE = os.environ.get("STRATA_BASE_URL", "http://127.0.0.1:8080/v1")
API_KEY = os.environ.get("STRATA_API_KEY", "sk-local-qwen")
MODEL = os.environ.get("STRATA_MODEL", "qwen3.8-flash-next-iq2_xs")

# 要读取的文本文件扩展名
TEXT_EXTS = {
    ".txt", ".md", ".py", ".js", ".ts", ".jsx", ".tsx", ".json", ".yaml", ".yml",
    ".toml", ".ini", ".cfg", ".html", ".css", ".scss", ".vue", ".java", ".c",
    ".cpp", ".h", ".hpp", ".cs", ".go", ".rs", ".rb", ".php", ".sh", ".bat",
    ".ps1", ".sql", ".xml", ".csv", ".log", ".env", ".gitignore",
}

# 跳过的目录
SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", "env",
    "dist", "build", ".idea", ".vscode", ".next", "target", "bin", "obj",
    ".mypy_cache", ".pytest_cache", "coverage", ".cache",
}

# 单个文件最大读取字节数（防止超大文件撑爆上下文）
MAX_FILE_BYTES = 200 * 1024

# 一次最多读取的文件数
MAX_FILES = 60
# ================================


def log(msg):
    print(msg, flush=True)


def collect_files(root):
    """遍历文件夹，收集文本文件。"""
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for name in filenames:
            ext = os.path.splitext(name)[1].lower()
            if ext in TEXT_EXTS or name in ("Dockerfile", "Makefile", "README"):
                full = os.path.join(dirpath, name)
                try:
                    size = os.path.getsize(full)
                except OSError:
                    continue
                if size == 0 or size > MAX_FILE_BYTES * 4:
                    continue
                found.append((full, size))
    found.sort(key=lambda x: x[1])
    return found


def read_file(path):
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            return f.read()
    except Exception as e:
        return f"<读取失败: {e}>"


def build_context(root, files):
    """把文件内容拼成上下文。"""
    parts = []
    total = 0
    for full, size in files[:MAX_FILES]:
        rel = os.path.relpath(full, root)
        content = read_file(full)
        if len(content.encode("utf-8", errors="ignore")) > MAX_FILE_BYTES:
            content = content[:MAX_FILE_BYTES] + "\n...<已截断>"
        block = f"\n\n===== FILE: {rel} =====\n{content}"
        total += len(block)
        # 粗略控制上下文规模，约 30 万字符
        if total > 300000:
            parts.append("\n\n...<文件过多，已截断其余文件>")
            break
        parts.append(block)
    return "".join(parts)


def call_api(messages, stream=False):
    """调用 OpenAI 兼容接口。"""
    url = API_BASE.rstrip("/") + "/chat/completions"
    payload = {
        "model": MODEL,
        "messages": messages,
        "stream": False,
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + API_KEY,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            body = resp.read().decode("utf-8", errors="ignore")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"HTTP {e.code}: {detail[:500]}")
    except urllib.error.URLError as e:
        raise RuntimeError(
            f"无法连接 {url}\n原因: {e.reason}\n"
            f"请确认已双击运行桌面上的 Start Strata.bat，且 http://127.0.0.1:8080 可以打开。"
        )
    obj = json.loads(body)
    if "choices" in obj:
        return obj["choices"][0]["message"]["content"]
    return body


def health_check():
    url = API_BASE.rstrip("/") + "/models"
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + API_KEY})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status == 200
    except Exception:
        return False


def interactive(root, context):
    log("")
    log("=" * 60)
    log("  Strata Folder Agent 已就绪")
    log("=" * 60)
    log(f"  文件夹: {root}")
    log(f"  接口:   {API_BASE}")
    log(f"  模型:   {MODEL}")
    log("")
    log("  直接输入问题，例如：")
    log("    - 这个项目是做什么的？怎么运行？")
    log("    - 找出代码里的 bug")
    log("    - 帮我重写 README")
    log("  命令：/files 重新扫描 | /context 查看已读文件数 | /exit 退出")
    log("")

    history = [
        {
            "role": "system",
            "content": (
                "你是一个本地代码助手。下面提供了用户指定文件夹中的文件内容。"
                "请基于这些内容回答问题。如果用户要求修改文件，"
                "请用如下格式给出完整的新文件内容：\n"
                "```file:相对路径\n<完整新内容>\n```\n"
                "不要编造不存在的文件。"
            ),
        },
        {
            "role": "user",
            "content": f"这是我文件夹 {root} 的内容：{context}",
        },
    ]

    while True:
        try:
            q = input("\n>>> ").strip()
        except (EOFError, KeyboardInterrupt):
            log("\n已退出。")
            break

        if not q:
            continue
        if q in ("/exit", "/quit", "exit", "quit"):
            log("已退出。")
            break
        if q == "/context":
            log(f"已载入约 {len(context)} 字符的文件夹上下文。")
            continue
        if q == "/files":
            log("重新扫描中...")
            continue

        history.append({"role": "user", "content": q})
        log("\n[思考中... 首次请求可能较慢]")
        try:
            answer = call_api(history)
        except RuntimeError as e:
            log(f"\n[错误] {e}")
            history.pop()
            continue

        history.append({"role": "assistant", "content": answer})
        log("\n" + answer)

        # 检测文件写入块
        if "```file:" in answer:
            log("\n[检测到文件修改建议]")
            apply = input("是否应用这些修改？(y/N): ").strip().lower()
            if apply == "y":
                apply_file_blocks(root, answer)


def apply_file_blocks(root, text):
    """从回答中提取 ```file:路径 ... ``` 块并写入。"""
    lines = text.split("\n")
    i = 0
    count = 0
    while i < len(lines):
        line = lines[i].strip()
        if line.startswith("```file:"):
            rel = line[len("```file:"):].strip().rstrip("`").strip()
            buf = []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            target = os.path.join(root, rel)
            target = os.path.abspath(target)
            # 安全检查：不能写到文件夹外
            if not target.startswith(os.path.abspath(root)):
                log(f"  [跳过] 路径越界: {rel}")
                i += 1
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "w", encoding="utf-8") as f:
                f.write("\n".join(buf))
            log(f"  [已写入] {rel}")
            count += 1
        i += 1
    if count == 0:
        log("  (未解析到可写入的文件块)")


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else input("请输入文件夹路径: ").strip().strip('"')
    root = os.path.abspath(root)

    if not os.path.isdir(root):
        log(f"[错误] 不是有效文件夹: {root}")
        sys.exit(1)

    log(f"正在扫描: {root}")
    files = collect_files(root)
    log(f"发现 {len(files)} 个文本文件，载入前 {min(len(files), MAX_FILES)} 个。")

    if not files:
        log("[警告] 没有找到可读文本文件。")

    if not health_check():
        log("")
        log("[警告] 无法连接 Strata 服务。")
        log("请先双击桌面上的 Start Strata.bat 启动服务，再运行本脚本。")
        log("仍要继续尝试吗？(y/N): ")
        if input().strip().lower() != "y":
            sys.exit(1)

    context = build_context(root, files)
    interactive(root, context)


if __name__ == "__main__":
    main()
