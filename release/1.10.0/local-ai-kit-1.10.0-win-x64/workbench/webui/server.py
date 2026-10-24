#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Strata Chat WebUI - 本地实时对话 + 文件夹上传 + 提示词增强

纯 Python 标准库实现，零第三方依赖。

功能:
  1. 流式对话: 把浏览器请求转发给本地 Strata (OpenAI 兼容接口)，
     逐块 (SSE) 回传给前端，实现打字机式实时显示。
  2. 文件夹上传: 接收浏览器 multipart 上传的整个文件夹并落盘保存。
  3. 提示词增强: 用本地模型改写用户草稿。支持保守/激进两种风格，
     一次可生成 1-3 个候选版本。

启动:
  python server.py
  然后浏览器打开 http://127.0.0.1:8090
"""

import json
import os
import sys
import time
import mimetypes
import urllib.request
import urllib.error
from email.parser import BytesParser
from email.policy import default as email_policy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# 关键：绕过系统/环境代理，直连本机 Strata。
# 某些环境设置了 HTTP_PROXY，会导致访问 127.0.0.1 也被代理拦截。
_NO_PROXY_OPENER = urllib.request.build_opener(
    urllib.request.ProxyHandler({})
)

# ==================== 配置 ====================
STRATA_BASE = os.environ.get("STRATA_BASE_URL", "http://127.0.0.1:8080/v1")
STRATA_KEY = os.environ.get("STRATA_API_KEY", "sk-local-qwen")
WEB_HOST = os.environ.get("STRATA_WEB_HOST", "127.0.0.1")
WEB_PORT = int(os.environ.get("STRATA_WEB_PORT", "8090"))

WEB_ROOT = os.path.dirname(os.path.abspath(__file__))
UPLOAD_ROOT = os.path.join(WEB_ROOT, "uploads")

# 上传限制
MAX_UPLOAD_BYTES = 256 * 1024 * 1024  # 单次上传上限 256MB（原 2GB，会把进程撑爆）
MAX_FILE_BYTES = 256 * 1024 * 1024         # 单文件上限 256MB

# ---- 提示词增强 ----
ENHANCE_MODEL = os.environ.get("STRATA_MODEL", "qwen3.8-flash-next-iq2_xs")
ENHANCE_DELIM = "<<<VARIANT>>>"

# 保守：只做清晰化，不添加用户没说过的东西
ENHANCE_SYS_CONSERVATIVE = """你是一个提示词润色器。用户给你一段草稿，你的任务是把它改写得更清晰、更明确，但不得添加用户没有表达过的新需求。

规则：
1. 保留原意，只修正表达：补全省略的主语和宾语，消除歧义，纠正错别字与病句。
2. 不添加新的约束、角色设定、输出格式要求或背景信息。
3. 保持用户原本的语言（中文就回中文，英文就回英文）。
4. 长度控制在原文的 1 到 1.5 倍以内。
5. 只输出改写后的提示词本身。不要解释，不要加引号，不要写"改写后："之类的前缀，不要用 Markdown 代码块包裹。"""

# 激进：扩写成结构化提示词
ENHANCE_SYS_AGGRESSIVE = """你是一个提示词工程师。用户给你一段草稿，你的任务是把它扩写成一条结构化、信息完整的提示词。

