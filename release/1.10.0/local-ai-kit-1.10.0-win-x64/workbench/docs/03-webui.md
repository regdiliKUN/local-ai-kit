# Strata WebUI

零依赖的本地对话界面。纯 Python 标准库 + 单文件 HTML，不装任何 pip 包，
不用任何前端框架或 CDN，**可完全离线运行**。

启动：`launchers\Strata-WebUI.bat` → 浏览器打开 `http://127.0.0.1:8090`

---

## 一、为什么自己写一个

已有的方案都不满足两个需求：**实时流式对话** 和 **文件夹上传**。

| | dsh 前端 | LocalAI 自带界面 | **本 WebUI** |
|---|---|---|---|
| 流式逐字输出 | ✅ | ✅ | ✅ |
| **选择/拖拽整个文件夹** | ❌ | ❌ | ✅ |
| 递归遍历子目录 | — | — | ✅ |
| 上下文用量估算 | — | — | ✅ |
| **提示词增强** | ❌ | ❌ | ✅ |
| **一键从断点继续** | ❌ | ❌ | ✅ |
| 零依赖 | — | — | ✅（纯标准库） |

> dsh 前端确实**没有**文件夹上传能力——扫描 `dsh-web-frontend/dist/assets/index-*.js`
> 得到 `webkitdirectory=0`、`showDirectoryPicker=0`、`webkitGetAsEntry=0`。
> 不过 dsh 有 `dsh-tool-fs`，能直接操作真实路径，比上传更强——所以两者是互补而非替代。

---

## 二、功能

### 实时流式对话

- `fetch` + `ReadableStream` 读取 SSE，按 `\n` 切分，`requestAnimationFrame` 节流渲染
- 思考链折叠显示（`reasoning_content` 单独收集）
- 随时点「停止」中断
- 底部实时显示：首字延迟 / 字符数 / 总耗时 / 字符每秒

### 文件夹上传

两种方式：

| 方式 | 实现 |
|---|---|
| 点「点击选择文件夹」 | `<input webkitdirectory directory multiple>` |
| 拖拽文件夹进来 | `webkitGetAsEntry()` 递归遍历 |

**递归遍历的坑**：`readEntries` 每次最多返回 100 条，必须循环调用直到返回空数组：

```javascript
const reader = entry.createReader();
while (true){
  const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
  if (!batch.length) break;
  for (const e of batch) await walkEntry(e, prefix + entry.name + '/', out);
}
```

**文件处理规则：**

| 规则 | 值 |
|---|---|
| 单文件读取上限 | 512 KB |
| 上下文总字符上限 | 420 K |
| 单次上传上限 | 2 GB |
| 单文件上传上限 | 256 MB |
| 自动识别为文本的扩展名 | 60+ 种（代码、配置、文档、字幕…） |

非文本或过大的文件会被标记为 `skip`，不参与上下文。

### 提示词增强（✨）

| 风格 | 行为 |
|---|---|
| **保守** | 只做清晰化：补全省略成分、消除歧义、修错别字。不添加你没提过的需求。长度控制在原文 1–1.5 倍 |
| **激进** | 扩写成结构化提示词：角色设定、任务目标、已知背景、约束条件、输出格式、验收标准。明确要求不捏造文件名和数据 |

- 候选 **1 / 2 / 3** 版，标签切换
- **左右差异对比**：字符级 LCS diff，新增绿色、删除红色
- **应用**：写入输入框（不直接发送，你可以再改）
- **撤销增强**：回到增强前的草稿
- 全程本地，不出网，不额外占显存

**实测延迟**（RTX 4090 / IQ2_XS）：保守 0.76s / 激进 2.44s / 三版 5.46s。

### 提示词模板库（📚）

16 个模板，分 4 类：代码、文档、分析、写作。

点击后**插到草稿前面**（因为模板文本以换行结尾，设计上就是「指令 + 你的内容」的结构）。
如果输入框里有选中文本，则替换选中部分。

### 一键继续（⏩）

每条回答下方的动作条里。回答被截断时点它，从断点无缝续写。

---

## 三、实现要点

### 1. 必须绕过系统代理

某些环境设了 `HTTP_PROXY`，会让访问 `127.0.0.1` 也被代理拦截，返回 502。

```python
_NO_PROXY_OPENER = urllib.request.build_opener(
    urllib.request.ProxyHandler({})
)
```

### 2. SSE 回传必须关连接

流式响应没有 `Content-Length`，如果不主动关闭连接，浏览器读流**永远不会结束**：

```python
self.close_connection = True
self.send_response(200)
self.send_header("Content-Type", "text/event-stream; charset=utf-8")
self.send_header("Connection", "close")
```

