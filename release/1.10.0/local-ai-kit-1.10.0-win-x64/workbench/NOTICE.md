# 第三方依赖与许可声明

**本仓库不包含任何第三方源代码，也不包含模型权重。**

这里列出的项目由使用者自行安装。`strata-dsh-workbench` 只提供配置、启动脚本、
一个零依赖的 WebUI 和文档，全部为本仓库原创。

---

## 运行时依赖

### 1. Strata —— 推理引擎

- 来源：https://github.com/Niko1221/Strata
- 许可：**MIT**
- 本仓库如何与之交互：
  - 通过 `tools/run-strata.bat` 调用 `serve/server.py` 启动它
  - 通过 HTTP 访问其 OpenAI 兼容接口（`http://127.0.0.1:8080/v1`）
  - 读取并修改它生成的 `strata-<profile>.json` 启动配置
- **未包含**：任何 `.cpp` / `.h` / `.py` 源文件、编译产物、模型权重

本仓库的 `tools/install-strata.bat` 是对上游 `setup.py` 的**调用包装**，
用于规避「系统 Python 无写权限导致 `PermissionError`」的问题。它不修改上游代码。

### 2. DeepSeek Harness (dsh) —— Agent 平台

- 来源：https://www.npmjs.com/package/@deepseek-ai/dsh
- 许可：**MIT**
- 本仓库如何与之交互：
  - `integrations/dsh/apply.py` 以**文本方式**在其配置文件
    `~/.dsh/profiles/*/cordis.patch.yml` 中插入一个 provider 段落
  - 在 `~/.dsh/.credentials.yaml` 的 `refs:` 段插入一行本地 API Key
  - 所有被修改的文件在写入前都会自动备份为 `<原名>.bak-YYYYMMDD-HHMMSS`
- **未包含**：任何 npm 包内容、前端产物、源码

`apply.py` 刻意**不解析 YAML**——上游配置含 `!!js` 自定义标签，
用 PyYAML 读写会破坏文件。因此它按行做文本插入，只触碰必要的行。

### 3. Qwen3.8-Flash-Next —— 模型权重

- 用途：Strata 加载的大模型
- 许可：**版权归模型发布方所有**。本仓库不分发、不镜像、不修改权重。
  使用前请阅读模型发布方的许可条款。
- 下载：由 `tools/install-strata.bat` 调用上游 `setup.py` 完成，
  默认使用 `https://hf-mirror.com` 镜像

---

## 其它

- 本仓库的 `tools/create-shortcuts.ps1` 使用 Windows 内置的
  `WScript.Shell` COM 对象创建快捷方式，无第三方依赖。
- `webui/server.py` 与 `tools/strata-folder-agent.py` **仅使用 Python 标准库**，
  无任何 pip 依赖。
- `webui/index.html` 为单文件，**不使用任何前端框架或 CDN**，可离线运行。

---

## 关于 API Key

`integrations/dsh/credentials-snippet.yaml` 中出现的 `sk-local-qwen` 是
**本地占位密钥**，仅用于本机 `127.0.0.1` 回环通信，不指向任何云服务。

真正的云端 API Key（如 DeepSeek、书生端砚等）保存在
`~/.dsh/.credentials.yaml`，该文件**已被本仓库的 `.gitignore` 排除**，
请勿提交。