规则：
1. 先判断任务类型（写代码、写文档、分析、问答、翻译、创意等），再按该类型补全要素。
2. 按需补充：角色设定、任务目标、已知背景、约束条件、输出格式、验收标准。
3. 只补充合理且通用的信息。绝对不要凭空捏造具体的文件名、数据、人名或业务事实。
4. 用简洁的分点结构组织，不要啰嗦，不要堆砌套话。
5. 保持用户原本的语言。
6. 只输出改写后的提示词本身。不要解释，不要加引号，不要写"改写后："之类的前缀，不要用 Markdown 代码块包裹。"""

ENHANCE_SYS = {
    "conservative": ENHANCE_SYS_CONSERVATIVE,
    "aggressive": ENHANCE_SYS_AGGRESSIVE,
}

# temperature：保守要可复现，激进允许一点发挥
ENHANCE_TEMP = {"conservative": 0.2, "aggressive": 0.45}
# =============================================


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "StrataWebUI/1.0"

    # ---------- 日志降噪 ----------
    def log_message(self, fmt, *args):
        pass  # 由我们自己的 log() 输出关键信息

    # ---------- 工具 ----------
    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_text(self, text, status=200, ctype="text/plain; charset=utf-8"):
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path):
        if not os.path.isfile(path):
            self._send_text("404 Not Found", 404)
            return
        ctype, _ = mimetypes.guess_type(path)
        if path.endswith((".html", ".htm")):
            ctype = "text/html; charset=utf-8"
        elif path.endswith((".js", ".mjs")):
            ctype = "application/javascript; charset=utf-8"
        elif path.endswith(".css"):
            ctype = "text/css; charset=utf-8"
        elif path.endswith(".json"):
            ctype = "application/json; charset=utf-8"
        ctype = ctype or "application/octet-stream"

        with open(path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    # ==================== GET ====================
    def do_GET(self):
        path = self.path.split("?", 1)[0]

        if path in ("/", "/index.html"):
            self._send_file(os.path.join(WEB_ROOT, "index.html"))
            return

        if path == "/api/health":
            self._handle_health()
            return

        if path == "/api/uploads":
            self._handle_list_uploads()
            return

        # 静态资源
        rel = path.lstrip("/")
        target = os.path.abspath(os.path.join(WEB_ROOT, rel))
        if target.startswith(os.path.abspath(WEB_ROOT)) and os.path.isfile(target):
            self._send_file(target)
            return

        self._send_text("404 Not Found", 404)

    def _handle_health(self):
        """检查本地 Strata 服务是否在线。"""
        url = STRATA_BASE.rstrip("/") + "/models"
        req = urllib.request.Request(
            url, headers={"Authorization": "Bearer " + STRATA_KEY}
        )
        try:
            with _NO_PROXY_OPENER.open(req, timeout=5) as r:
                ok = r.status == 200
            self._send_json({"strata": ok, "endpoint": STRATA_BASE})
        except Exception as e:
            self._send_json({"strata": False, "endpoint": STRATA_BASE, "error": str(e)})

    def _handle_list_uploads(self):
        """列出已上传的文件夹。"""
        items = []
        if os.path.isdir(UPLOAD_ROOT):
            for name in sorted(os.listdir(UPLOAD_ROOT)):
                full = os.path.join(UPLOAD_ROOT, name)
                if os.path.isdir(full):
                    count = 0
                    size = 0
                    for root, _, files in os.walk(full):
                        for f in files:
                            count += 1
                            try:
                                size += os.path.getsize(os.path.join(root, f))
                            except OSError:
                                pass
                    items.append({"name": name, "files": count, "bytes": size})
        self._send_json({"uploads": items})

    # ==================== POST ====================
    def do_POST(self):
        path = self.path.split("?", 1)[0]
        try:
            if path == "/api/chat":
                self._handle_chat()
            elif path == "/api/enhance":
                self._handle_enhance()
            elif path == "/api/upload":
                self._handle_upload()
            else:
                self._send_text("404 Not Found", 404)
        except (BrokenPipeError, ConnectionResetError):
            log("客户端断开连接")
        except Exception as e:
            import traceback
            traceback.print_exc()
            log(f"POST {path} 处理异常: {e}")
            try:
                self._send_json({"error": f"server error: {e}"}, 500)
            except Exception:
                pass

    # ---------- 核心 1: 流式对话代理 ----------
    def _handle_chat(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            self._send_json({"error": "empty body"}, 400)
            return

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception as e:
            self._send_json({"error": f"bad json: {e}"}, 400)
            return

        want_stream = bool(payload.get("stream", True))
        payload["stream"] = want_stream

        url = STRATA_BASE.rstrip("/") + "/chat/completions"
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + STRATA_KEY,
                "Accept": "text/event-stream" if want_stream else "application/json",
            },
            method="POST",
        )

        try:
            upstream = _NO_PROXY_OPENER.open(req, timeout=1800)
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", errors="ignore")
            except Exception:
                pass
            self._send_json(
                {"error": f"Strata HTTP {e.code}", "detail": detail[:800]}, 502
            )
            return
        except urllib.error.URLError as e:
            self._send_json(
                {
                    "error": "无法连接本地 Strata 服务",
                    "detail": f"{e.reason}。请先启动 Strata（桌面 Start Strata.bat）。",
                    "endpoint": url,
                },
                502,
            )
            return
        except Exception as e:
            self._send_json({"error": f"proxy error: {e}"}, 502)
            return

        if not want_stream:
            try:
                body = upstream.read()
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception as e:
                log(f"非流式回传失败: {e}")
            return

        # ---- 流式回传 ----
        # 注意：SSE 响应不设 Content-Length，也不做 chunked 编码，
        # 因此必须靠「关闭连接」来告诉浏览器流已结束，否则前端会一直挂起等待。
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        chunks = 0
        try:
            while True:
                line = upstream.readline()
                if not line:
                    break
                self.wfile.write(line)
                self.wfile.flush()
                chunks += 1
        except (BrokenPipeError, ConnectionResetError):
            log("客户端提前断开，停止转发")
        except Exception as e:
            log(f"流转发异常: {e}")
        finally:
            try:
                upstream.close()
            except Exception:
                pass
        log(f"流式对话结束，转发 {chunks} 行")

    # ---------- 核心 2: 文件夹上传 ----------
    def _handle_upload(self):
        ctype = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in ctype:
            self._send_json({"error": "需要 multipart/form-data"}, 400)
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            self._send_json({"error": "empty body"}, 400)
            return
        if length > MAX_UPLOAD_BYTES:
            self._send_json({"error": f"上传超过上限 {MAX_UPLOAD_BYTES} 字节"}, 413)
            return

        # 分块读：Content-Length 可能撒谎（声明的长度远大于实际发送量），
        # 一次性 read(length) 会先分配那么大的缓冲。这里边读边判上限。
        buf = bytearray()
        remaining = length
        while remaining > 0:
            chunk = self.rfile.read(min(65536, remaining))
            if not chunk:
                break
            buf.extend(chunk)
            remaining -= len(chunk)
            if len(buf) > MAX_UPLOAD_BYTES:
                self._send_json({"error": f"上传超过上限 {MAX_UPLOAD_BYTES} 字节"}, 413)
                return
        raw = bytes(buf)

        # 用 email 模块解析 multipart，纯标准库方案
        head = f"Content-Type: {ctype}\r\n\r\n".encode("utf-8", errors="ignore")
        try:
            msg = BytesParser(policy=email_policy).parsebytes(head + raw)
        except Exception as e:
            self._send_json({"error": f"multipart 解析失败: {e}"}, 400)
            return

        folder_name = None
        saved = []
        skipped = []

        for part in msg.iter_parts():
            disp = part.get("Content-Disposition", "")
            name = part.get_param("name", header="content-disposition") or ""
            filename = part.get_filename()

            if name == "folder":
                try:
                    folder_name = part.get_payload(decode=True).decode("utf-8").strip()
                except Exception:
                    folder_name = None
                continue

            if not filename:
                continue

            data = part.get_payload(decode=True) or b""
            if len(data) > MAX_FILE_BYTES:
                skipped.append({"path": filename, "reason": "文件过大"})
                continue

            saved.append((filename, data))

        if not folder_name:
            folder_name = "upload-" + time.strftime("%Y%m%d-%H%M%S")

        # 清洗文件夹名，防止路径穿越
        folder_name = os.path.basename(folder_name.replace("\\", "/").strip("/")) or "upload"
        dest_root = os.path.join(UPLOAD_ROOT, folder_name)

        written = 0
        for filename, data in saved:
            # 统一分隔符并做安全校验
            rel = filename.replace("\\", "/").lstrip("/")
            rel = os.path.normpath(rel).replace("\\", "/")
            if rel.startswith("..") or os.path.isabs(rel):
                skipped.append({"path": filename, "reason": "非法路径"})
                continue

            target = os.path.abspath(os.path.join(dest_root, rel))
            # 必须用 realpath + commonpath 判越界：
            # 原来用 startswith 做前缀比较，dest_root=E:\uploads 时
            # E:\uploads_evil\... 也会被当成"在目录内"。
            root_real = os.path.realpath(dest_root)
            target_real = os.path.realpath(target)
            try:
                inside = os.path.commonpath([root_real, target_real]) == root_real
            except ValueError:            # 不同盘符
                inside = False
            if not inside or target_real == root_real:
                skipped.append({"path": filename, "reason": "路径越界"})
                continue

            os.makedirs(os.path.dirname(target), exist_ok=True)
            try:
                with open(target, "wb") as f:
                    f.write(data)
                written += 1
            except Exception as e:
                skipped.append({"path": filename, "reason": str(e)})

        total_bytes = sum(len(d) for _, d in saved)
        log(f"上传完成: {folder_name} / {written} 个文件 / {total_bytes/1048576:.1f} MB")

        self._send_json(
            {
                "ok": True,
                "folder": folder_name,
                "saved": written,
                "skipped": skipped,
                "bytes": total_bytes,
                "path": dest_root,
            }
        )

    # ---------- 核心 3: 提示词增强 ----------
    #
    # 用本地模型改写用户草稿。整个调用是「无状态」的：
    # 它不读也不写会话历史，所以不会污染主对话。
    #
    # 为什么必须带 chat_template_kwargs.enable_thinking=False：
    # Qwen3.8 默认会先生成一段思考链。思考链既拖慢速度，又会占用
    # max_tokens 额度，额度不够时 content 会直接返回 null。
    # 实测关掉思考链后，单次改写从 3s+ 降到 0.2-1.0s。
    def _handle_enhance(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            self._send_json({"error": "empty body"}, 400)
            return

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception as e:
            self._send_json({"error": f"bad json: {e}"}, 400)
            return

        draft = (payload.get("draft") or "").strip()
        if not draft:
            self._send_json({"error": "草稿为空，请先输入内容"}, 400)
            return
        if len(draft) > 8000:
            draft = draft[:8000]

        style = payload.get("style") or "conservative"
        if style not in ENHANCE_SYS:
            style = "conservative"

        try:
            count = int(payload.get("count") or 1)
        except (TypeError, ValueError):
            count = 1
        count = max(1, min(3, count))

        user_text = "请改写下面这段草稿。"
        if count > 1:
            user_text += (
                f"\n\n请给出 {count} 个风格不同的改写版本，"
                f"版本之间用单独一行 {ENHANCE_DELIM} 分隔。"
                "每个版本都要完整独立，不要互相引用，不要在版本里写出这个分隔符。"
            )
        user_text += "\n\n草稿：\n" + draft

        body = {
            "model": ENHANCE_MODEL,
            "messages": [
                {"role": "system", "content": ENHANCE_SYS[style]},
                {"role": "user", "content": user_text},
            ],
            "stream": True,
            "temperature": ENHANCE_TEMP[style],
            "top_p": 0.9,
            "max_tokens": 1600,
            "chat_template_kwargs": {"enable_thinking": False},
        }

        url = STRATA_BASE.rstrip("/") + "/chat/completions"
        req = urllib.request.Request(
            url,
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + STRATA_KEY,
                "Accept": "text/event-stream",
            },
            method="POST",
        )

        try:
            upstream = _NO_PROXY_OPENER.open(req, timeout=600)
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", errors="ignore")
            except Exception:
                pass
            self._send_json({"error": f"Strata HTTP {e.code}", "detail": detail[:600]}, 502)
            return
        except Exception as e:
            self._send_json(
                {"error": "无法连接本地 Strata 服务", "detail": str(e)}, 502
            )
            return

        # ---- 回传：同样用 SSE，必须靠关连接收尾 ----
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        def emit(obj):
            self.wfile.write(
                ("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode("utf-8")
            )
            self.wfile.flush()

        try:
            emit({"type": "start", "style": style, "count": count})
        except (BrokenPipeError, ConnectionResetError):
            try:
                upstream.close()
            except Exception:
                pass
            return

        # 分隔符可能跨 chunk 到达，所以留 len(delim)-1 个字符在缓冲区里
        keep = len(ENHANCE_DELIM) - 1
        buf = ""
        idx = 0

        try:
            while True:
                line = upstream.readline()
                if not line:
                    break
                s = line.decode("utf-8", errors="ignore").strip()
                if not s.startswith("data:"):
                    continue
                data = s[5:].strip()
                if not data or data == "[DONE]":
                    continue
                try:
                    obj = json.loads(data)
                except Exception:
                    continue
                choices = obj.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}
                text = delta.get("content")
                if not text:
                    continue

                buf += text
                while True:
                    pos = buf.find(ENHANCE_DELIM)
                    if pos >= 0:
                        head = buf[:pos]
                        if head:
                            emit({"type": "delta", "i": idx, "text": head})
                        buf = buf[pos + len(ENHANCE_DELIM):]
                        idx += 1
                        emit({"type": "variant", "i": idx})
                        continue
                    if len(buf) > keep:
                        emit({"type": "delta", "i": idx, "text": buf[:-keep]})
                        buf = buf[-keep:]
                    break

            if buf:
                emit({"type": "delta", "i": idx, "text": buf})
            emit({"type": "done", "variants": idx + 1})
            log(f"提示词增强完成: {style} / {idx + 1} 版")

        except (BrokenPipeError, ConnectionResetError):
            log("客户端提前断开，增强流中止")
        except Exception as e:
            log(f"增强流转发异常: {e}")
            try:
                emit({"type": "error", "message": str(e)})
            except Exception:
                pass
        finally:
            try:
                upstream.close()
            except Exception:
                pass


def main():
    os.makedirs(UPLOAD_ROOT, exist_ok=True)
    log("=" * 58)
    log("  Strata Chat WebUI")
    log("=" * 58)
    log(f"  本地模型接口 : {STRATA_BASE}")
    log(f"  Web 界面     : http://{WEB_HOST}:{WEB_PORT}")
    log(f"  上传保存目录 : {UPLOAD_ROOT}")
    log("=" * 58)
    log("  提示: 请先启动 Strata（桌面 Start Strata.bat）")
    log("  按 Ctrl+C 停止本服务")
    log("")

    httpd = ThreadingHTTPServer((WEB_HOST, WEB_PORT), Handler)
    httpd.daemon_threads = True
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log("已停止。")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
