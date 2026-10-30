# 把 Strata 接进 DeepSeek Harness

dsh 默认只认它自带的 provider。要让它在模型选择器里出现「Strata 本地」，需要改**两个文件**：

| 文件 | 改什么 |
|---|---|
| `~/.dsh/profiles/<profile>/cordis.patch.yml` | 在 `llm-pi-ai` 插件的 `config.providers` 下加一个 `strata-local` provider |
| `~/.dsh/.credentials.yaml` | 在 `refs:` 段加一行 `STRATA_API_KEY` |

`<profile>` 取决于你**怎么启动 dsh**，这一点很容易踩坑：

| 启动方式 | 读的 profile |
|---|---|
| `dsh web`（浏览器打开 `127.0.0.1:3080`） | `web` |
| `dsh --profile headless ...`（命令行跑任务） | `headless` |
| DeepSeek Harness 桌面应用（Electron） | `desktop` |

**只写 `web` 是不够的**：桌面版读的是 `desktop`，里面没有 `llm-pi-ai` 条目时，模型选择器只会剩下 `deepseek-official` 的两三个官方模型。`apply.py` 会扫描 `profiles\` 下所有带 `cordis.patch.yml` 的目录（`web` / `headless` / `desktop` 以及其他自定义档），缺 `llm-pi-ai` 条目时会整段补上。

---

## 方法一：自动注入（推荐）

```bat
python integrations\dsh\apply.py            :: 先干跑，只打印将要改什么
python integrations\dsh\apply.py --apply    :: 确认后真正写入（自动备份）
```

回滚：

```bat
python integrations\dsh\apply.py --restore
```

脚本的行为：

- **不解析 YAML。** dsh 的配置文件里有 `!!js` 自定义标签，用 PyYAML 读会炸、写回会破坏格式。所以本脚本按行做文本插入，只碰它需要的行。
- 每个被修改的文件都会先复制一份 `<原名>.bak-YYYYMMDD-HHMMSS`。
- 已经是目标状态时不会重复插入（幂等）。
- 默认会把 dsh 的默认模型也指向 Strata，加 `--no-default` 可以保留原来的默认模型。

常用参数：

| 参数 | 说明 |
|---|---|
| `--base-url` | 引擎地址，默认 `http://127.0.0.1:8080/v1` |
| `--api-key` | 本地密钥，默认 `sk-local-qwen` |
| `--provider-id` | provider 名字，默认 `strata-local` |
| `--model-id` | 模型 id，默认 `qwen3.8-flash-next-iq2_xs` |
| `--no-default` | 不动 `agent-default-model` |

> 改了端口或 profile 名字之后，重跑一次 `--apply` 即可，脚本会替换而不是叠加。

---

## 方法二：手动改

### 1. 加 provider

打开 `~/.dsh/profiles/web/cordis.patch.yml`，找到：

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      ollama-local:
        ...
```

在 `providers:` 下面、与 `ollama-local` **同级**的位置插入 `provider-snippet.yml` 里的那段。注意缩进必须一致（通常是 6 个空格）。

**不要删掉原有的 provider**，它们是并列关系，不是替代关系。

### 2. 加凭据

打开 `~/.dsh/.credentials.yaml`，在已有的 `refs:` 下面加一行：

```yaml
refs:
  STRATA_API_KEY: sk-local-qwen
```

### 3. 让 Strata 成为默认模型（可选）

同一个 `cordis.patch.yml` 文件底部有：

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: ollama-local
    model: qwen3.8:27b
```

改成：

```yaml
    provider: strata-local
    model: qwen3.8-flash-next-iq2_xs
```

---

## 验证

```bat
node <dsh 目录>\node_modules\@deepseek-ai\dsh\lib\bin.js --profile web --dump-config
```

在输出里搜 `strata-local`，能搜到就说明配置被正确合并了。

然后启动 dsh，打开 **Settings → Models**，应该能看到分组：

```
Strata Local (Qwen3.8-Flash-Next 125B MoE)
  └─ Qwen3.8-Flash-Next IQ2_XS (125B MoE, 128K)
```

也可以用本仓库的 `tools\verify.bat`，它会一次性检查 provider 和凭据是否都到位。

---

## 支持的协议名

`api:` 字段可选的值（来自 pi-ai）：

```
openai-completions        anthropic-messages
openai-responses          google-generative-ai
bedrock-converse-stream   azure-openai-responses
openrouter                xai
```

Strata 提供 OpenAI 兼容接口，所以用 `openai-completions`。

---

## 常见问题

**模型选择器里没有 Strata 分组**

按这个顺序查，别跳步：

1. **先确认改的是不是当前 profile。** 看 dsh 进程的命令行：`dsh web` → `web`；桌面版 → `desktop`。改错了 profile，文件再对也没用。
2. **确认这个 profile 里到底有没有 `llm-pi-ai` 条目。** 桌面版的 `cordis.patch.yml` 可能只有几条 UI 设置，根本没有 `llm-pi-ai`，这种情况下"缩进错了"根本无从谈起——需要整段补上，`apply.py` 已经会自动做。
3. **确认进程重启过。** dsh 在启动时读配置，改完必须完全退出（含托盘）再启动。
4. **直接问后端要模型目录**，绕开 UI 判断，见 [故障排查 H](../05-troubleshooting.md#h-dsh-模型选择器里看不到本地模型)。

**报 `no API key for provider route "deepseek-official"`**

说明当前会话被钉在官方 DeepSeek 路由上，而且没有可用的 `DEEPSEEK_API_KEY`。两种解法：切到 `strata-local`，或者把 `agent-default-model` 指向 `strata-local` 并**新开一个会话**（旧会话里存着 `model/selection` 事件，会继续用它当时选中的模型）。

**报 `socket stream idle timeout after 300000ms`**
你选的是 `qwen3.8:27b`（Ollama 模型），但 Ollama 没启动。切到 Strata 那一项。

**报 401 / unauthorized**
`STRATA_API_KEY` 的值和 `strata-<profile>.json` 里的 `api_key` 不一致。

**改了配置但 dsh 行为没变**
dsh 在启动时读配置。完全退出 dsh（包括托盘）再启动。

**想同时保留 Ollama**
可以，provider 是并列的。但注意两者显存占用相加会超过 24GB，4090 上不能同时加载。
