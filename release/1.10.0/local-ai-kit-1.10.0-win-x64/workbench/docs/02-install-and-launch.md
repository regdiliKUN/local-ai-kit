# 安装与启动

## 一、前置依赖

| 依赖 | 版本 | 用途 | 检查命令 |
|---|---|---|---|
| Python | 3.10+ | 装 Strata、跑 WebUI | `python --version` |
| Node.js | 18+ | 跑 dsh | `node --version` |
| git | 任意 | 拉取仓库 | `git --version` |
| NVIDIA 驱动 | 580+ | CUDA 13 引擎需要 | `nvidia-smi` |

> 驱动低于 580 的话，上游支持用 CUDA 12 引擎（`--cuda 12`），需要 528+。见上游 `docs/OLDER_GPUS.md`。

---

## 二、安装两个上游项目

### 1. Strata 引擎

```bat
git clone https://github.com/Niko1221/Strata F:\Strata
```

> **必须装在 SSD 上。** 机械盘上预填充会慢到不可用。默认路径是 `F:\Strata`，
> 装在别处就在 `config\paths.bat` 里改 `STRATA_HOME`。

### 2. DeepSeek Harness

```bat
mkdir C:\Users\%USERNAME%\dsh-runtime
cd C:\Users\%USERNAME%\dsh-runtime
npm install @deepseek-ai/dsh
```

装完后目录里应该有 `node_modules\@deepseek-ai\dsh\lib\bin.js`。
没有这个文件就说明装错了位置，`setup.bat` 会探测失败。

---

## 三、配置本仓库

```bat
git clone https://github.com/regdiliKUN/strata-dsh-workbench
cd strata-dsh-workbench
setup.bat
```

`setup.bat` 会做三件事：

1. **自动探测** Strata / dsh / Node / Python 的位置，按以下顺序尝试：

   | 项目 | 探测顺序 |
   |---|---|
   | Strata | `config\paths.bat` → `..\Strata` → `F:\E:\D:\C:\Strata` → `%USERPROFILE%\Strata` → 常见 AI 目录 |
   | Strata 数据 | `F:\E:\D:\C:\Strata-data` → `%USERPROFILE%\Strata-data` |
   | dsh | `%USERPROFILE%\dsh-runtime` → `%LOCALAPPDATA%\dsh-runtime` → `%APPDATA%\npm` |
   | Node | PATH → `%ProgramFiles%\nodejs` → nvm 目录 |
   | Python | `STRATA_HOME\.venv` → `py -3` → 常见安装位置 |

2. **写出 `config\paths.bat`**（已存在时会问你要不要覆盖）
3. **问你要不要建桌面快捷方式**

探不到的项目会标 `[WARN]`，你打开 `config\paths.bat` 手工补上即可。
**这是唯一需要编辑的文件**，每一项都有注释。

### 路径配置项

| 变量 | 含义 | 校验方式 |
|---|---|---|
| `STRATA_HOME` | Strata 源码目录 | 必须含 `serve\server.py` |
| `STRATA_DATA` | 模型数据目录 | 必须含 `models\` |
| `STRATA_PROFILE` | 用哪个量化规格 | `iq2_xs` / `iq3_s` / `iq3_xxs` / `q2_0` |
| `DSH_DIR` | dsh 运行时（安装）目录 | 必须含 `node_modules\@deepseek-ai\dsh\lib\bin.js`；**不要写成 `DSH_HOME`**，那是 dsh 自己的状态目录变量 |
| `NODE_EXE` | Node 可执行文件 | 留 `node` 走 PATH |
| `PYTHON_EXE` | Python 可执行文件 | 留空自动探测 |
| `STRATA_PORT` | 引擎端口 | 默认 8080 |
| `WEB_PORT` | WebUI 端口 | 默认 8090 |
| `STRATA_API_KEY` | 本地密钥 | 必须与 `strata-<profile>.json` 里的 `api_key` 一致 |

> `config\paths.bat` 已被 `.gitignore` 排除，你的本地路径不会离开这台机器。

---

## 四、安装引擎与模型

```bat
tools\install-strata.bat
```

**为什么需要这个包装脚本：**

上游 `setup.py` 直接调用系统 Python。如果系统 Python 装在只读位置
（比如 `C:\Python314`），会报：

```
PermissionError: [Errno 13] Permission denied: 'C:\Python314\.strata-pip.json'
```

`tools\install-strata.bat` 先在 `STRATA_HOME\.venv` 建虚拟环境，
再用虚拟环境的解释器跑 `setup.py`，绕开这个问题。

**它会做：**

1. 找 Python 3.10+ 作为引导解释器
2. 在 `STRATA_HOME\.venv` 建虚拟环境
3. 用虚拟环境跑 `setup.py`，下载约 68GB 权重（走 `hf-mirror.com` 镜像）
4. 检查生成的 `strata-<profile>.json`
5. 报告模型文件实际占用

**中途想看进度**，另开一个窗口：

```bat
tools\check-progress.bat
```

**日志**：`STRATA_HOME\install-strata.log`

### 关于镜像

脚本默认设 `HF_ENDPOINT=https://hf-mirror.com`。不在中国大陆的话，
编辑 `tools\install-strata.bat` 把那一行注释掉。