### 3. multipart 用标准库解析

不引入 `cgi` / `multipart` 等模块：

```python
from email.parser import BytesParser
from email.policy import default as email_policy

head = f"Content-Type: {ctype}\r\n\r\n".encode("utf-8", errors="ignore")
msg = BytesParser(policy=email_policy).parsebytes(head + raw)
for part in msg.iter_parts():
    filename = part.get_filename()
    data = part.get_payload(decode=True)
```

### 4. 路径穿越防护

上传的文件名来自浏览器，必须校验：

```python
rel = filename.replace("\\", "/").lstrip("/")
rel = os.path.normpath(rel).replace("\\", "/")
if rel.startswith("..") or os.path.isabs(rel):
    skipped.append({"path": filename, "reason": "非法路径"})
    continue
target = os.path.abspath(os.path.join(dest_root, rel))
if not target.startswith(os.path.abspath(dest_root)):
    skipped.append({"path": filename, "reason": "路径越界"})
    continue
```

文件夹名也做同样处理（`os.path.basename`）。

### 5. 增强调用必须无状态

增强请求**不读也不写** `state.history`。如果把它 push 进会话历史，
模型会把「改写指令」当成对话内容，下一轮回答直接跑偏。

### 6. 增强必须关掉思考链

```json
"chat_template_kwargs": {"enable_thinking": false}
```

Qwen3.8 默认先生成思考链。开着的话：既拖慢速度（3s+），又占 `max_tokens` 额度，
额度不够时 `content` 直接返回 `null`。实测关掉后降到 **0.2–1.0s**。

### 7. 续写用提示词法，不用原生参数

上游 `continue_final_message: true` + `add_generation_prompt: false` **未被支持**——
实测模型会**从头重写**。改用提示词法正确衔接：

```
紧接着上面的内容继续写下去。要求：
1. 直接从断点处续写，第一个字就是断点后的下一个字；
2. 不要重复上面已经出现过的任何内容；
3. 不要重新开头，不要加「好的」「以下是」之类的引导语；
4. 保持原有的格式与语气。
```

实测：

```
断点："...2. 下载模型权重\n3."      →  续写："运行模型"
断点："在标准大气压下，水的沸点是"  →  续写："100°C"
```

前端另有一层兜底 `dedupeTail()`：如果模型仍重复了尾部 ≥8 个字符，自动剥掉。

### 8. 多版本用一个流搞定

不是发 N 个请求，而是让模型用分隔符输出，服务端边流边切：

```python
keep = len(ENHANCE_DELIM) - 1     # 分隔符可能跨 chunk，留 13 字符在缓冲区
buf += text
while True:
    pos = buf.find(ENHANCE_DELIM)
    if pos >= 0:
        emit({"type": "delta", "i": idx, "text": buf[:pos]})
        buf = buf[pos + len(ENHANCE_DELIM):]
        idx += 1
        emit({"type": "variant", "i": idx})
        continue
    if len(buf) > keep:
        emit({"type": "delta", "i": idx, "text": buf[:-keep]})
        buf = buf[-keep:]
    break
```

---

## 四、接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/` | 单页应用 |
| `GET` | `/api/health` | 引擎连通性（探 `/v1/models`） |
| `GET` | `/api/uploads` | 已上传的文件夹列表 |
| `POST` | `/api/chat` | 流式对话代理（SSE 透传） |
| `POST` | `/api/enhance` | 提示词增强（SSE，事件见下） |
| `POST` | `/api/upload` | multipart 文件夹上传 |

### `/api/enhance` 的事件流

```
data: {"type":"start","style":"conservative","count":2}
data: {"type":"delta","i":0,"text":"请帮我分析"}
data: {"type":"variant","i":1}
data: {"type":"delta","i":1,"text":"角色：资深工程师…"}
data: {"type":"done","variants":2}
```

请求体：

```json
{ "draft": "帮我看下那个东西为啥不行", "style": "conservative", "count": 2 }
```

---

## 五、环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `STRATA_BASE_URL` | `http://127.0.0.1:8080/v1` | 引擎接口地址 |
| `STRATA_API_KEY` | `sk-local-qwen` | 本地密钥 |
| `STRATA_MODEL` | `qwen3.8-flash-next-iq2_xs` | 模型 id |
| `STRATA_WEB_HOST` | `127.0.0.1` | 监听地址 |
| `STRATA_WEB_PORT` | `8090` | 监听端口 |

启动器会从 `config\paths.bat` 自动填好这些值。

> `STRATA_WEB_HOST` 默认只绑回环地址。**不要改成 `0.0.0.0`**——
> 这个界面没有认证，暴露到局域网等于把本地模型开放给所有人。
