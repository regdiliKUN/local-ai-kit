# strata-dsh-workbench

把 **Strata 推理引擎** 和 **DeepSeek Harness (dsh) Agent** 拼成一个开箱能用的本地 AI 工作台。

**模型层**用 Strata 跑 125B MoE（128K 上下文，实测 144–154 tok/s），**能力层**用 dsh 做文件读写、跑命令、子代理、工作流。两块拼起来，你在本机就有一个不联网、不花钱、能真正动文件的 AI。

> **这个仓库是什么**
> 集成层 + 一键部署工具 + 踩坑文档。包含配置模板、启动器、一个零依赖的 WebUI、以及本机实测过的调参结论。
>
> **这个仓库不是什么**
> 不包含 Strata 和 dsh 的源码（它们各自是独立开源项目，见 [第三方依赖](#第三方依赖)），也不包含模型权重。所有第三方代码都靠你自己 `git clone` / `npm install` 装。

---

## 目录

- [架构](#架构)
- [特性](#特性)
- [硬件要求](#硬件要求)
- [快速开始](#快速开始)
- [图形化菜单（推荐入口）](#图形化菜单推荐入口)
- [三个界面，什么时候用哪个](#三个界面什么时候用哪个)
- [提示词增强](#提示词增强)
- [必读：显存是这个方案唯一的硬约束](#必读显存是这个方案唯一的硬约束)
- [日志](#日志)
- [目录结构](#目录结构)
- [常见问题](#常见问题)
- [第三方依赖](#第三方依赖)

---

## 架构

```
┌──────────────────────────────────────────────────────────────┐
│  你                                                          │
└───────┬──────────────────────────────┬───────────────────────┘
        │                              │
        │  http://127.0.0.1:3080       │  http://127.0.0.1:8090
        ▼                              ▼
┌───────────────────────┐    ┌──────────────────────────────────┐
│  DeepSeek Harness     │    │  Strata WebUI  (本仓库)          │
│  Agent 工作台         │    │  实时对话 + 文件夹上传 + 提示词增强│
│  ─────────────────    │    │  ──────────────────────────────  │
│  读写文件 / 跑命令    │    │  零依赖，纯 Python 标准库         │
│  子代理 / 工作流      │    │                                  │
│  MCP / 技能 / 会话    │    │                                  │
└───────────┬───────────┘    └──────────────┬───────────────────┘
            │                               │
            │   OpenAI 兼容 /v1             │
            └───────────┬───────────────────┘
                        ▼
            ┌───────────────────────────┐
            │  Strata 推理引擎  :8080   │
            │  Qwen3.8-Flash-Next 125B  │
            │  MoE · 激活约 6B · 128K   │
            └───────────────────────────┘
```

两个前端都通过同一个 OpenAI 兼容接口调用 Strata。dsh 能调 Strata，反过来不行。

---

## 特性

| | |
|---|---|
| **一键启动** | 双击一个 bat，自动起引擎、轮询健康检查、再拉 dsh。带日志、超时保护和失败提示 |
| **图形化菜单** | `launchers\menu.ps1` —— 中文界面、分色分组、**实时显示引擎/WebUI/dsh 运行状态和显存空闲**，一个入口到达所有功能 |
| **路径自适应** | 唯一的配置文件 `config/paths.bat`，`setup.bat` 会自动探测并生成。装在非常规位置才需要手改 |
| **实时流式对话** | SSE 逐字输出，思考链可折叠，随时停止，带首字延迟和 tok/s 统计 |
| **文件夹上传** | 选整个目录或直接拖进来，递归遍历子目录，自动识别文本文件并估算上下文用量 |
| **提示词增强** | 用本地模型改写你的草稿。保守/激进两种风格，1–3 个候选版本，左右差异对比，可撤销 |
| **一键继续** | 回答被截断时从断点无缝续写（不是重新生成） |
| **提示词模板库** | 16 个常用模板，一键插到草稿前面 |
| **显存体检** | `tools/fix-vram-reserve.py` 自动量出桌面占用并修正 `--vram-reserve-mib` |
| **日志不落地** | 所有日志写到 `LOG_DIR`（默认 `%LOCALAPPDATA%\strata-dsh-workbench\logs`），**双击不会在桌面留垃圾**。可改路径，可设自动清理天数 |
| **环境自检** | `tools/verify.bat` 一次性检查路径、引擎、模型、dsh 集成、WebUI、日志共 6 大类 |
| **踩坑文档** | 每个问题都注明怎么确认、怎么修、以及为什么。见 [`docs/05-troubleshooting.md`](docs/05-troubleshooting.md) |
| **界面设计原型** | [`design/codex-switcher/`](design/codex-switcher/index.html) —— 高保真 Web 原型 + 完整设计规范，单文件零依赖 |

---

## 硬件要求

**实测环境**（本仓库所有数字都来自这台机器）：

| | |
|---|---|
| GPU | RTX 4090 24GB GDDR6X |
| CPU | i9-13900K（24 核 32 线程） |
| 内存 | 64GB DDR5 |
| 系统 | Windows 10 专业工作站版 19045 |
| 驱动 | 617.42 |

**最低门槛：**

| 项目 | 要求 | 说明 |
|---|---|---|
| 显存 | **≥ 16GB**，建议 24GB | 见下方「显存是硬约束」 |
| 内存 | ≥ 32GB，建议 64GB | 专家权重常驻在内存，靠 PCIe 流式喂给 GPU |
| 磁盘 | **≥ 120GB 空闲，且必须是 SSD** | IQ2_XS 权重约 68GB；机械盘上预填充会慢到不可用 |
| 系统 | Windows 10 1809+ / 11 | WSL2 和 Linux 也可以，但本文档的脚本只针对 Windows |
| Python | 3.10+ | 装 Strata 和跑 WebUI 用 |
| Node.js | 18+ | 跑 dsh 用 |

---

## 快速开始

### 0. 装两个上游项目（一次性）

```bat
:: Strata 引擎
git clone https://github.com/Niko1221/Strata F:\Strata

:: DeepSeek Harness
mkdir C:\Users\%USERNAME%\dsh-runtime && cd C:\Users\%USERNAME%\dsh-runtime
npm install @deepseek-ai/dsh
```

### 1. 拿到本仓库

```bat
git clone https://github.com/regdiliKUN/strata-dsh-workbench
cd strata-dsh-workbench
```

### 2. 配置

双击 **`setup.bat`**。它会：

1. 自动探测 Strata / dsh / Node / Python 的位置
2. 写出 `config\paths.bat`
3. 问你要不要建桌面快捷方式

探不到的项目，打开 `config\paths.bat` 手工改（文件里每一项都有注释）。**这是唯一需要你编辑的文件。**

### 3. 体检

```bat
tools\verify.bat
```

会逐项检查路径、引擎文件、模型权重、dsh 集成配置、WebUI 文件。有 `[FAIL]` 就先按提示修。

### 4. 装引擎和模型（如果还没装）

```bat
tools\install-strata.bat
```

下载约 68GB，用 hf-mirror 镜像。中途可以另开一个窗口跑 `tools\check-progress.bat` 看进度。

> 不要直接跑上游的 `setup.py`。它在权限受限的系统 Python 上会报 `PermissionError`。本仓库的包装脚本先用虚拟环境绕开了这个问题。

### 5. 启动

双击桌面上的 **`Strata + dsh Workbench`**。

它会先起引擎（首次加载 1–3 分钟），轮询 `/health` 直到就绪，再拉起 dsh。看到 `[OK] strata ready` 就成功了。

然后在 dsh 里打开 **Settings → Models**，选：

```
Strata Local (Qwen3.8-Flash-Next 125B MoE)
  └─ Qwen3.8-Flash-Next IQ2_XS (125B MoE, 128K)
```

> ⚠️ 别选 `qwen3.8:27b`——那是 Ollama 的模型，而这个启动器**只启动 Strata 不启动 Ollama**（两者显存加起来 38GB，超过 24GB 显存，物理上不能共存）。选错的症状是报 `socket stream idle timeout after 300000ms`。

---

## 图形化菜单（推荐入口）

双击 `launchers\menu.bat`，或桌面快捷方式。它长这样：

```
  ================================================================
                     本  地  A I  工  作  台
          Strata 125B MoE    +    DeepSeek Harness Agent
  ================================================================

   运行状态
     引擎 :8080 [运行中]   WebUI :8090 [未启动]   dsh :3080 [运行中]
     显存空闲 2752 MiB  ← 充足

   提示  引擎已就绪。要它动手干活选 [1]，只想聊天问问题选 [2]。

  ----------------------------------------------------------------
    启动
  ----------------------------------------------------------------
   [1]  启动工作台            引擎 + dsh Agent              打开 :3080
   [2]  启动 WebUI            对话 / 文件夹 / 提示词        打开 :8090
   [3]  只启动引擎            不开界面，供其它程序调用      :8080

  ----------------------------------------------------------------
    维护
  ----------------------------------------------------------------
   [4]  停止全部              关闭引擎和 WebUI
   [5]  显存体检              检查并修正显存预留            防 OOM 崩溃
   [6]  环境自检              路径 / 模型 / dsh 集成

  ----------------------------------------------------------------
    打开
  ----------------------------------------------------------------
   [7]  日志目录              排查问题时先看这里
   [8]  安装目录              Strata 引擎与模型所在
   [9]  其它 AI 快捷方式      DeepSeek / OpenCode 等

  ----------------------------------------------------------------
    帮助
  ----------------------------------------------------------------
   [H]  中文使用说明          完整文档，记事本打开
   [0]  退出

   输入序号后按回车。首次使用建议直接选 [1]。
```

**几个设计取舍：**

| 决定 | 原因 |
|---|---|
| **界面用 `.ps1` 而不是 `.bat`** | `.bat` 里的中文会被 cmd 按 ANSI 代码页解析成乱码命令。PowerShell 脚本存 UTF-8 BOM，中文没问题，还支持颜色和框线。PowerShell 是 Windows 自带的，不用装 |
| **`.bat` 只做启动器** | `menu.bat` 保持纯 ASCII，只负责 `powershell -File menu.ps1`，避开编码陷阱 |
| **实时状态检测** | 每次重画都探测 8080/8090/3080 端口，并读 `nvidia-smi` 的空闲显存。**显存低于 3GB 会变黄警告**——这是本方案最容易踩的坑 |
| **`$Home` 不能当变量名** | 它是 PowerShell 的只读自动变量，赋值会静默失败并让后续路径全错。代码里用 `$HomeRoot` |
| **按显示宽度补齐** | `.PadRight()` 按字符数算，中文占两列会导致三列错位。`Pad-Display()` 按东亚全角字符算 2 列 |
| **不改 `[Console]::OutputEncoding`** | `Write-Host` 走的是 Windows 控制台 Unicode 接口，本来就与代码页无关；改成 UTF-8 反而会在 936 控制台上乱码 |

**自适应两种位置**：脚本会自动判断自己在 `F:\本地AI\`（工作台根目录）还是 `<repo>\launchers\`，
并读取 `config\paths.bat` 覆盖默认路径。所以同一份文件两处都能用。

---

## 三个界面，什么时候用哪个

启动后你会看到两个端口在服务：

| 端口 | 界面 | 定位 | 适合 |
|---|---|---|---|
| **8080** | Strata 引擎自带聊天页 | **模型层**。纯推理，没有 Agent 能力，不保存会话 | 快速验证引擎是否正常、测参数 |
| **8090** | Strata WebUI（本仓库） | **交互层**。实时流式对话 + 文件夹投喂 + 提示词增强 | 长上下文问答、把整个文件夹丢进去让模型读、需要打字机效果和提示词打磨 |
| **3080** | dsh Agent 工作台 | **能力层**。能真正读写文件、跑命令、开子代理、跑工作流、连 MCP | 让它替你改代码、跑脚本、多步骤任务 |

**一句话选择：** 想让它**回答问题** → 用 8090；想让它**动手干活** → 用 3080。

---

## 提示词增强

在 WebUI 的输入框旁点 **✨**。

它用本地模型改写你自己的草稿，全程在本机完成，不出网，不额外占显存。

| | |
|---|---|
| **保守** | 只把话说清楚：补全省略的主语宾语、消除歧义、修错别字。**不添加你没提过的需求** |
| **激进** | 扩写成结构化提示词：自动补全角色设定、任务目标、已知背景、约束条件、输出格式、验收标准。会明确避免凭空捏造文件名和数据 |

其他能力：

- **1–3 个候选版本**，点标签切换
- **左右差异对比**：字符级 diff，新增绿色、删除红色
- **撤销增强**：一键回到你原来打的字
- **模板库（📚）**：16 个常用模板，插到草稿前面；有选中文本时替换选中部分

**实测延迟**（RTX 4090 / IQ2_XS）：保守单版 **0.76s**，激进单版 **2.44s**，激进三版 **5.46s**。

> 为什么这么快：增强请求带 `chat_template_kwargs.enable_thinking=false` 关掉了思考链。开着的话思考链会先跑一遍，单次要 3 秒以上。而且增强调用是**无状态**的——它不读写会话历史，所以不会污染主对话。

### 一键继续

每条回答下面有 **⏩ 继续**。回答被截断时点它，会**从断点无缝接上**，而不是重新生成。

实现方式：把已生成的内容作为 assistant 轮次喂回去，再补一条「直接从断点续写，第一个字就是断点后的下一个字，不要重复已出现的内容」的指令。实测两种截断场景都正确衔接：

```
断点："...2. 下载模型权重\n3."        →  续写："运行模型"
断点："在标准大气压下，水的沸点是"    →  续写："100°C"
```

前端还有一层兜底：如果模型仍然重复了尾部 ≥8 个字符，会自动剥掉。

---

## 必读：显存是这个方案唯一的硬约束

**这是本项目踩过的最大的坑，也是唯一会让整套方案彻底不可用的问题。**

### 症状

引擎跑着跑着没了、请求永远不返回、日志里出现 `out of memory`。

### 真相

> **报错里的 `out of memory` 几乎都不是系统内存不够，而是显存不够。**

Strata 的 `--vram-reserve-mib` 默认值是 **700 MiB**，这个默认值假设显卡是独占的。但 Windows 桌面上浏览器、聊天软件、Steam、录屏工具常驻就能吃掉 **约 2GB** 显存。

显存被缓存填满后，WDDM **不会报错**，而是把显存悄悄换页到系统内存。上游 `docs/DETAILS.md` 原文：

> …so the start looks normal, the banner still reports the slot count, and **only the speed collapses**.

结果是请求慢到永远跑不完，然后桌面下一次要显存时驱动把 GPU 内存挪到 RAM，**系统 OOM killer 结束进程**。

### 本机实测的完整证据链

```
# 引擎日志
strata serve: 342 MiB of VRAM free with everything loaded      <- 关键指标，太低了
strata serve: WARNING: only 434 MiB of VRAM free at the start of this request
              ... Add --vram-reserve-mib 1344 to the config's args
strata serve: WARNING: only   0 MiB of VRAM free at the start of this request

# 同期系统事件日志
03:19  RADAR_PRE_LEAK_64  on strata.exe           <- Windows 判定为内存泄漏
03:29  RADAR_PRE_LEAK_64  on strata-vision.exe
04:53  python.exe APPCRASH  0xc0000005            <- 服务进程崩溃

# 但系统内存全程宽裕
strata generate: memory guard: available 37.0 GiB, floor 2560 MiB
```

### 修法

```bat
python tools\fix-vram-reserve.py            :: 诊断，不改任何东西
python tools\fix-vram-reserve.py --apply    :: 写回配置（自动备份）
```

脚本读 `nvidia-smi` 量出桌面占用，按「桌面占用 + 1GB 余量，且不低于上游对『驱动桌面』推荐的 3072」算出合适值。

**实测效果：**

| | 修复前 | 修复后 |
|---|---|---|
| `VRAM free with everything loaded` | **342 MiB** | **2752 MiB** |
| 请求时的 VRAM 告警 | 4 条（最低 0 MiB） | **0 条** |
| `/health` 的 `loaded` | `false` | `true` |
| 生成速度 | 崩到不可用 | 53 → 114 tok/s |

### 一个容易误判的干扰项

日志里每次启动都会有：

```
strata generate: expert arena: cudaHostRegister of the whole arena FAILED (out of memory);
42 slices pinned (28 GiB) ... using 4 KB pages
```

**这个是正常的，不用管。** 上游 `docs/MULTI_GPU.md` 写明 Windows 的 WDDM 共享预算限制了一个进程最多锁多少主机内存，引擎会自动降级成「分片锁定 + 4KB 页」。这是设计好的退路。**别被它误导去找系统内存的问题。**

完整排查流程见 [`docs/05-troubleshooting.md`](docs/05-troubleshooting.md#a-引擎跑到一半没了--请求永远不返回--报-out-of-memory)。

---

## 目录结构

```
strata-dsh-workbench/
├── setup.bat                      ← 第一步：探测路径、写配置、建快捷方式
├── config/
│   ├── paths.example.bat          路径 + 日志目录模板（带完整注释）
│   ├── resolve.bat                加载配置 + 自动探测（启动器共用）
│   └── prune-logs.bat             清理过期日志
├── launchers/
│   ├── menu.ps1                   图形化菜单（中文 / 分色 / 实时状态）
│   ├── menu.bat                   菜单启动器（桌面图标指向它）
│   ├── Strata-dsh-Workbench.bat   命令行入口：引擎 + dsh
│   ├── Strata-WebUI.bat           只起 WebUI（8090）
│   ├── Start-Strata.bat           只起引擎（带端口占用检测）
│   ├── Stop-Strata.bat            按端口精确停进程
│   └── Strata-Folder-Agent.bat    命令行文件夹 Agent
├── webui/                         ← 零依赖 WebUI
│   ├── server.py                  静态服务 + SSE 代理 + 上传 + 增强
│   └── index.html                 单页应用（深色主题）
├── design/                        ← 独立的界面设计原型
│   ├── README.md                  怎么预览、设计约定
│   └── codex-switcher/
│       ├── index.html             Codex 切换器 高保真 Web 原型（单文件零依赖）
│       └── DESIGN.md              完整设计规范
├── tools/
│   ├── install-strata.bat         装引擎 + 下模型（绕过权限坑）
│   ├── check-progress.bat         下载进度监视
│   ├── verify.bat                 环境自检（6 大类）
│   ├── fix-vram-reserve.py        显存预留自动修正
│   ├── set-log-dir.py             把引擎日志搬到指定目录
│   ├── run-strata.bat             引擎启动封装（含显存预检）
│   ├── create-shortcuts.ps1       建桌面快捷方式
│   └── strata-folder-agent.py     零依赖文件夹 Agent
├── integrations/dsh/
│   ├── apply.py                   自动把 Strata 注入 dsh 配置（带备份/回滚）
│   ├── provider-snippet.yml       手工改的片段
│   ├── credentials-snippet.yaml   手工改的片段
│   └── README.md                  集成说明 + 验证方法
└── docs/
    ├── 01-hardware-and-model.md
    ├── 02-install-and-launch.md
    ├── 03-webui.md
    ├── 04-dsh-integration.md
    └── 05-troubleshooting.md      ← 出问题先看这个
```

---

## 日志

**所有日志默认写到 `%LOCALAPPDATA%\strata-dsh-workbench\logs`，不在脚本旁边生成。**
所以双击启动器不会在桌面留下 `.log` 文件。

| 日志 | 谁写的 | 路径由谁控制 |
|---|---|---|
| `workbench.log` | 引擎 + dsh 启动器 | `LOG_DIR` |
| `webui.log` | WebUI 启动器 | `LOG_DIR` |
| `install-strata.log` | 安装器 | `LOG_DIR` |
| `strata-<profile>.log` | **Strata 引擎自己** | Strata 配置 JSON 的 `"log"` 字段 |

### 改日志目录

编辑 `config\paths.bat`（没有就复制 `config\paths.example.bat`）：

```bat
REM 留空 = 用默认目录 %LOCALAPPDATA%\strata-dsh-workbench\logs
set "LOG_DIR=D:\logs\strata"
```

目录不存在会自动创建。想清理旧日志就设保留天数：

```bat
REM 0 = 永不删除
set "LOG_KEEP_DAYS=14"
```

启动器每次运行会调 `config\prune-logs.bat`，删掉 `LOG_DIR` 里超过这个天数的 `*.log`。

### 引擎日志要单独搬

`serve/server.py` **没有** `--log` 参数，引擎日志路径写死在 Strata 配置 JSON 里，
所以脚本改不到它。用这个工具搬：

```bat
python tools\set-log-dir.py            :: 先看当前值和目标值
python tools\set-log-dir.py --apply    :: 搬到 LOG_DIR（自动备份）
python tools\set-log-dir.py --apply --dir "D:\logs\strata"
python tools\set-log-dir.py --restore  :: 回滚
```

它只改 `"log"` 一个字段，其余配置原样保留。

### 检查日志配置

```bat
tools\verify.bat
```

第 6 节会报告 `LOG_DIR` 是否可用，第 7 节会显示引擎日志当前指向哪里。

---

## 常见问题

**Q：可以只用 WebUI，不装 dsh 吗？**
可以。`launchers\Strata-WebUI.bat` 只依赖 Strata 引擎和一个 Python，不需要 Node 和 dsh。

**Q：可以只用 dsh，不用 WebUI 吗？**
可以。跑 `launchers\Start-Strata.bat` 起引擎，然后单独起 dsh 就行。

**Q：能和 Ollama 同时跑吗？**
不能。实测 `ollama(23.2GB) + Strata(15GB) = 38GB > 24GB` 显存。两者按需切换，dsh 本身不占显存，切换引擎不用重启 dsh。

**Q：为什么不用 Ollama 跑这个模型？**
Qwen3.8-Flash-Next 是 125B MoE，Ollama/llama.cpp 跑不动这个规模。Strata 是专为分层调度和 MoE 稀疏激活写的 C++ 引擎，靠「专家常驻内存 + PCIe 流式喂 GPU」把 125B 塞进 24GB 显存。

**Q：`--vram-reserve-mib` 设多少合适？**
跑 `tools\fix-vram-reserve.py` 让它算。手工的话，**驱动桌面的卡用 3072**，独占的卡 700 够。

**Q：改完配置要重启什么？**
改 `config\paths.bat` → 重启启动器。改 `strata-*.json` → 重启引擎。改 dsh 配置 → 完全退出 dsh 再启动。

**Q：能装到别的盘吗？**
能，但**必须是 SSD**。`config\paths.bat` 里的 `STRATA_HOME` 和 `STRATA_DATA` 随便改。机械盘上预填充会慢到不可用。

---

## 第三方依赖

本仓库**不包含**任何第三方源代码。以下项目由你自行安装，各自遵循其原始许可：

| 项目 | 用途 | 许可 |
|---|---|---|
| [Niko1221/Strata](https://github.com/Niko1221/Strata) | C++ 推理引擎 | MIT |
| [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) | Agent 平台 | MIT |
| Qwen3.8-Flash-Next | 模型权重 | 版权归发布方，使用前请阅读上游许可 |

详细声明见 [`NOTICE.md`](NOTICE.md)。

---

## 许可

本仓库原创部分（配置、启动器、WebUI、文档）以 **MIT** 发布，见 [`LICENSE`](LICENSE)。
