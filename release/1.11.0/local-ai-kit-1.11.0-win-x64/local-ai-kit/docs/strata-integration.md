# 接入已有的 Strata 工作台

适用于已经有 `<部署目录>/workbench`、Strata 引擎及 dsh 运行时的 Windows 电脑。
此模式复用现有模型和 dsh 配置。首次安装 Ollama 的流程保持可用。

```powershell
node scripts/connect-strata.mjs --root 'F:\本地AI' --strata-home 'F:\Strata' --dsh-dir "$env:USERPROFILE\dsh-runtime"
node scripts/console.mjs
```

控制台只监听本机 7790–7799 中第一个空闲端口。支持中文路径。
配置存于仓库根目录的 `配置.json`，不会提交到 Git。再次接入会先备份原配置。
可使用 `--engine-port`、`--web-port`、`--dsh-port` 指定端口；`--python` 指定 WebUI 的解释器；
`--model-dir` 指定模型位置；`--dsh-home` 指定已有的 dsh 状态目录。
这些参数必须与已有工作台的 `config/paths.bat` 相符。

控制台包含引擎、WebUI、dsh 三张状态卡片。首次启动引擎需要加载模型，
提交启动请求后状态会自动刷新。WebUI 按钮在引擎就绪后启用。
工作台可同时启动引擎与 dsh；引擎加载期间请等待就绪再对话。
dsh 启动时会自行打开带登录令牌的浏览器入口。

服务运行在后台，关闭控制台页面不会停止服务。日志写入 `<部署目录>/logs/kit-*.log`。
再次点击启动会检查正在监听端口的进程，以及还在加载、尚未监听端口的进程。
“停止全部服务”覆盖引擎、WebUI、dsh，并检查完整脚本路径和解释器进程名。
若端口被其他程序占用，则拒绝停止该进程。

Strata 模式不提供 Ollama 的模型下载、删除、上下文配置、共享、卸载操作。
原有 dsh profile、凭据、Strata 模型文件和显存预检保持由现有工作台管理。

## 开发验证

```powershell
node --test tests/runtime.test.mjs
node healthcheck/quick.mjs --selftest
```

回归测试覆盖 HTTP 非成功状态、异常 JSON / 超限请求 / UTF-8、令牌字节长度、
完整安装后的独立控制台、配置 BOM 和原子替换、Strata API 隔离、
Windows 停止进程的归属校验及尚未监听端口的引擎。
这些测试不加载模型，不代表完成了模型质量或推理速度测评。
