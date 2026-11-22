# 可选：接入 Qwen3.5-35B-A3B（llama.cpp）

控制台「服务设置」里的 **启动 Qwen3.5 模型** 按钮，用 llama.cpp 跑一个本地的
Qwen3.5-35B-A3B 社区微调版。**模型和引擎都不在仓库里**（模型约 21 GB，引擎约 1.4 GB），
需要自己下载、放到一个目录里，再在 `配置.json` 里指过去。没部署时这个按钮会报错，并告诉你缺什么、去哪下。

## 1. 下载

| 要下的东西 | 地址 | 说明 |
|---|---|---|
| 模型（.gguf） | <https://huggingface.co/HauhauCS/Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive> | 在 **Files and versions** 里下 `…-Q4_K_M.gguf`（约 20 GB，24 GB 显存推荐）。显存小可以选更小的量化 |
| 看图（可选） | 同上模型页 | 再下 `mmproj-…-f16.gguf`（0.9 GB），放进同一个 `model` 目录就能发图片；多占约 1 GB 显存 |
| 国内镜像 | <https://hf-mirror.com/HauhauCS/Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive> | 同一个仓库，把域名换成 `hf-mirror.com` |
| llama.cpp 引擎 | <https://github.com/ggml-org/llama.cpp/releases> | 下 `llama-bXXXXX-bin-win-cuda-12.4-x64.zip` 和 `cudart-llama-bin-win-cuda-12.4-x64.zip`，两个都解压到同一个 `runtime` 目录。实测版本 b12602 |

> 这是社区去审查微调版（HauhauCS "Aggressive"），不是 Qwen 官方发布。下载前看一眼模型页的许可和说明。

## 2. 目录结构

放在哪个盘都行，结构要这样：

```
D:\Qwen3.5-35B-A3B-Uncensored\          ← qwen35Home
├─ model\
│   ├─ Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf
│   └─ mmproj-Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive-f16.gguf   ← 可选，看图用
└─ runtime\
    ├─ llama-server.exe
    └─ ggml-cuda.dll、cublas64_12.dll … （两个 zip 解压出来的全部文件）
```

## 3. 配置

在工具包根目录的 `配置.json` 里加上（都是可选，不写就用默认值）：

```json
{
  "qwen35Home": "D:\\Qwen3.5-35B-A3B-Uncensored",
  "qwen35ModelFile": "Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf",
  "qwen35Port": 18123,
  "qwen35NCpuMoe": 10,
  "qwen35Ctx": 32768,
  "qwen35Threads": 16
}
```

| 字段 | 默认 | 作用 |
|---|---|---|
| `qwen35Home` | `F:\Qwen3.5-35B-A3B-Uncensored` | 上面那个目录 |
| `qwen35ModelFile` | Q4_K_M 那个文件名 | 换了别的量化版本就改成对应文件名 |
| `qwen35Mmproj` | 自动 | 看图用的视觉文件名。不写就自动用 `model` 里的 `mmproj*.gguf`；写 `false` 关闭看图 |
| `qwen35Port` | 18123 | 必须在 15000 以上：本机动态端口范围是 1024–15000，Windows（Hyper-V/WinNAT）每次开机会在里面随机保留端口，8123 曾因此绑不上 |
| `qwen35NCpuMoe` | 10 | 多少层 MoE 专家放内存：越小越快、越吃显存 |
| `qwen35Ctx` | 32768 | 上下文长度 |
| `qwen35Threads` | 16 | CPU 线程数 |

改完重新打开控制台即可。

### 让工作台能发图片

光有 mmproj 还不够，工作台（dsh）的模型配置里也要声明这个模型收图片，否则它会在发送前拦下并提示
「当前模型不支持图片」。在 dsh 的 profile 补丁里，Qwen3.5 那一项写成：

```yaml
input: [ text, image ]
```

改完重启工作台。可以打开 `http://127.0.0.1:18123/props` 确认 `"vision": true`。

## 4. 显存参考（RTX 4090 24 GB，32K 上下文）

| `qwen35NCpuMoe` | 生成速度 | 显存（含桌面约 3.5 GB） |
|---:|---:|---:|
| 8 | ~87 tok/s | ~20.7 GB |
| 10 | ~78 tok/s | ~19.9 GB（默认） |
| 16 | ~58 tok/s | ~15.9 GB |

不要去掉 `--n-cpu-moe`：全部塞进显存会溢出到共享内存，速度反而掉到 ~29 tok/s。

## 加载要多久

模型文件最近读过时，系统会把它缓存在内存里，加载约 5～10 秒；刚开机后的第一次要从硬盘读 21 GB，
取决于硬盘速度（NVMe 几十秒，机械盘会更久）。
