# 把 Strata 接入 dsh

完整操作步骤见 [`../integrations/dsh/README.md`](../integrations/dsh/README.md)。
本文只记录**为什么这么做**和**验证方法**。

---

## 一、dsh 的模型配置在哪

从 dsh 的 `setup.mjs` 的 `writeDshProfiles` 可以确定，接入自定义模型要改**两个文件**：

| 文件 | 改什么 |
|---|---|
| `~/.dsh/profiles/<profile>/cordis.patch.yml` | 在 `llm-pi-ai` 插件的 `config.providers` 下加 provider |
| `~/.dsh/.credentials.yaml` | 在 `refs:` 段加一行 API Key |

`<profile>` 至少要有 `web`，用命令行版再加 `headless`。

---

## 二、为什么 `apply.py` 不解析 YAML

dsh 的 `cordis.patch.yml` 里含 `!!js` 自定义标签（例如把 JS 表达式直接写进配置）。
用 PyYAML 加载会抛异常，强行 round-trip 写回会破坏格式，dsh 就不再接受这个文件。

所以 `apply.py` 按行做**文本插入**，只触碰它需要的行：

1. 定位 `- id: llm-pi-ai` 这个插件块的起止
2. 在块内找到 `providers:` 行，记下缩进
3. 在 `providers:` 后面插入 provider 段落（缩进 = 父级 + 2）
4. 可选地改 `agent-default-model` 的 `provider` / `model`

**安全性：**

- 每个被改的文件先备份为 `<原名>.bak-YYYYMMDD-HHMMSS`
- 幂等：已经是目标状态时替换而不是叠加
- 干跑模式：不加 `--apply` 不写任何东西
- 回滚：`python apply.py --restore` 恢复最新备份

---

## 三、provider 段落长什么样

```yaml
      strata-local:
        displayName: Strata Local (Qwen3.8-Flash-Next 125B MoE)
        apiKeyEnv: STRATA_API_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:8080/v1
        models:
          - id: qwen3.8-flash-next-iq2_xs
            name: Qwen3.8-Flash-Next IQ2_XS (125B MoE, 128K)
            contextWindow: 131072
            maxTokens: 32768
            input: [ text, image ]
```

**关键点：这是 `providers:` 下的一个兄弟节点，不是替换关系。**
原有的 `ollama-local` 和 `discovery-1..7` 全部保留，用不上的时候在模型选择器里切走就行。

---

## 四、pi-ai 支持的协议名

`api:` 字段可选值：

```
openai-completions        anthropic-messages
openai-responses          google-generative-ai
bedrock-converse-stream   azure-openai-responses
openrouter                xai
```

Strata 提供 OpenAI 兼容接口，所以用 `openai-completions`。

---

## 五、验证

### 1. 配置合并是否正确

```bat
node <DSH_DIR>\node_modules\@deepseek-ai\dsh\lib\bin.js --profile web --dump-config
```

在输出里搜 `strata-local`。搜得到就说明配置被正确合并了。

> `--dump-config` 输出的是组合后的完整配置，比只看 patch 文件可靠。
> 注意 web profile 含自定义 `!!js` 标签，用 js-yaml 校验时需注册占位 Type。

### 2. UI 是否识别

启动 dsh，打开 **Settings → Models**，应该看到：

```
Strata Local (Qwen3.8-Flash-Next 125B MoE)
  └─ Qwen3.8-Flash-Next IQ2_XS (125B MoE, 128K)
```

### 3. 一次性全查

```bat
tools\verify.bat
```

它会检查 `strata-local` provider 和 `STRATA_API_KEY` 是否都到位。

### 4. 实跑一个 Agent 任务

用 `dsh-tool-fs` 读一个真实文件。本机实测：正确提取代号，准确识别 `a-b` 应为 `a+b`。

---

## 六、实测结论

| 指标 | 实测值 |
|---|---|
| 工具调用准确率 | **9/9 = 100%**（参数 JSON 零错误） |
| 生成速度 | 144–154 tok/s（工具调用场景 171–242） |
| 预填充 | 1375 tok/s（1559 tokens） |
| 端到端 Agent 任务 | 1.5–2.5s |

> **重要更正：** 2-bit 量化常被认为「工具调用不可靠、建议换 IQ3_S」。
> 本机实测**推翻了**这个推断，IQ2_XS 的工具调用 9/9 全对，**不需要降级**。

---

## 七、常见问题

| 症状 | 原因 | 修法 |
|---|---|---|
| 模型选择器里没有 Strata 分组 | `cordis.patch.yml` 缩进错了，或改错了 profile | 用 `--dump-config` 确认 |
| `socket stream idle timeout after 300000ms` | 选的是 `qwen3.8:27b`（Ollama 模型），但 Ollama 没跑 | 切到 Strata 那一项 |
| 401 / unauthorized | `STRATA_API_KEY` 与 `strata-<profile>.json` 的 `api_key` 不一致 | 改一致 |
| 改了配置但 dsh 行为没变 | dsh 启动时读配置 | 完全退出 dsh（含托盘）再启动 |
| 想同时保留 Ollama | 可以，provider 是并列的 | 但两者显存相加 38GB > 24GB，不能同时加载 |

---

## 八、回滚

```bat
python integrations\dsh\apply.py --restore
```

会把每个文件恢复成**最新的一份** `.bak-*` 备份。想恢复到更早的版本，
手动把对应的 `.bak-<时间戳>` 复制回去即可。
