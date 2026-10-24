# 发行包 · 本地 AI 控制台

本目录存放 **本地 AI 控制台** 的 Windows x64 可运行包体（由桌面快捷方式实际指向的安装/发布目录整理而来）。

| 项目 | 内容 |
| --- | --- |
| 版本 | `1.10.0` |
| 平台 | Windows x64 |
| 包体路径 | `release/1.10.0/local-ai-kit-1.10.0-win-x64/` |
| 文件数 | 187 |
| 体积 | 约 7.9 MB |

## 运行方式

双击 `本地AI.cmd`

## 校验完整性

```bash
cd release
sha256sum -c SHA256SUMS.txt
```

Windows PowerShell：

```powershell
Get-Content release\SHA256SUMS.txt | ForEach-Object {
  $h, $p = $_ -split '  ', 2
  if ((Get-FileHash $p -Algorithm SHA256).Hash -ne $h.ToUpper()) { "MISMATCH $p" }
}
```

## 关于 本地 AI 控制台

一站式本地 AI 模型配置与启动控制台（Strata / Ollama 双引擎）。

## 未纳入的内容

模型权重目录 `模型-Ollama/`、`模型-Strata/`（合计约 90GB）以及 `logs/`、`eval/` 未纳入，需按说明自行下载模型。

以上目录属于开发环境、运行期缓存或大体积模型权重，不影响程序本体运行。
