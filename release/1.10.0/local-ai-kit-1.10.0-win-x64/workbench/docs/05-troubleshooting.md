# 故障排查

按症状索引。每条都注明**怎么确认**和**怎么修**，不写没验证过的猜测。

- [A. 引擎跑到一半没了 / 请求永远不返回 / 报 out of memory](#a-引擎跑到一半没了--请求永远不返回--报-out-of-memory)
- [B. 双击 bat 窗口闪退](#b-双击-bat-窗口闪退)
- [C. 浏览器一直转圈，回答不结束](#c-浏览器一直转圈回答不结束)
- [D. 模型返回空内容](#d-模型返回空内容)
- [E. dsh 报 socket stream idle timeout](#e-dsh-报-socket-stream-idle-timeout)
- [F. 上传文件夹失败](#f-上传文件夹失败)
- [G. 装不上 / 装到一半报权限错误](#g-装不上--装到一半报权限错误)
- [H. dsh 模型选择器里看不到本地模型](#h-dsh-模型选择器里看不到本地模型)

---

## A. 引擎跑到一半没了 / 请求永远不返回 / 报 out of memory

**这是本仓库记录过的最严重、也最容易误判的问题。**

### 先说结论

> 报错信息里的 `out of memory` **几乎都不是系统内存不够，而是显存（VRAM）不够**。
> 根因是 `--vram-reserve-mib` 用了默认值 700，而这块卡同时还在驱动桌面。

### 怎么确认

打开 `STRATA_HOME\strata-<profile>.log`，搜这几行：

```bat
findstr /c:"VRAM free with everything loaded" "%STRATA_HOME%\strata-iq2_xs.log"
findstr /c:"of VRAM free at the start"        "%STRATA_HOME%\strata-iq2_xs.log"
findstr /c:"cudaHostRegister"                 "%STRATA_HOME%\strata-iq2_xs.log"
```

**真实案例（RTX 4090 24GB，Win10，引擎 IQ2_XS / 128K 上下文）：**

```
strata serve: 342 MiB of VRAM free with everything loaded
strata serve: WARNING: only 434 MiB of VRAM free at the start of this request (below 1024 MiB):
              ... Add --vram-reserve-mib 1344 to the config's args, or lower --max-context / --batch
strata serve: WARNING: only 274 MiB of VRAM free ...
strata serve: WARNING: only  58 MiB of VRAM free ...
strata serve: WARNING: only   0 MiB of VRAM free at the start of this request ...
strata verify: capturing the 6-token window (0 MiB of VRAM free)
```

同时系统事件日志里能看到：

| 时间 | 事件 | 含义 |
|---|---|---|
| 03:19 | `RADAR_PRE_LEAK_64` on `strata.exe` | Windows 资源耗尽检测器把引擎标记为疑似泄漏 |
| 03:29 | `RADAR_PRE_LEAK_64` on `strata-vision.exe` | 同上，视觉进程 |
| 04:53 | `python.exe` APPCRASH，`0xc0000005` | 服务进程访问违规，直接崩掉 |

查事件日志：

```powershell
Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=(Get-Date).AddHours(-8)} |
  Where-Object { $_.Message -match 'strata|python' } |
  Select-Object TimeCreated, Id, ProviderName, @{n='Msg';e={($_.Message -split "`r?`n")[0]}}
```

### 为什么是显存，不是内存

日志里 `memory guard` 那行会告诉你系统内存的真实状况：

```
strata generate: memory guard: limit 63.7 GiB, current 26.7 GiB, available 37.0 GiB, floor 2560 MiB
```

`available` 全程在 **28–43 GiB** 之间——系统内存一直很宽裕。**卡的是显存。**

### 根因（上游文档原文）

`docs/DETAILS.md`：

> The expert cache size is a budget, and on Windows an over-sized one pages instead of failing.
> … **Under WDDM an allocation is not resident until it is touched**, and the free figure read
> before it can be about a gigabyte too high, and **the driver's default sysmem fallback puts an
> over-committed allocation in system memory instead of failing** — so the start looks normal,
> the banner still reports the slot count, and **only the speed collapses**.

`docs/AMD_HIP.md`：

> **The card also drives a desktop:** keep more VRAM free than the default 700 MiB, e.g.
> `--vram-reserve-mib 3072`. With the cache filling the card, the desktop's next VRAM need makes
> the driver move GPU memory to system RAM … **the OOM killer then ends apps**.

翻译成人话：

1. 默认 `--vram-reserve-mib 700` 假设显卡是独占的。
2. 但 Windows 桌面上浏览器、聊天软件、Steam、录屏工具常驻就吃掉 2 GB 左右。
3. 显存被缓存填满后，WDDM **不报错**，而是把显存偷偷换页到系统内存。
4. 结果是「启动看起来正常，只是速度崩掉」——请求慢到永远跑不完。
5. 桌面下一次要显存时，驱动把 GPU 内存挪到 RAM，系统 OOM killer 结束进程。

### 修法

**一步到位：**

```bat
python tools\fix-vram-reserve.py            :: 先看诊断，不改任何东西
python tools\fix-vram-reserve.py --apply    :: 确认后写回配置（自动备份）
```

脚本会读 `nvidia-smi` 量出桌面当前占用，按「桌面占用 + 1 GB 余量，且不低于上游推荐的 3072」算出合适值。

**手工改：** 编辑 `STRATA_HOME\strata-<profile>.json`，把

```json
  "--vram-reserve-mib",
  "700",
```

改成

```json
  "--vram-reserve-mib",
  "3072",
```

**本机实测效果：**

| | 修复前 | 修复后 |
|---|---|---|
| `VRAM free with everything loaded` | **342 MiB** | **2752 MiB** |
| 请求开始时的 VRAM 告警 | 4 条（最低 0 MiB） | **0 条** |
| `/health` 的 `loaded` | `false` | `true` |
| 生成速度 | 崩到不可用 | 53 → 114 tok/s |

### 还有哪些办法腾显存

按性价比排序：

1. **提高 `--vram-reserve-mib`**（首选，代价最小）
2. **关掉抢显存的桌面程序**：浏览器多标签、Electron 聊天客户端、Steam、录屏/直播工具、设计软件。实测这台机器上桌面常驻就有约 2 GB。
3. **降 `--kv-resident`**：`32768` → `16384`，牺牲长上下文复用速度换显存。
4. **降 `--max-context`**：`131072` → `65536`。KV 缓存是显存大户。
5. **降 `--prefill`**：引擎日志会建议 `--prefill auto:8192`，更小的 prompt 分块借用更少的缓存槽。
6. **确认 Ollama 没在跑**：`ollama(23.2GB) + Strata(15GB) = 38GB > 24GB`，两者物理上不可能同时加载。

### 一个容易误判的干扰项

日志里每次启动都会有这一行：

```
strata generate: expert arena: locked 4426 MiB via working-set minimum + VirtualLock;
cudaHostRegister of the whole arena FAILED (out of memory); 42 slices pinned (28 GiB);
large pages refused for 35456548864 B ...; using 4 KB pages
```

**这个 `out of memory` 是正常的，不用管。** 上游 `docs/MULTI_GPU.md` 写明：

> Under WDDM (Windows, and WSL2) only 8 GiB of the expert arena is pinned …
> `STRATA_ARENA_PIN_GIB=N` pins at most N GiB

Windows 的 WDDM 共享预算限制了一个进程最多锁多少主机内存，引擎会自动降级成「分片锁定 28 GiB + 4 KB 页」，这是设计好的退路，不影响功能。**别被它误导去找系统内存的问题。**

---

## B. 双击 bat 窗口闪退

### 根因

`.bat` 文件里含**中文**（UTF-8 字节），Windows cmd 按 ANSI 代码页（GBK）解析，中文变成乱码命令。

`chcp 65001` **救不了**——cmd 在 chcp 生效之前就已经按当前代码页解析完整行了。

### 确认

读字节，统计 `>127` 的数量，必须是 0：

```powershell
$b = [IO.File]::ReadAllBytes("你的脚本.bat")
($b | Where-Object { $_ -gt 127 }).Count
```

### 修法

**铁律：`.bat` / `.cmd` 内容必须纯 ASCII，行尾 CRLF。**
中文只允许出现在**文件名**里，绝不允许出现在**内容**里。

本仓库所有 `.bat` 都已按此规则校验过。

---

## C. 浏览器一直转圈，回答不结束

流式响应（`text/event-stream`）没有 `Content-Length`，如果服务端不关闭连接，浏览器会一直等下去。

`webui/server.py` 已经处理：

```python
self.close_connection = True
self.send_response(200)
self.send_header("Content-Type", "text/event-stream; charset=utf-8")
self.send_header("Connection", "close")
```

如果你自己改了代理逻辑，注意别把这行删了。

---

## D. 模型返回空内容

`content` 是 `null`，或只有 `reasoning_content`。

**原因**：`max_tokens` 太小，被思考链吃光了。

**修法**：加大 `max_tokens`（实测 200 以上正常），或者关掉思考链：

```json
"chat_template_kwargs": {"enable_thinking": false}
```

本仓库的提示词增强和「继续」功能都用了这个开关——实测单次改写从 3s+ 降到 **0.2–1.0s**。

---

## E. dsh 报 socket stream idle timeout

```
socket stream idle timeout after 300000ms
```

**原因**：你在 dsh 里选的是 `qwen3.8:27b`（Ollama 模型），但启动器只启动了 Strata，Ollama 没跑。

**修法**：在 dsh 的 **Settings → Models** 里切到：

```
Strata Local (Qwen3.8-Flash-Next 125B MoE)
  └─ Qwen3.8-Flash-Next IQ2_XS (125B MoE, 128K)
```

配置方法见 [`integrations/dsh/README.md`](../integrations/dsh/README.md)。

---

## F. 上传文件夹失败

| 症状 | 原因 | 修法 |
|---|---|---|
| 选择文件夹后列表为空 | 浏览器不支持 `webkitdirectory` | 用 Chrome / Edge |
| 部分文件被跳过 | 非文本类型，或单文件超 256 MB | 正常行为，见上传结果里的 `skipped` |
| 上传后找不到文件 | 落盘在 `webui/uploads/<文件夹名>/` | 看接口返回的 `path` 字段 |
| 大文件夹卡住 | 单次上限 2 GB | 分批上传 |

服务端限制在 `webui/server.py` 顶部：

```python
MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024   # 单次 2GB
MAX_FILE_BYTES   = 256 * 1024 * 1024        # 单文件 256MB
```

---

## G. 装不上 / 装到一半报权限错误

```
PermissionError: [Errno 13] Permission denied: 'C:\Python314\.strata-pip.json'
```

**原因**：上游 `setup.py` 直接调用系统 Python，而系统 Python 装在只读目录。

**修法**：本仓库的 `tools\install-strata.bat` 已经绕过了这个问题——它先在 `STRATA_HOME\.venv` 建虚拟环境，再用虚拟环境的解释器跑 `setup.py`。**用它装，不要直接跑上游的安装脚本。**

---

## H. dsh 模型选择器里看不到本地模型

**症状**：dsh 的模型下拉里只有 `DeepSeek-V41-Flash` / `DeepSeek-V4-Pro`，没有 `Strata 本地`；发消息还报：

```
no API key for provider route "deepseek-official"
```

### 根因：改错 profile

dsh 的配置是**按 profile 分开**的，不同启动方式读不同文件：

| 启动方式 | 读的 profile |
|---|---|
| `dsh web`（`127.0.0.1:3080`） | `~/.dsh/profiles/web/cordis.patch.yml` |
| `dsh --profile headless ...` | `~/.dsh/profiles/headless/cordis.patch.yml` |
| DeepSeek Harness 桌面应用（Electron） | `~/.dsh/profiles/desktop/cordis.patch.yml` |

早期只往 `web` / `headless` 里写 `strata-local`，**`desktop` 里没有 `llm-pi-ai` 条目**。桌面版一启动，模型选择器里就只剩官方 DeepSeek 那一组，默认模型也还是 `deepseek-official`。

> 注意：`desktop` 档里的 `llm-pi-ai` 是**整段缺失**，不是缩进错。所以"检查缩进"这条路查不出来——要去确认这个键在不在。

### 怎么确认

**第 1 步：确认 dsh 读的是哪个 profile。**

```powershell
Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
  Where-Object { $_.CommandLine -match 'dsh' } |
  Select-Object ProcessId, CommandLine
```

命令行里是 `... bin.js web` → `web`；是桌面应用 → `desktop`。

**第 2 步：确认那个 profile 里有没有 provider。**

```powershell
Select-String -Path "$HOME\.dsh\profiles\desktop\cordis.patch.yml" -Pattern 'llm-pi-ai|strata-local'
```

两条都搜到才算配置在位。

**第 3 步（可选，最硬的证据）：直接问后端要模型目录。**

这一步绕开 UI，直接看 dsh 真正注册了哪些 provider。先从 `dsh web` 的启动输出里拿到带 `?token=` 的地址，然后：

```powershell
$token = '<启动输出里的 token>'
$s = New-Object Microsoft.PowerShell.Commands.WebRequestSession
Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:3080/?token=$token" -WebSession $s | Out-Null
$cookie = ($s.Cookies.GetCookies('http://127.0.0.1:3080') | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join '; '

$rpc  = [guid]::NewGuid().ToString()
$body = @{ type='client-request'; rpcId=$rpc; method='session/modelCatalog'; payload=@{ args=@{} } } |
        ConvertTo-Json -Compress -Depth 6
$tmp  = Join-Path $env:TEMP 'dsh_rpc.json'
[IO.File]::WriteAllText($tmp, $body, (New-Object Text.UTF8Encoding($false)))

curl.exe -s -H "content-type: application/json" -H "cookie: $cookie" --data-binary "@$tmp" `
  http://127.0.0.1:3080/api/session/modelCatalog
```

返回的 JSON 里看两个字段：

```json
"default":           { "provider": "strata-local", "model": "qwen3.8-flash-next-iq2_xs" },
"routableProviders": [ "deepseek-official", "ollama-local", "strata-local", ... ]
```

- `routableProviders` 里有 `strata-local` → 后端没问题，是**前端页面缓存**或**旧会话**的问题
- 没有 `strata-local` → 配置没被加载，回到第 2 步

> 两个容易卡住的点：`payload` 必须写成 `{"args":{}}`，写成 `{}` 会返回
> `Remote payload must contain exactly one plain-object args field`；
> 不带 cookie 会返回 `401 unauthorized`（这个 cookie 由 `?token=` 那一步种下）。

### 修法

```bat
python integrations\dsh\apply.py            :: 先看会改哪些文件
python integrations\dsh\apply.py --apply    :: 写入（自动备份）
```

脚本会遍历 `profiles\` 下所有 profile，缺 `llm-pi-ai` 条目的整段补上，并把 `agent-default-model` 指向 `strata-local`。

然后：

1. **完全退出 dsh**（含托盘 / 关掉那个命令行窗口），再启动。配置只在启动时读。
2. **新开一个会话**。旧会话里存着 `model/selection` 事件，会继续用它当时选中的 `deepseek-official`，改默认值不会影响已存在的会话。
3. 还看不到就按 `Ctrl + F5` 强刷页面。

### 顺带说明

`no API key for provider route "deepseek-official"` 这个报错本身不是密钥丢了，而是**会话钉在了官方路由上**。修好 provider 后把会话切到 `strata-local` 即可；如果还想用官方 DeepSeek，再单独补 `DEEPSEEK_API_KEY`。

---

## 附：一条命令收集诊断信息

出问题时把下面这些贴出来，足够定位绝大多数问题：

```bat
@echo off
echo ===== GPU =====
nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free --format=csv
echo ===== 引擎日志关键行 =====
findstr /c:"VRAM free" /c:"memory guard" /c:"cudaHostRegister" /c:"expert arena" "%STRATA_HOME%\strata-iq2_xs.log"
echo ===== 端口 =====
netstat -ano | findstr ":8080 :8090"
```