### 关于代理

脚本会主动清空 `HTTP_PROXY` / `HTTPS_PROXY`，避免继承的代理拦截回环请求。

---

## 五、接入 dsh

```bat
python integrations\dsh\apply.py            :: 干跑，只打印将改什么
python integrations\dsh\apply.py --apply    :: 确认后写入（自动备份）
```

细节见 [`04-dsh-integration.md`](04-dsh-integration.md)。

---

## 六、体检

```bat
tools\verify.bat
```

覆盖 5 大类：路径解析、模型文件、引擎在线状态、dsh 集成配置、WebUI 文件。
输出格式：

```
  [ OK ]  ...
  [WARN]  ...
  [FAIL]  ...
==================================================
  RESULT:  N passed   N warnings   N failed
```

有 `[FAIL]` 就先修，`[WARN]` 多数是「引擎没启动」这类可恢复状态。

---

## 七、日常启动

| 场景 | 双击 |
|---|---|
| 引擎 + dsh 工作台 | `launchers\Strata-dsh-Workbench.bat` |
| 只要 WebUI | `launchers\Strata-WebUI.bat` |
| 只要引擎 | `launchers\Start-Strata.bat` |
| 停止全部 | `launchers\Stop-Strata.bat` |

### 启动器做了什么

`Strata-dsh-Workbench.bat` 的流程：

```
[0/3] 预检查：Strata 引擎 / dsh / Python / Node 是否存在
[1/3] 启动引擎（独立窗口，标题 "Strata Engine"）
[2/3] 每 5 秒轮询 /health，最多等 10 分钟
      就绪 → 打印 [OK] strata ready
      超时 → 打印 [WARN] 并继续（不阻塞）
[3/3] 启动 dsh web
```

全程写日志到 `LOG_DIR`（默认 `%LOCALAPPDATA%\strata-dsh-workbench\logs`），
**不在脚本旁边生成**，所以双击不会在桌面留下 `.log`。

### 引擎启动预检

`tools\run-strata.bat` 在加载模型前会读 `nvidia-smi` 检查空闲显存，
低于 3000 MiB 时警告：

```
  [WARN] Only 1234 MiB of VRAM is free right now.
         Strata needs roughly 2-3 GB left for the desktop.
         Close browsers / chat apps / games, then retry.
         Or raise the reserve:  python tools\fix-vram-reserve.py --apply
```

---

## 八、日志放在哪

**默认不在脚本旁边，也不在桌面。** 全部写到：

```
%LOCALAPPDATA%\strata-dsh-workbench\logs
    = C:\Users\<你>\AppData\Local\strata-dsh-workbench\logs
```

| 文件 | 来源 |
|---|---|
| `workbench.log` | `Strata-dsh-Workbench.bat` |
| `webui.log` | `Strata-WebUI.bat` |
| `install-strata.log` | `tools\install-strata.bat` |
| `strata-<profile>.log` | Strata 引擎自己（**不在这个目录**，见下） |

### 改日志目录

编辑 `config\paths.bat`：

```bat
set "LOG_DIR=D:\logs\strata"
```

留空则用上面的默认值。目录不存在会自动创建；创建失败会退回 `%TEMP%`。

### 自动清理

```bat
set "LOG_KEEP_DAYS=14"     REM 0 = 永不删除
```

启动器每次运行调用 `config\prune-logs.bat`，用 `forfiles` 删掉 `LOG_DIR`
里超过这个天数的 `*.log`。只删 `.log`，同目录的其它文件（比如 `README.txt`）不受影响。

### 引擎日志要单独搬

引擎日志路径由 **Strata 配置 JSON 的 `"log"` 字段**决定，
`serve/server.py` 没有 `--log` 参数，所以启动器脚本改不到它。

```bat
python tools\set-log-dir.py                      :: 诊断
python tools\set-log-dir.py --apply              :: 搬到 LOG_DIR
python tools\set-log-dir.py --apply --dir "D:\logs\strata"
python tools\set-log-dir.py --restore            :: 回滚
```

工具只改 `"log"` 一个字段，改前自动备份，其余配置原样保留。

### 验证

```bat
tools\verify.bat
```

第 6 节报告 `LOG_DIR` 是否可用，第 7 节显示引擎日志当前指向哪里。

---

## 九、卸载

```bat
launchers\Stop-Strata.bat
```

然后按需删除：

| 目录 | 内容 |
|---|---|
| `F:\Strata` | 引擎源码 + 虚拟环境 |
| `F:\Strata-data` | 模型权重（约 68GB，最大头） |
| `C:\Users\%USERNAME%\dsh-runtime` | dsh |
| 本仓库目录 | 配置和脚本 |

dsh 的配置在 `C:\Users\%USERNAME%\.dsh\`，其中 `.credentials.yaml` 含你的云 API Key。
如果 `apply.py` 改过它，可以回滚：

```bat
python integrations\dsh\apply.py --restore
```
