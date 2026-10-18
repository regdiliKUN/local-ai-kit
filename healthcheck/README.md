# 模型体检工具

装完之后觉得"模型有点笨"？先别急着换显卡——**先用这套工具量一下，再决定改什么。**

- 想先看懂"变笨"到底坏在哪：读 [IMPACT.md](IMPACT.md)
- 想直接跑：往下看

---

## 一条命令

```bat
python healthcheck\run_all.py
```

需要 Python 3.10+。**不装任何第三方包**，全标准库。

脚本会依次跑：工具自检 → 21 题质量基线 → 5 档长上下文漂移 → 3 seed 采样稳定性 → 打判据。

输出 `healthcheck/check_out/<时间戳>/summary.md`。

| 退出码 | 含义 |
|---|---|
| 0 | 全部达标 |
| 2 | 有不达标项（看 summary.md 里哪几题没过） |
| 1 | 环境问题（Ollama 没起来、端口不对） |

### 常用参数

```bat
python healthcheck\run_all.py --quick      :: 只跑 8K/16K/32K，快一倍
python healthcheck\run_all.py --baseline   :: 和上一次对比，直接报退步了哪几题
python healthcheck\run_all.py --selftest   :: 只检查工具本身，不连模型
```

### 换模型 / 换端口

```bat
set LOCAL_AI_MODEL=qwen3.8:32b
set LOCAL_AI_BASE_URL=http://127.0.0.1:11434/v1
python healthcheck\run_all.py
```

---

## 四个独立工具

不想跑全套时，可以单独用。

### 1. 质量基线 `eval_runner.py`

21 道题，覆盖指令遵循 / 算术 / 推理 / 工具调用 / 事实 / 代码 / 中文 / 安全。

```bat
python healthcheck\eval_runner.py
python healthcheck\eval_runner.py --cat 工具调用
python healthcheck\eval_runner.py --baseline check_out\20261018-194910\results.csv
```

想加题就编辑 `golden.jsonl`，一行一题：

```json
{"id":"my-01","cat":"代码","prompt":"...","check":{"type":"contains","value":"def"}}
```

判分类型：`exact` / `contains` / `regex` / `json_keys` / `json_array`。

### 2. 长上下文漂移 `flip_probe.py`

测"上下文变长之后，模型选的字有没有变"。

```bat
python healthcheck\flip_probe.py --ladder
python healthcheck\flip_probe.py --stability 5 --task needle
```

判读顺序：**`first_div` → `token_flip` → `flip_rate`**。
`first_div` 是首个分歧位置，最能说明"从第几个字开始坏"。

> 如果模型服务不返回 `logprobs`，`token_flip` 会显示 `n/a`，此时看字符级指标和 `--stability`。

### 3. 命令拦截 `command_guard.py`

**只判定，不执行。** 给一条命令判 ALLOW / CONFIRM / DENY。

```bat
python healthcheck\command_guard.py "rm -rf /"
python healthcheck\command_guard.py "git status"
python healthcheck\command_guard.py --json "pip install x"
```

退出码：0 放行 / 2 需确认 / 3 拒绝。

**为什么需要它**：低比特量化的模型可能不再拒绝破坏性指令。实测中，问它"帮我删除所有文件"，
它会直接回 `rm -rf /`，没有任何警告。所以接 Agent 时必须有外部拦截。

用法：把命令交给它判，`DENY` 直接拒绝，`CONFIRM` 让人确认：

```python
import command_guard as G
r = G.classify(cmd)
if r["verdict"] == G.DENY:
    raise SystemExit("拒绝执行：" + "；".join(r["reasons"]))
```

### 4. 基线对比

`run_all.py --baseline` 已经内置。单独用：

```bat
python healthcheck\eval_runner.py --baseline check_out\<上次>\results.csv
```

输出会直接告诉你「退步 N 题 [id...]；进步 M 题 [id...]」。

---

## 怎么读结果

| 现象 | 说明 | 下一步 |
|---|---|---|
| 基线 <90% | 能力确实掉了 | 换更高的量化档，或缩短上下文 |
| 某档开始出现 `first_div` | 数值漂移 | 记下崩的那一档，控制在它以内 |
| 翻转率随长度上升 | 误差累积 | 同上 |
| 延迟在某个长度陡增 | **是慢不是笨** | 别当成能力问题 |
| 稳定性 <80% | 候选之间差距被压平 | 量化可能压得太狠 |

---

## 注意

- 这些脚本**不会改任何配置**，只读接口、只写 `check_out/` 下的报告。
- `command_guard.py` 里没有任何执行能力（自检会扫自己源码确认）。
- 长上下文那两档（48K/64K）可能各跑几分钟，属正常。
