# 参与贡献

这个项目服务于「想在本地跑大模型、但不想跟命令行较劲」的人。
所以改动的判断标准只有一条：**普通用户双击之后能不能用起来。**

## 环境要求

- Node.js **20 或以上**（不需要装任何第三方包）
- Windows 10 / 11（部分功能依赖 Windows 的 .lnk 与注册表；核心逻辑跨平台）

## 常用命令

```bash
npm test        # 跑全部单元测试（32 个用例）
npm run lint    # 语法检查
npm run console # 启动本地控制台
npm run installer # 启动安装向导
```

`npm test` 在 Windows 上如果 PowerShell 拦住 `npm.ps1`，直接用 `node --test "tests/*.test.mjs"`。

## 代码约定

- **零第三方依赖。** 所有东西都用 Node 内置模块写。原因很实际：安装包要能离线分发，
  多一个依赖就多一份下载、多一处出问题的可能。
- **不引入构建步骤。** `ui/` 里的文件直接就是浏览器要用的文件，改完刷新就生效。
  没有 webpack、没有 babel、没有 TypeScript 编译。
- **UI 用原生 JS + CSS 变量。** 图表是自己写的 SVG（`ui/charts.js`），配色走 CSS 变量，
  这样深色模式不用在 JS 里判断。
- **注释写「为什么」，不写「是什么」。**
  尤其要写清楚那些「看起来可以简化，但简化了就出 bug」的地方 ——
  比如 SSE 为什么不设 `requestTimeout`，配置为什么要先备份再写。
- **中文文案。** 这个项目的用户是中文使用者，界面和注释都用中文。

## 改完必须验证

```bash
npm run lint && npm test
```

改了界面的话，**在浏览器里实际看一眼**。本项目大量依赖运行时数据
（显卡、显存、Ollama 状态），只看代码很容易漏掉「数据没到位时页面长什么样」的问题。

## 提交信息

用中文，格式是 `类型: 主题`，例如：

```
feat: 控制台新增「空间分析」页
fix: 修掉 manifest digest 与 blob 文件名对不上的问题
docs: 补充体检判据的说明
```

类型：`feat` / `fix` / `docs` / `refactor` / `test` / `chore`。

## 提 Issue 时请附上

1. 你的显卡型号与显存、系统版本
2. 装的是哪个版本（控制台 → 服务设置 → 检查更新）
3. 日志文件：`%TEMP%\localai-console.log`（控制台 → 服务设置 → 查看日志 → 下载）
4. 装的时候卡在哪一步

## 安全

- 服务只监听 `127.0.0.1`，但浏览器里任何网页都能向它发请求。
  所有 POST 必须带页面里注入的随机令牌，并且校验 `Host` 头和 `Origin`。
  **新增接口时请沿用这套校验，不要绕过。**
- 不要把 Ollama（11434）或工作台（3080）映射到公网。
- 局域网共享默认关闭，打开前必须二次确认。

## 目录速查

```
scripts/    后端（Node，无依赖）
  local-http.mjs   共用的 HTTP 助手：来源校验 / 限流 / SSE
  install.mjs      安装引擎 + 压缩预算推导
  console.mjs      控制台服务
  installer.mjs    安装向导服务
  metrics.mjs      显卡 / CPU / 内存 / 磁盘采集
  space.mjs        模型目录空间分析
  bench.mjs        性能基准
  repair.mjs       诊断与修复
  ...
ui/         前端（原生 JS）
  index.html/app.js    安装向导
  console.html/console.js  控制台
  charts.js         零依赖 SVG 图表库
healthcheck/ 模型体检（Node 版 + Python 版）
tests/      单元测试
```
