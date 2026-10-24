/*
 * 多语言支持（中文 / English）。
 *
 * 做法：**按源字符串翻译**。
 *
 * 界面上的文案本来就写着中文，字典的键就是这段中文。
 * 好处是：
 *   - 不用给几百个元素加 data-i18n 属性，改文案时也不会忘改字典
 *   - JS 里的字符串和 HTML 里的文本用同一套机制
 *   - 没翻译的条目自动回退成中文，不会出现「一半中文一半英文」的乱象
 *
 * 想加语言：复制一份 DICT，翻译一遍，再加进 LANGS。
 */

const DICT = {
  // ---- v1.9 / v1.10 新增界面文案 ----
  '| 模型 | 状态 | 首字(ms) | 总耗时(ms) | 字数 |': '| Model | Status | First token (ms) | Total time (ms) | Characters |',
  '★ 收藏': '★ Favorites',
  '☆ 收藏': '☆ Favorites',
  '上次 vs 本次': 'Previous vs current',
  '下载聚合报告（JSON）': 'Download combined report (JSON)',
  '仅一个模型用': 'Used by one model',
  '体积': 'Size',
  '体积分布': 'Size distribution',
  '偏热，会降速': 'Running hot; performance may throttle',
  '先测一遍，才有最快模型可选': 'Run a test first to find the fastest model',
  '先选一个模型': 'Select a model first',
  '全部模型测完': 'All models tested',
  '其中能自动修': 'Automatically fixable',
  '出字快测 · 横向对比': 'Quick response test · Model comparison',
  '切到这一页会自动加载': 'Loads automatically when you open this page',
  '切模型要重启工作台才生效，重启完才发现跑不动最坑。这里把每次「试一下」的结果留下来， 多个模型并列比：谁出字快、谁根本跑不动，一眼选。点「测全部」一次性把已装模型都跑一遍。': 'Switching models requires restarting the workbench. Test them first to avoid choosing one that cannot run. Compare saved results to see which models respond quickly and which fail. Click "Test all" to test every installed model.',
  '参数(B)': 'Parameters (B)',
  '只统计「试用」页的对话': 'Only conversations on the Try page are counted',
  '右下角的大气泡最划算': 'Large bubbles in the bottom right offer the best value',
  '各类「通过 / 未通过」数量': 'Pass / fail counts by category',
  '复制失败，浏览器不允许访问剪贴板': 'Copy failed: the browser does not allow clipboard access',
  '复制对比': 'Copy comparison',
  '复制模型名': 'Copy model name',
  '多模型共用': 'Shared by multiple models',
  '对话次数': 'Conversation count',
  '导出网页': 'Export as HTML',
  '已复制对比表格': 'Comparison table copied',
  '已导出为网页文件': 'Exported as an HTML file',
  '已清空快测记录': 'Quick test history cleared',
  '已选中这一行，按 Ctrl+C 复制': 'Row selected; press Ctrl+C to copy',
  '收藏 / 取消收藏': 'Add / remove favorite',
  '无人引用（残留）': 'Unreferenced (leftover)',
  '日期': 'Date',
  '显卡温度': 'GPU temperature',
  '有点吃紧，留意显存': 'Resources are tight; watch VRAM usage',
  '未测': 'Not tested',
  '本次': 'Current',
  '本次 vs 历史最佳 / 平均': 'Current vs personal best / average',
  '检查之后这里会有延迟对比': 'Latency comparisons appear here after a check',
  '检查之后这里会有汇总': 'A summary appears here after a check',
  '检查项': 'Check',
  '模型没有返回任何内容': 'The model returned no content',
  '测全部中…': 'Testing all models…',
  '测全部已装模型': 'Test all installed models',
  '测试中…': 'Testing…',
  '清空失败': 'Failed to clear',
  '清空记录': 'Clear history',
  '用量已导出为 CSV': 'Usage exported as CSV',
  '磁盘剩余': 'Free disk space',
  '磁盘占用（按占比）': 'Disk usage (by share)',
  '空间构成': 'Space breakdown',
  '系统负载走势': 'System load over time',
  '续写': 'Continue writing',
  '聚合报告已开始下载': 'Combined report download started',
  '能力矩阵': 'Capability matrix',
  '至少测两次才能对比': 'Run at least two tests to compare',
  '装了模型才能画': 'Install a model to see the chart',
  '设为最快模型': 'Use the fastest model',
  '试一下': 'Try it',
  '说「好」就行': 'Just say "OK"',
  '读取失败': 'Failed to load',
  '负载轻松，跑得动': 'Light load; ready to run',
  '质量通过率': 'Quality pass rate',
  '资源吃紧，建议先关掉别的程序': 'Resources are tight; close other programs first',
  '跑一次就能看到': 'Run once to see results',
  '跳到主内容': 'Skip to main content',
  '还没有对话可导出': 'No conversations to export yet',
  '还没有用量记录': 'No usage records yet',
  '适配度气泡图': 'Model fit bubble chart',
  '速度(t/s)': 'Speed (tokens/s)',

  // ---- 通用 ----
  '本地 AI 控制台': 'Local AI Console',
  '安装向导': 'Setup Wizard',
  '继续': 'Continue',
  '上一步': 'Back',
  '下一步': 'Next',
  '完成': 'Done',
  '取消': 'Cancel',
  '确定': 'OK',
  '关闭': 'Close',
  '关闭向导': 'Close wizard',
  '开始使用': 'Get started',
  '跳过': 'Skip',
  '完成。': 'Done.',
  '准备中…': 'Preparing…',
  '修复中…': 'Fixing…',
  '处理中…': 'Working…',
  '加入中…': 'Adding…',
  '下载中': 'Downloading',
  '体检中…': 'Checking…',
  '安装中…': 'Installing…',
  '加入下载队列': 'Add to queue',
  '下载': 'Download',
  '下载模型': 'Download model',
  '下载日志': 'Download log',
  '下载诊断报告': 'Download diagnostic report',
  '下载最多': 'Most downloads',
  '下载不动、更新查不到、硬盘越来越满 —— 先在这里查一遍，': 'Downloads stuck, updates not found, disk filling up — check here first,',
  '不用重装': 'No reinstall needed',
  '不改任何配置': 'Changes nothing',
  '不到 1 分钟': 'Under a minute',
  '一句话': 'In one sentence',
  '五分钟': 'Five minutes',
  '什么时候用': 'When to use it',
  '修问题': 'Fix problems',
  '修复': 'Fix',
  '修复中心': 'Repair Center',
  '停止': 'Stop',
  '停止全部服务': 'Stop all services',
  '停止服务并释放显存': 'Stop services and free VRAM',
  '停服务前先看一眼': 'Check this before stopping',
  '删除': 'Delete',
  '创建桌面快捷方式': 'Create desktop shortcut',
  '刷新状态': 'Refresh',
  '剩余': 'Remaining',
  '内存': 'Memory',
  '内存占用': 'Memory usage',
  '功耗': 'Power',
  '分片': 'Shards',
  '写入配置': 'Write config',
  '下载 Ollama 安装包': 'Downloading the Ollama installer',
  '会检查并更新配置': 'Will check and update the configuration',
  '会放到 %TEMP%\\local-ai-offline 目录。': 'It will be placed in %TEMP%\\local-ai-offline.',
  '云端': 'Cloud',
  '不通': 'Unreachable',
  '出错': 'Error',
  '一句话': 'In one sentence',
  '上下文': 'Context',
  '上下文与模型': 'Context & Model',
  '上下文长度': 'Context length',
  '上下文长度（窗口）': 'Context length (window)',
  '一次对话最多能装多少 token。越大越能记住前文，但也越吃显存、越慢。': 'How many tokens one conversation can hold. Larger means it remembers more, but uses more VRAM and runs slower.',
  '上下文越长答案越容易变。把窗口控制在漂移起点以内就行': 'The longer the context, the more the answer drifts. Keep the window below the drift point.',
  '保留比例': 'Retain ratio',
  '保留比例 retainRatio': 'Retain ratio retainRatio',
  '使用说明.html': 'README.html',
  '使用中的模型': 'Model in use',
  '使用的模型': 'Model to use',
  '你信任的家庭网络': 'a home network you trust',
  '你的显存': 'Your VRAM',
  '你的本地 AI 工作台': 'Your local AI workbench',
  '体检全部达标': 'All checks passed',
  '体检历史已清空': 'Check history cleared',
  '体检有不达标项': 'Some checks did not pass',
  '体检有不达标项，去控制台看看': 'Some checks did not pass — see the console',
  '体检有不达标项，看下面的判据': 'Some checks did not pass — see the criteria below',
  '体检通过，装好了就能用': 'Checks passed — you are ready to go',
  '几个分区可用空间 ≥30GB': 'partitions with ≥30 GB free',
  '准备 Ollama 推理服务': 'Preparing the Ollama inference service',
  '准备安装目录': 'Preparing the install directory',
  '修复中…': 'Fixing…',
  '出问题时': 'When something is broken',
  '切换主题': 'Switch theme',
  '切换深色 / 浅色': 'Switch dark / light',
  '先写一个问题': 'Ask a question first',
  '先填一个模型名': 'Enter a model name first',
  '先检查，再决定要不要清。': 'Check first, then decide whether to clean.',
  '先点「重新检查」，看看是哪一环断了；能自动修的直接一键修，': 'Start with "Re-check" to see which link is broken — most things can be fixed with one click,',
  '先装一个模型再来测速': 'Install a model before benchmarking',
  '先装一个模型再来聊天': 'Install a model before chatting',
  '先选一段对话': 'Pick a conversation first',
  '全部改回自动': 'Reset all to automatic',
  '内存': 'Memory',
  '再重启工作台': 'Then restart the workbench',
  '其它程序': 'Other programs',
  '下载队列': 'Download queue',
  '不达标': 'Below target',
  '不足': 'Not enough',
  '下载不动、更新查不到、硬盘越来越满 —— 先在这里查一遍，': 'Downloads stuck, updates not found, disk filling up — check here first,',

  // ---- 系统概览 ----
  '系统概览': 'System overview',
  '显卡显存': 'GPU VRAM',
  'CPU 占用': 'CPU usage',
  'CPU 核数': 'CPU cores',
  'GPU 占用': 'GPU usage',
  '显卡': 'GPU',
  '没有检测到独立显卡': 'No discrete GPU detected',
  '机器信息': 'Machine info',
  '正在运行的模型': 'Running models',
  '显存去哪了': 'Where the VRAM went',
  '最近用了多少': 'Recent usage',
  '快速操作': 'Quick actions',
  '装模型': 'Get a model',
  '跑体检': 'Run checks',
  '测速度': 'Benchmark',
  '聊两句': 'Chat',
  '备份配置': 'Back up config',
  '导出报告': 'Export report',
  '空��': 'Idle',
  '其它程序': 'Other programs',
  '模型权重': 'Model weights',
  'KV cache': 'KV cache',
  '空闲': 'Free',
  '用掉的显存大部分不是模型占的 —— 可能是游戏、渲染软件或别的 AI 程序，关掉它们能立刻腾出空间。': 'Most of the VRAM is not used by the model — it may be a game, a renderer or another AI app. Closing them frees space immediately.',
  '上下文越大，KV cache 占得越多 —— 上下文从 8K 开到 32K，光 KV cache 就会多吃几 GB。': 'The bigger the context, the more KV cache it takes — going from 8K to 32K costs several GB of KV cache alone.',

  // ---- 模型管理 ----
  '模型管理': 'Models',
  '已安装的模型': 'Installed models',
  '加装新模型': 'Add a model',
  '搜官方模型库（联网时可用）': 'Search the official library (needs internet)',
  '能力': 'Capabilities',
  '工具调用': 'Tool use',
  '看图': 'Vision',
  '深度思考': 'Deep thinking',
  '向量化': 'Embeddings',
  '排序': 'Sort',
  '按名称': 'By name',
  '按体积（大的在前）': 'By size (largest first)',
  '按安装时间（新在前）': 'By date (newest first)',
  '搜索已装模型': 'Search installed models',
  '批量删除': 'Delete selected',
  '起别名': 'Add alias',
  '使用中': 'In use',
  '本机已有': 'Already on this machine',
  '推荐': 'Recommended',
  '已安装': 'Installed',
  '从 Ollama 官方模型库下载。名字形如': 'Download from the official Ollama library. Names look like',
  '可以从下面的输入框直接写模型名。': 'You can also type a model name in the box below.',
  '模型名不合法，只能用小写字母、数字和': 'Invalid model name — only lowercase letters, digits and',
  '空间占用': 'Disk usage',
  '下载中断会在模型目录里留下没人引用的分片。删掉不影响已装的模型。': 'Interrupted downloads leave unreferenced shards in the model folder. Removing them does not affect installed models.',
  '还没找到模型目录。': 'Model folder not found.',
  '目录是空的。': 'The folder is empty.',
  '空间分析': 'Disk analysis',
  '共用的基础层不占额外空间。': 'Shared base layers do not take extra space.',

  // ---- 试用 ----
  '试用': 'Try it',
  '用哪个模型': 'Model to use',
  '从已安装的模型里选。切换后工作台会用新模型，不用重装。': 'Pick from the installed models. The workbench switches without reinstalling.',
  '随机性 temperature': 'Temperature',
  '0 最稳（适合代码、事实类问题），1 以上更发散（适合创意）。': '0 is most predictable (code, factual questions); above 1 is more creative.',
  '系统提示（可选）': 'System prompt (optional)',
  '给它一个角色或规则，比如「你是一个只会说人话的助手」。': 'Give it a role or rule, e.g. "you are an assistant that speaks plainly".',
  '留空 = 模型的默认设定': 'Empty = model default',
  '对话': 'Conversation',
  '新对话': 'New chat',
  '删除': 'Delete',
  '对话会自动保存，关掉浏览器也在。': 'Conversations are saved automatically — they survive closing the browser.',
  '输入消息，Ctrl+Enter 发送': 'Type a message, Ctrl+Enter to send',
  '发送': 'Send',
  '停止': 'Stop',
  '重新生成': 'Regenerate',
  '导出对话（Markdown）': 'Export chat (Markdown)',
  '复制对话': 'Copy chat',
  '上下文占用': 'Context usage',
  '还能聊': 'Turns left',
  '快满了 —— 再聊下去就该触发压缩了': 'Nearly full — the next turns will trigger compaction',
  '还很宽裕': 'Plenty of room',
  '用掉一半以上了': 'More than half used',

  // ---- 模型对比 ----
  '模型对比': 'Model comparison',
  '用在哪': 'What it is for',
  '「换个模型会不会更好」是最难自己判断的问题。同一个问题': '"Is a different model better?" is hard to judge on your own. Asking the same question to',
  '同时问几个模型，并排一看就清楚了。': 'several models at once and comparing them side by side settles it.',
  '要比哪些模型': 'Models to compare',
  '最多 4 个。只能选已安装的模型。': 'Up to 4. Installed models only.',
  '问什么': 'Question',
  '同一个问题会原样发给每个模型。': 'The same question is sent to every model.',
  '开始对比': 'Start comparison',
  '最多 4 个模型，依次跑（并发会互相抢显存）。': 'Up to 4 models, run one by one (concurrent runs fight over VRAM).',
  '哪个模型更适合这台机器': 'Which model fits this machine best',
  '按你现在的显卡、内存和已装模型估的适配度。': 'A fit score based on your GPU, RAM and installed models.',
  '只是估算，但比凭感觉选靠谱。': 'It is only an estimate, but better than guessing.',
  '正在思考…': 'Thinking…',
  '没有返回内容': 'No content returned',
  '模型没有返回内容': 'The model returned nothing',

  // ---- 性能基准 ----
  '性能基准': 'Benchmark',
  '什么时候用': 'When to use it',
  '「感觉有点慢」到底是': 'Whether "it feels slow" is really',
  '这两种慢的解法完全不一样，这里分开测。': 'these two very different problems — measured separately here.',
  '测哪个模型': 'Model to test',
  '第一次测会把模型读进显存，可能要等十几秒，属正常。': 'The first run loads the model into VRAM; a ten-second wait is normal.',
  '重复次数': 'Repetitions',
  '取中位数。次数越多越准，也越慢。': 'The median is used. More runs are more accurate but slower.',
  '开始测速': 'Start benchmark',
  '大约 30 秒。': 'About 30 seconds.',
  '结果': 'Result',
  '和同档显卡比': 'Compared to a GPU of the same class',
  '速度变化': 'Speed over time',
  '清空测速历史': 'Clear benchmark history',
  '导出 CSV': 'Export CSV',
  '导出 Markdown': 'Export Markdown',
  '和历史最佳比': 'Against your best run',
  '历史最佳': 'Best run',
  '历史平均': 'Average',
  '这次': 'This run',
  '没有历史数据': 'No history yet',
  '再测一次就能和上次比了': 'Run it once more to compare',
  '这说明什么': 'What this means',
  '没有建议': 'No advice',
  '生成速度': 'Generation speed',
  '读提示词速度': 'Prompt processing speed',
  '读提示词': 'Prompt processing',
  '同档参考': 'Reference',
  '同档显卡参考': 'Same-class GPU reference',
  '单次耗时': 'Time per run',
  '这次比最佳快': 'Faster than your best by',
  '模型': 'Model',

  // ---- 上下文与模型 ----
  '说明': 'Note',
  '这里改的是': 'What you change here is',
  '工作台真正使用的配置': 'the configuration the workbench actually uses',
  '，和重跑安装向导效果一致。改完点「应用」，': ' — same as rerunning the wizard. Click "Apply" when done,',
  '，再重启工作台才生效。': 'then restart the workbench for it to take effect.',
  '页直接改，不用重跑安装向导。': 'page directly — no need to rerun the wizard.',
  '使用的模型': 'Model in use',
  '上下文长度（窗口）': 'Context length (window)',
  '一次对话最多能装多少 token。越大越能记住前文，但也越吃显存、越慢。': 'How many tokens one conversation holds. Larger remembers more but uses more VRAM and is slower.',
  '高级：自己定输出上限与压缩参数': 'Advanced: set output and compaction limits yourself',
  '留空 = 按窗口自动推导。压缩余量太小会让压缩过于频繁，太大会让压力预算变成负数——那样压缩会被静默禁用，': 'Empty = derived from the window. Too small a headroom compacts too often; too large makes the pressure budget negative — compaction is then silently disabled,',
  '表现就是「聊久了回答越来越短」。下面的实时检查会替你算。': 'which shows up as "answers get shorter as the chat goes on". The live check below does the maths for you.',
  '实时检查': 'Live check',
  '压力预算': 'Pressure budget',
  '判读': 'Reading',
  '可用。会话涨到约': 'Usable. Compaction triggers around',
  '负数 —— 压缩会被静默禁用，表现是「聊久了回答越来越短」。必须调小输出上限或压缩余量': 'Negative — compaction is silently disabled, showing up as "answers get shorter over time". Lower the output limit or headroom',
  '实际生效': 'In effect',
  '窗口是怎么被分掉的': 'How the window is divided',
  '绿色那段就是留给对话的余量 —— 会话涨满它的时候就会触发压缩。': 'The green part is the room left for the conversation — compaction fires when it fills up.',
  '余量为负：压缩不会触发，等于被静默禁用。': 'Negative headroom: compaction never fires — it is silently disabled.',
  '变更预览': 'Change preview',
  '没有改动': 'No changes',
  '应用配置': 'Apply configuration',
  '全部改回自动': 'Reset all to automatic',
  '重新读取': 'Reload',
  '应用前会自动备份原来的 配置.json 与两个 profile 文件。': 'The original 配置.json and both profile files are backed up before applying.',
  '已写入。': 'Written.',
  '重启工作台后生效': 'Takes effect after restarting the workbench',
  '（已备份': '(backed up',
  '个文件）': 'files)',
  '没有写入：': 'Not written:',
  '已清空高级项，将按窗口自动推导（记得点「应用配置」）': 'Advanced fields cleared; they will be derived from the window (remember to click "Apply")',
  '已重新读取配置': 'Configuration reloaded',
  '模型': 'Model',
  '未设置模型': 'No model set',

  // ---- 模型体检 ----
  '模型体检': 'Model check',
  '回答变短、长对话跑偏、同一问题有时对有时错 —— 先跑一次，': 'Answers getting shorter, long chats drifting, the same question giving different results — run this once,',
  '别急着换显卡': 'do not blame the GPU yet',
  '多数情况是配置问题，不是模型不行。': 'Most of the time it is a configuration problem, not a bad model.',
  '开始体检': 'Start check',
  '快速体检（跳过 32K）': 'Quick check (skips 32K)',
  '完整版约 40 秒。只读模型接口、只写报告文件，': 'The full run takes about 40 seconds. It only reads the model API and writes a report file,',
  '不改任何配置。': 'and changes no configuration.',
  '结果': 'Result',
  '各分类通过率': 'Pass rate by category',
  '成绩变化': 'Score over time',
  '清空体检历史': 'Clear check history',
  '导出 CSV': 'Export CSV',
  '导出 Markdown': 'Export Markdown',
  '记录文件：': 'History file:',
  '没有拿到检查结果': 'No results',
  '没有拿到分类明细': 'No per-category details',
  '怎么读这个结果': 'How to read this',
  '质量基线': 'Quality baseline',
  '21 道机器可判分的题，低于 90% 说明能力真的掉了 —— 该换更高的量化档': '21 machine-checkable questions; below 90% the capability really dropped — switch to a higher quantisation',
  '长上下文漂移': 'Long-context drift',
  '上下文越长答案越容易变。把窗口控制在漂移起点以内就行': 'The longer the context, the more the answer drifts. Keep the window below the drift point.',
  '采样稳定性': 'Sampling stability',
  '同一个问题连问几次，答案是否一致。不一致说明不是「笨」，是采样参数不稳': 'Ask the same question several times — are the answers the same? If not, it is unstable sampling, not stupidity.',
  '未通过的题': 'Failed questions',
  '耗时': 'Elapsed',
  '体检失败': 'Check failed',
  '正在跑，别关这个窗口…': 'Running — do not close this window…',

  // ---- 修复中心 ----
  '什么时候用': 'When to use it',
  '用不上的时候先点「重新检查」，看看是哪一环断了；能自动修的直接一键修，不用重装。': 'When something does not work, hit "Re-check" to see which link is broken — most things can be fixed in one click, without reinstalling.',
  '重新检查': 'Re-check',
  '逐项结果': 'Item by item',
  '一切正常': 'Everything is fine',
  '这套配置现在是可以用的。': 'This setup works right now.',
  '发现问题': 'Problems found',
  '正常': 'OK',
  '注意': 'Warning',
  '有问题': 'Problem',
  '修复成功': 'Fixed',
  '没有可修的项': 'Nothing to fix',

  // ---- 诊断与维护 ----
  '诊断与维护': 'Diagnostics',
  '出问题时': 'When something breaks',
  '下载不动、更新查不到、硬盘越来越满 —— 先在这里查一遍，不用重装。': 'Downloads stuck, updates not found, disk filling up — check here first, no reinstall needed.',
  '网络连通性': 'Network',
  '检查网络': 'Check network',
  '探测模型官网 / 模型仓库 / GitHub 通不通，并告诉你是不是代理的问题': 'Pings the model site, the model registry and GitHub, and tells you whether a proxy is the problem',
  '清理下载残留': 'Clean up leftovers',
  '检查残留': 'Check leftovers',
  '清理': 'Clean up',
  '没有需要清理的东西': 'Nothing to clean up',
  '下载中断会在模型目录里留下没人引用的分片。删掉不影响已装的模型。': 'Interrupted downloads leave unreferenced shards in the model folder. Removing them does not affect installed models.',
  '诊断报告': 'Diagnostic report',
  '把环境、配置、日志打包成一个文件，发给别人就能直接看到问题在哪（自动去掉用户名和令牌）。': 'Bundles the environment, configuration and logs into one file so someone else can see the problem straight away (usernames and tokens are stripped).',
  '下载诊断报告': 'Download diagnostic report',
  '把那个文件发给别人，对方就能直接看到问题在哪。': 'Send that file to someone and they can see the problem immediately.',
  '网络都通，模型应该能正常下载。': 'Everything is reachable — models should download normally.',
  '没找到代理设置。如果你平时上网必须走代理，请在安装向导的「存放位置 → 设置网络代理」里填上代理地址。': 'No proxy configured. If you normally need a proxy, set one in the wizard under "Location → network proxy".',

  // ---- 服务 ----
  '服务': 'Services',
  '这一页是「现在有哪些东西在跑」。': 'This page shows what is running right now.',
  '停服务前先看一眼': 'Check this before stopping',
  '别把不该关的关了。': 'so you do not stop something you meant to keep.',
  'Strata 引擎': 'Strata engine',
  'WebUI（聊天/文件）': 'WebUI (chat / files)',
  'DeepSeek Harness': 'DeepSeek Harness',
  'Ollama（模型服务）': 'Ollama (model service)',
  '运行中': 'Running',
  '未就绪': 'Not ready',
  '启动引擎': 'Start engine',
  '启动 WebUI': 'Start WebUI',
  '启动工作台': 'Start workbench',
  '引擎运行中': 'Engine running',
  'WebUI 运行中': 'WebUI running',
  '工作台运行中': 'Workbench running',
  '服务已停止': 'Services stopped',
  '「停止全部服务」会关掉引擎、WebUI 和工作台，显存会立刻释放。': '"Stop all services" shuts down the engine, WebUI and workbench, freeing VRAM immediately.',
  '停止服务会把显存还给游戏和渲染软件。': 'Stopping services gives VRAM back to games and renderers.',

  // ---- 服务设置 ----
  '服务设置': 'Service settings',
  '这些开关都是': 'These switches are',
  '立刻生效': 'applied immediately',
  '的，改完不用重启电脑。': ' — no need to restart the computer.',
  '开机自动启动工作台': 'Start the workbench at boot',
  '打开后每次开机自动启动服务并加载模型（会占着显存）。平时想自己控制的话就别开。': 'Starts the services and loads the model on every boot (this holds VRAM). Leave it off if you prefer to control it yourself.',
  '局域网共享（把模型开放给同网络的其它设备）': 'Share on the local network',
  '打开后，同一个 WiFi 下的手机、平板、其它电脑都能调用你机器上的模型。': 'Lets phones, tablets and other computers on the same WiFi use the models on this machine.',
  '⚠️ 打开局域网共享前请想清楚：': 'Think carefully before enabling LAN sharing:',
  '这会把 Ollama 的接口暴露到整个局域网（': 'This exposes the Ollama API to the whole local network (',
  '）。': ').',
  '在公共 WiFi、宿舍网、公司网里，': 'On public WiFi, dormitory or office networks,',
  '同网段的任何人都能用你的显卡跑模型，也能看到你正在用的模型。': 'anyone on the same subnet can use your GPU and see which models you are running.',
  '只在': 'Only on',
  '你信任的家庭网络': 'a home network you trust',
  '里打开；用完建议关掉。': ' — and turn it off when you are done.',
  '我知道了，仍然要打开': 'I understand, enable it anyway',
  '确认打开': 'Enable',
  '服务控制': 'Service control',
  '启动工作台': 'Start workbench',
  '「启动工作台」等于双击桌面上的「启动本地AI」。': '"Start workbench" is the same as double-clicking "Start local AI" on the desktop.',
  '快捷入口': 'Shortcuts',
  '打开安装目录': 'Open install folder',
  '打开模型目录': 'Open model folder',
  '当前配置': 'Current configuration',
  '要改模型、上下文长度或压缩参数，去左侧「': 'To change the model, context length or compaction parameters, use the "',
  '卸载': 'Uninstall',
  '会在新窗口里打开卸载程序。它会先把「要删什么、不删什么」列清楚，': 'Opens the uninstaller in a new window. It first spells out what will and will not be deleted,',
  '再逐条问你确认 —— 不会直接删东西。': 'then asks you to confirm each item — nothing is deleted silently.',
  '备份与搬家': 'Backup & migration',
  '导出配置': 'Export configuration',
  '导入配置': 'Import configuration',
  '导出会把「模型、模型目录、上下文、压缩参数」和 dsh 的两个 profile 一起存成一个 JSON。': 'Exports the model, model folder, context and compaction settings plus the two dsh profiles into one JSON file.',
  '换电脑时把那个文件带过去，导入就能还原。': 'Take it to the new machine and import it to restore everything.',
  '离线安装包': 'Offline package',
  '给没网的机器装：把整套打成一个 zip，拷过去解压双击就行。': 'For machines without internet: bundle everything into a zip, copy it over, unzip and double-click.',
  '生成离线安装包': 'Build offline package',
  '带上便携 Node（目标机器没 Node 时需要）': 'Include portable Node (needed if the target has none)',
  '日志与版本': 'Logs & version',
  '查看日志': 'View log',
  '检查更新': 'Check for updates',
  '有新版本：': 'New version available:',
  '已经是最新版本（': 'Already up to date (',
  '）': ')',
  '检查失败：': 'Check failed:',
  '日志位置：': 'Log file:',
  '服务自愈': 'Self-healing',
  'Ollama 掉了自动重启': 'Restart Ollama if it dies',
  '显卡驱动更新、误关托盘程序、休眠没恢复时，Ollama 会意外退出。': 'Ollama can exit unexpectedly after a driver update, if the tray app is closed, or after sleep.',
  '打开这个开关，控制台会每 15 秒检查一次，发现掉了就自动拉起来。': 'With this on, the console checks every 15 seconds and restarts it if it is gone.',
  '默认关闭': 'Off by default',
  '擅自拉起服务会占显存。': 'restarting a service on its own takes VRAM.',
  '配置检查点': 'Config checkpoints',
  '每次改配置前都会自动留一份。改坏了可以一键退回来。': 'A copy is kept before every config change. Roll back if something goes wrong.',
  '还没有检查点。': 'No checkpoints yet.',
  '改一次配置就会自动留一份。': 'One is kept the next time you change the configuration.',
  '快捷键': 'Keyboard shortcuts',
  '点一下键位再按新键，就能改。改完立刻生效。': 'Click a shortcut then press a new key. It takes effect immediately.',
  '界面大小': 'Interface size',
  '字号缩放': 'Text size',
  '字太小看不清就调大一点。浏览器缩放（Ctrl +）也可以，但只影响这个页面。': 'Make the text bigger if it is hard to read. Browser zoom (Ctrl +) works too but only affects this page.',
  '主题': 'Theme',
  '跟随系统': 'Follow system',
  '浅色': 'Light',
  '深色': 'Dark',
  '按时段（白天浅 / 晚上深）': 'By time of day (light by day, dark at night)',

  // ---- 帮助 ----
  '帮助': 'Help',
  '第一次用的话，读完这一页就够了。别的都能自己摸索。': 'If this is your first time, reading this page is enough. Everything else you can work out.',
  '遇到问题按这个顺序查': 'When something breaks, check in this order',
  '它会直接告诉你哪一环断了，很多问题一键就好。': 'It tells you which link is broken — many things are fixed with one click.',
  '模型下不来，八成是网络或代理。': 'Models not downloading is usually the network or a proxy.',
  '把那个文件发给别人，对方就能直接看到问题在哪。': 'Send that file to someone and they can see the problem immediately.',
  '看日志': 'Read the log',
  '服务设置页里点「查看日志」，或在': 'Click "View log" on the settings page, or look at',
  '完整文档': 'Full documentation',
  '项目根目录里有': 'The project folder contains',
  '（双击用浏览器打开）、': ' (open it in a browser),',
  '在线版：': 'Online:',
  'GitHub 仓库': 'GitHub repository',

  // ---- 命令面板 / 引导 ----
  '输入命令或页面名…（Esc 关闭）': 'Type a command or page name… (Esc to close)',
  '↑↓ 选择 · Enter 执行 · Esc 关闭': '↑↓ to select · Enter to run · Esc to close',
  '没有匹配的命令': 'No matching command',
  '已装模型': 'Installed model',
  '命令面板': 'Command palette',
  '用不上时怎么排查': 'How to troubleshoot',
  '怎么换模型': 'How to switch models',
  '重新看一遍使用引导': 'Show the introduction again',
  '欢迎来到本地 AI 控制台': 'Welcome to the Local AI Console',
  '这里能管模型、聊模型、测模型、修问题。': 'It manages models, lets you chat, benchmark and repair.',
  '「系统概览」先看一眼': 'Start with the system overview',
  '显存被模型占了多少、还剩多少，准备打游戏之前来这里确认一下就知道。': 'See how much VRAM the models take and how much is left — check before gaming.',
  '出问题先别重装': 'Do not reinstall when something breaks',
  '「诊断与维护」能查网络、清残留、导出报告；「修复中心」能一键修好常见问题。': 'Diagnostics checks the network, cleans leftovers and exports a report; the Repair Center fixes common problems in one click.',

  // ---- 通知 ----
  '通知': 'Notifications',
  '清空': 'Clear',
  '还没有通知': 'No notifications',
  '下载完成': 'Download complete',
  '下载失败': 'Download failed',
  '体检不达标': 'Check did not pass',

  // ---- 空状态 ----
  '还没有装任何模型': 'No models installed yet',
  '模型是本地 AI 的「大脑」，至少要有一个才能开始用。': 'Models are the brain of local AI — you need at least one to start.',
  '去装一个': 'Get one',
  '现在没有模型驻留显存': 'No model is holding VRAM right now',
  '这说明显存已经全部还给游戏 / 渲染软件了 —— 状态正常。': 'All the VRAM has been handed back to games and renderers — that is normal.',
  '模型目录还是空的': 'The model folder is still empty',
  '装好第一个模型后，这里会显示每个模型各占多少空间。': 'Once a model is installed, this page shows how much space each one takes.',
  '还没有历史记录': 'No history yet',
  '每跑一次体检 / 测速就会留下一条记录，跑两次就能看出变化趋势。': 'Every check and benchmark leaves a record. Two runs are enough to see a trend.',
  '跑一次体检': 'Run a check',
  '还没有测过速': 'No benchmark yet',
  '测一次就知道「慢」是生成慢还是读上下文慢 —— 这两种解法完全不同。': 'One run tells you whether "slow" means slow generation or slow context reading — completely different fixes.',
  '开始测速': 'Start benchmark',
  '搜一下官方库，几百个模型里挑一个合适的。': 'Search the official library to pick from hundreds of models.',
  '没有已安装的模型': 'No models installed',
  '先去「模型管理」装一个，装完这里就能看到每个模型的能力了。': 'Install one in "Models" and the capabilities of each model show up here.',

  // ---- 错误码表 ----
  '显存不够': 'Not enough VRAM',
  '模型 + 上下文超过了显卡能装的量。': 'The model plus the context exceed what the GPU can hold.',
  '把上下文调小一档，或者换一个更小的模型。': 'Lower the context one step, or use a smaller model.',
  '模型不在 Ollama 里': 'Model not found in Ollama',
  '配置里写的模型名，和 Ollama 里实际装的不是同一个。': 'The configured model name does not match what is actually installed.',
  '去「模型管理」看看装了什么，然后把配置改成正确的名字。': 'Check what is installed in "Models" and correct the name in the configuration.',
  '连不上 Ollama': 'Cannot reach Ollama',
  'Ollama 服务没在运行，或者被防火墙拦了。': 'The Ollama service is not running, or a firewall is blocking it.',
  '去「服务」页把 Ollama 启起来。': 'Start it from the "Services" page.',
  '等太久了': 'Timed out',
  '模型第一次加载要读硬盘，几 GB 的模型可能要十几秒；网络请求超时多半是网速慢。': 'Loading a model for the first time reads several GB from disk; a slow network also causes timeouts.',
  '先等一等再试；如果总超时，去「诊断与维护」检查网络。': 'Wait and retry; if it keeps timing out, check the network under "Diagnostics".',
  '磁盘空间不够': 'Not enough disk space',
  '模型还没下完，或者残留文件太多。': 'The model is not fully downloaded, or there are too many leftovers.',
  '换个盘，或者去「诊断与维护」清理下载残留。': 'Use a different drive, or clean up leftovers under "Diagnostics".',
  '没有权限': 'Permission denied',
  '文件被别的程序占着，或者需要管理员权限。': 'A file is held by another program, or administrator rights are needed.',
  '关掉正在用这个文件的程序，或以管理员身份运行一次。': 'Close whatever is using the file, or run once as administrator.',
  '端口被占用了': 'Port already in use',
  '另一个程序用了同一个端口。': 'Another program is using the same port.',
  '关掉那个程序，或改用别的端口。': 'Close it, or use a different port.',
  '安装包校验没通过': 'Package verification failed',
  '下载的文件不完整或被改过 —— 出于安全考虑不会安装。': 'The download was incomplete or modified, so it will not be installed.',
  '重新下载一遍（换个网络可能更稳）。': 'Download it again — a different network may be more reliable.',
  '代理没生效': 'Proxy not applied',
  'Node 自带的 fetch 不认系统代理设置，Ollama 才认。': 'Node’s own fetch ignores system proxy settings; Ollama honours them.',
  '在安装向导的「存放位置 → 设置网络代理」里填代理地址。': 'Set the proxy in the wizard under "Location → network proxy".',

  // ---- 安装向导 ----
  '正在检测你的电脑': 'Checking your computer',
  '安装向导会自动识别显卡、磁盘和已装好的组件 —— 这一步你什么都不用做。': 'The wizard detects your GPU, disks and installed components — there is nothing for you to do.',
  '接下来只需要三步': 'Only three steps to go',
  '选模型': 'Pick a model',
  '已按你的显卡推荐好': 'Already chosen for your GPU',
  '选存放位置': 'Pick a location',
  '点一下磁盘就行': 'Just click a disk',
  '自动安装': 'Install automatically',
  '不用再操作，等它跑完': 'Nothing to do, just wait',
  '重新检测': 'Re-check',
  '刚装了显卡驱动 / Ollama？点这里重新检测一次。': 'Just installed a driver or Ollama? Hit re-check.',
  '不想选？直接按推荐装': 'Don\'t want to choose?',
  '用检测到的推荐值一步到位。选错了还能退回来改。': 'Use the recommended values in one go. You can still go back and change them.',
  '会装': 'Will install',
  '，窗口': ', context window',
  '，放在': ', stored in',
  '。选错了还能退回来改。': '. You can still go back and change it.',
  '开始安装': 'Start installing',
  '模型存放在哪个盘': 'Where to store the models',
  '怎么做': 'How to',
  '点一下要存放的磁盘（建议选非系统盘、空间大的那块）': 'Click the drive to use (a non-system drive with plenty of space is best)',
  '点右下角「开始安装」': 'then click "Start installing"',
  '模型约需': 'About',
  'GB 空间。': ' GB needed.',
  '没有找到可用空间 ≥ 20 GB 的磁盘。': 'No drive with ≥20 GB free was found.',
  '请在「此电脑」里清理出空间，或者直接在下面手动填一个路径，然后点「重新检测」。': 'Free up space in File Explorer, or type a path below and hit re-check.',
  '建议避开叠瓦盘（SMR）': 'Avoid SMR drives if you can',
  '这类硬盘持续写入会掉速、寿命也差。拿不准就选 SSD，或选那块较新的机械硬盘。': 'They slow down under sustained writes and wear out faster. Prefer an SSD, or a newer spinning drive.',
  '将安装到：': 'Installing to:',
  '下载太慢 / 连不上模型仓库？设置网络代理（可选）': 'Downloads too slow or the model registry is unreachable? Set a proxy (optional)',
  '如果你平时上网需要走代理（Clash、v2ray 之类），把它的 HTTP 代理地址填在这里，模型下载就会走这个代理。不需要就直接留空。': 'If you normally browse through a proxy (Clash, v2ray and the like), put its HTTP proxy address here so model downloads use it. Leave empty if you do not need one.',
  '正在安装，请勿关闭': 'Installing — do not close',
  '全部自动完成，你只需要等它跑完。': 'Everything happens automatically; just wait for it to finish.',
  '请保持这个页面开着': 'Keep this page open',
  '也不要关掉那个黑色窗口 —— 关掉就等于中断安装。': 'and do not close the black window — closing it aborts the installation.',
  '（中断了也没关系，重新双击「① 双击这里开始安装.cmd」会接着装，已下载的部分不会重下）': '(If it is interrupted, run "① 双击这里开始安装.cmd" again — it resumes, and what was already downloaded is not fetched twice)',
  '安装进度': 'Installation progress',
  '下载模型': 'Downloading model',
  '安装没有完成': 'Installation did not finish',
  '重试安装': 'Retry installation',
  '重新检测': 'Re-check',
  '复制诊断信息': 'Copy diagnostics',
  '打开日志': 'Open log',
  '你可以这样做：': 'What you can do:',
  '重试不会从头再来：已经装好的步骤会自动跳过，模型也支持续传。': 'Retrying does not start over: finished steps are skipped and the model download resumes.',
  '安装完成，可以开始用了': 'Installation finished — you are ready to go',
  '以后就用桌面上的三个图标（启动 / 停止 / 控制台），不用再打开这个向导。': 'From now on use the three desktop icons (start / stop / console). No need to open this wizard again.',
  '以后怎么用（就两步）': 'How to use it from here (two steps)',
  '想用 AI —— 双击桌面上的「启动本地AI」': 'To use AI — double-click "Start local AI" on the desktop',
  '会弹出一个黑色窗口，然后自动打开浏览器里的工作台。那个黑窗口要一直开着，它就是服务本体。': 'A black window appears and the workbench opens in your browser. Keep that window open — it is the service itself.',
  '不想用了 / 要玩游戏 —— 双击「停止本地AI」': 'To stop or play games — double-click "Stop local AI"',
  '把显存还给游戏和渲染软件。下次要用再双击「启动本地AI」就行。': 'It gives VRAM back to games and renderers. Start it again whenever you need it.',
  '立即启动工作台': 'Start the workbench now',
  '打开安装目录': 'Open install folder',
  '装完跑一次体检': 'Run a check after installing',
  '体检已启动': 'Check started',
  '大约 20 秒。装完想立刻知道状态，就点一下这里。': 'About 20 seconds. Click here to know the state right after installing.',
  '体检失败': 'Check failed',
  '安装向导已关闭': 'Setup wizard closed',
  '可以关掉这个页面和那个黑色窗口了。': 'You can close this page and the black window now.',
  '以后要用 AI，双击桌面上的「启动本地AI」。': 'To use AI later, double-click "Start local AI" on the desktop.',
  '已用管理员身份重新打开': 'Reopened with administrator rights',
  '请看新弹出的窗口和浏览器标签页，继续完成安装。': 'Look at the new window and browser tab to continue the installation.',
  '===== 以上内容可直接发给帮你排查的人 =====': '===== The text above can be sent directly to whoever helps you =====',
  '===== 本地 AI 安装向导 诊断信息 =====': '===== Local AI setup wizard diagnostics =====',
  '--- 出错信息 ---': '--- Error ---',
  '--- 环境 ---': '--- Environment ---',
  '--- 安装日志（最后 60 行）---': '--- Install log (last 60 lines) ---',

  // ---- 第二批 ----

  'Ollama 已启动': 'Ollama started',
  'Ollama 里已有，不用重下': 'Already in Ollama — no need to download',
  '○ 未就绪 · :': '○ Not ready · :',
  '● 运行中 · :': '● Running · :',
  '「修复中心」→ 重新检查': '"Repair Center" → Re-check',
  '「诊断与维护」→ 下载诊断报告': '"Diagnostics" → Download diagnostic report',
  '「诊断与维护」→ 检查网络': '"Diagnostics" → Check network',
  '会在新窗口里打开卸载程序。它会先把「要删什么、不删什么」列清楚， 再逐条问你确认 —— 不会直接删东西。':
    'Opens the uninstaller in a new window. It first lists what will and will not be deleted, then asks you to confirm each item — nothing is deleted silently.',
  '会放到 %TEMP%\\local-ai-offline 目录。': 'It will be placed in %TEMP%\\local-ai-offline.',
  '偏低': 'Slightly low',
  '加装': 'Add',
  '加装 / 删除模型时会自动帮你启动': 'It starts automatically when you add or delete models',
  '动作': 'Action',
  '卸载本地 AI': 'Uninstall local AI',
  '压缩余量': 'Compaction headroom',
  '压缩阈值': 'Compaction threshold',
  '去「模型体检」看是哪一类掉了': 'See which category dropped under "Model check"',
  '去服务': 'Go to services',
  '去模型管理': 'Go to models',
  '去系统概览': 'Go to overview',
  '去试用': 'Go to try it',
  '只是估算': 'Only an estimate',
  '只能用很小的模型，速度会很慢': 'Only very small models can run, and they are slow',
  '只能选已安装的模型。切换后下一条消息就用新的模型。': 'Installed models only. The next message uses the new model.',
  '可以在「试用」页直接跟它对话了': 'You can chat with it under "Try it"',
  '可以安装到任意位置': 'Can install to any location',
  '可以正常管理模型': 'Models can be managed normally',
  '可以连续加几个，它们会排队依次下载 —— 不用等一个下完再输下一个。':
    'Add several at once — they queue up and download one after another, no need to wait for the first to finish.',
  '可用余量': 'Room left',
  '同时问几个模型': 'Ask several models at once',
  '同网段的任何人都能用你的显卡跑模型': 'anyone on the same subnet can use your GPU',
  '名字只能用小写字母、数字和 . - _ / :': 'Names may only use lowercase letters, digits and . - _ / :',
  '名称': 'Name',
  '启动': 'Start',
  '启动失败': 'Failed to start',
  '启动安装': 'Start the installation',
  '在「试用」页聊过之后这里会有记录': 'Records appear here after you chat under "Try it"',
  '在一处查看服务状态，启动对话或让 Agent 动手干活。': 'See the service status, start a chat, or let an agent work — all in one place.',
  '型号': 'Model',
  '复制失败，请打开日志手动复制': 'Copy failed — open the log and copy it manually',
  '失败': 'Failed',
  '安装 DeepSeek Harness': 'Installing DeepSeek Harness',
  '安装中断了 —— 看上面的「你可以这样做」': 'Installation interrupted — see "What you can do" above',
  '安装完成': 'Installation finished',
  '安装完成 —— 点「完成」关闭向导': 'Installation finished — click "Done" to close the wizard',
  '安装时会自动帮你装好': 'It will be installed automatically during setup',
  '安装过程': 'Installation',
  '安装过程约 1–3 分钟': 'Installation takes about 1–3 minutes',
  '导出会把「模型、模型目录、上下文、压缩参数」和 dsh 的两个 profile 一起存成一个 JSON。 换电脑时把那个文件带过去，导入就能还原。':
    'The export bundles the model, model folder, context and compaction settings together with the two dsh profiles into one JSON file. Take it to the new machine and import it to restore everything.',
  '尺寸多': 'Most sizes',
  '已下载': 'Downloaded',
  '已修复': 'Fixed',
  '已停止': 'Stopped',
  '已关闭局域网共享，Ollama 只监听本机': 'LAN sharing off — Ollama only listens locally',
  '已关闭开机自启': 'Boot autostart disabled',
  '已关闭自愈': 'Self-healing disabled',
  '已创建别名': 'Alias created',
  '已删除': 'Deleted',
  '已刷新': 'Refreshed',
  '已取消': 'Cancelled',
  '已启动': 'Started',
  '已回滚': 'Rolled back',
  '已在新窗口打开卸载程序，按它的提示操作即可': 'The uninstaller opened in a new window — follow its instructions',
  '已处理': 'Done',
  '已复制到剪贴板': 'Copied to the clipboard',
  '已安装并运行中': 'Installed and running',
  '已完成': 'Finished',
  '已导出为 Markdown': 'Exported as Markdown',
  '已导出到「下载」目录': 'Exported to your Downloads folder',
  '已开启局域网共享 —— 同网络的设备可以用 http://你的IP:11434 访问':
    'LAN sharing on — other devices can use http://YOUR-IP:11434',
  '已开启开机自启': 'Boot autostart enabled',
  '已开启自愈：Ollama 掉了会自动重启': 'Self-healing on — Ollama restarts if it dies',
  '已开新对话': 'New conversation started',
  '已按推荐填好，点「开始安装」即可': 'Filled in with the recommended values — click "Start installing"',
  '已重新检测 —— 点右下角「继续」': 'Re-checked — click "Continue" at the bottom right',
  '干嘛用': 'What it is for',
  '引导': 'Guide',
  '引擎页面 ↗': 'Engine page ↗',
  '待安装': 'To be installed',
  '快捷键：Ctrl+K 命令面板 · 1-0 切换页面 · R 刷新 · / 搜索':
    'Shortcuts: Ctrl+K command palette · 1-0 switch pages · R refresh · / search',
  '性价比': 'Value',
  '总体通过率': 'Overall pass rate',
  '总耗时': 'Total time',
  '我自己装': 'I will install it myself',
  '打包中…': 'Packaging…',
  '打开 Agent ↗': 'Open Agent ↗',
  '打开后，每次开机都会自动启动服务并加载模型（会占着显存）。平时想自己控制的话就别开。':
    'When on, the services and model start on every boot (this holds VRAM). Leave it off if you prefer to control it yourself.',
  '打开命令面板': 'Open the command palette',
  '打开失败': 'Could not open',
  '打开聊天 ↗': 'Open chat ↗',
  '把环境、配置、日志打包成一个文件，发给别人就能直接看到问题在哪（已自动去掉用户名和令牌）。':
    'Bundles the environment, configuration and logs into one file so someone else can see the problem straight away (usernames and tokens are stripped).',
  '按下新键…（Esc 取消）': 'Press a new key… (Esc to cancel)',
  '换个模型试试效果': 'Try a different model',
  '排队中': 'Queued',
  '控制台': 'Console',
  '提示': 'Tip',
  '提示词': 'Prompt',
  '搜官方模型库': 'Search the official library',
  '搜索': 'Search',
  '操作太频繁了，等几秒再试': 'Too many requests — wait a few seconds',
  '改一下上面的数字就能看到': 'Change the numbers above to see this',
  '日志位置：%TEMP%\\localai-console.log': 'Log file: %TEMP%\\localai-console.log',
  '日志内容（最后 200 行）': 'Log content (last 200 lines)',
  '显卡、内存、磁盘现在什么情况。准备打游戏之前看一眼，把显存还回去。':
    'What the GPU, memory and disks look like right now. Check before gaming so VRAM goes back.',
  '显存': 'VRAM',
  '显存余量': 'VRAM headroom',
  '显存占用': 'VRAM usage',
  '显存已用': 'VRAM used',
  '显示快捷键说明': 'Show the shortcut list',
  '普通用户': 'Regular user',
  '暂无数据': 'No data yet',
  '有必须先解决的问题，请看上面的红框': 'There are problems that must be fixed first — see the red boxes above',
  '未使用': 'Unused',
  '未安装': 'Not installed',
  '未检测到独显': 'No discrete GPU detected',
  '未检测到独立显卡': 'No discrete GPU detected',
  '未知': 'Unknown',
  '未知原因': 'unknown reason',
  '未能获得管理员权限': 'Could not obtain administrator rights',
  '未运行': 'Not running',
  '未选择': 'Not selected',
  '本地 AI': 'Local AI',
  '本地 AI · Strata 控制台': 'Local AI · Strata console',
  '本地模型': 'Local model',
  '机器状态': 'Machine status',


  // ---- 第三批 ----

  '会放到 %TEMP%\\local-ai-offline 目录。': 'It will be placed in %TEMP%\\local-ai-offline.',
  '日志位置：%TEMP%\\localai-console.log': 'Log file: %TEMP%\\localai-console.log',
  '界面语言': 'Language',
  'GB 闲置': 'GB idle',
  // ---- 运行时拼出来的文案：按片段翻译 ----
  'Ollama 运行中': 'Ollama running',
  '个模型': ' models',
  '显卡、内存、磁盘现在什么状态，': 'What the GPU, memory and disks look like right now,',
  '。停服务前先来这里看一眼，能把显存还回去。': '. Check here before stopping so VRAM goes back.',
  '更新于': 'Updated at',
  '核': ' cores',
  '剩余': 'remaining',
  '上下文': 'context',
  '显存': 'VRAM',
  '显存合计': 'VRAM total',
  '机械硬盘': 'Spinning disk',
  'NVMe 固态': 'NVMe SSD',
  'USB 外接': 'USB drive',
  '固态硬盘': 'SSD',
  '系统没有提供寿命数据': 'The system does not report lifespan data',
  '通电': 'Powered for',
  '小时': ' hours',
  '所有磁盘状态正常。': 'All disks are healthy.',
  '固态盘有': 'Solid-state drives:',
  '—— 模型放固态上加载快得多。': '— models load much faster from an SSD.',
  '模型所在盘': 'Disk holding the models',
  '运行中（': 'Running (',
  '实际占用（去重后）': 'Actual usage (deduplicated)',
  '模型数量': 'Number of models',
  '分片文件数': 'Shard files',
  '输出上限 maxTokens': 'Output limit maxTokens',
  '压缩余量 headroomTokens': 'Compaction headroom headroomTokens',
  '压缩阈值 thresholdRatio': 'Compaction threshold thresholdRatio',
  '当前模型': 'Current model',
  '安装目录': 'Install folder',
  'Ollama 服务': 'Ollama service',
  '模型目录': 'Model folder',
  '可用。会话涨到约': 'Usable. Compaction triggers around',
  '窗口': 'Window',
  '输出': 'Output',
  '余量': 'Headroom',
  '保留比例': 'Retain ratio',
  '实际生效': 'In effect',
  '通过': 'Passed',
  '采样一致': 'sampling agreement',
  '提醒': 'Heads-up',
  '还是': 'or',
  '在': 'in',
  '这里': 'here',
  '或': 'or',
  '计算中…': 'Calculating…',
  '说': 'say',
  '下一': 'next',
  '不够': 'Not enough',
  // ---- 剩下的运行时片段 ----
  '当前上下文 ': 'Current context ',
  '时触发压缩，压到 ': ' tokens, then compressed to ',
  'GB 总 / ': ' GB total / ',
  '可清掉': ' can be cleared',
  '装完没用过': 'never used',
  '勾选这些模型': 'Select these models',
  '这里': 'here',
  '模型。删除会立刻释放磁盘空间，不影响其它模型。':
    'model. Deleting frees disk space immediately and does not affect other models.',
  '留空 = 按窗口自动推导。压缩余量太小会让压缩过于频繁，太大会让压力预算变成负数——那样压缩会被静默禁用，':
    'Empty = derived from the window. Too small a headroom compacts too often; too large makes the pressure budget negative — compaction is then silently disabled,',
  '表现就是「聊久了回答越来越短」。下面的实时检查会替你算。':
    'which shows up as "answers get shorter as the chat goes on". The live check below does the maths for you.',
  '用得最多的是': ', most used:',
  '这里只统计「试用」页的对话，工作台里的用量统计不到（那是另一套 API）。':
    '. Only chats from the "Try it" page are counted — the workbench uses a different API.',
  '没有检测到独立显卡 —— 模型会跑在 CPU 上，速度会很慢。':
    'No discrete GPU detected — models will run on the CPU and be slow.',
  '次对话，': ' chats,',
  'GB 可用': ' GB usable',
  'GB 总': ' GB total',
  '· 总 ': '· total ',
  '的 100%': ' of the total',
  '左右': ' or so',
  '说一句你好': 'Say hello',
  '不用切到工作台，直接在这里跟模型说两句话 ——':
    'No need to switch to the workbench — just say something here —',
  '（5 个，共': '(5 models, ',
  '偏紧': 'Tight',
  '够用': 'Fits',
  '上手清单': 'Getting started checklist',
  '不含任何密钥': 'contains no keys or secrets',
  '为什么': 'Why',
  '勾选闲置': 'Select the idle ones',
  '在用': 'In use',
  '导出诊断包': 'Export diagnostic bundle',
  '报告 + 脱敏配置 + 日志 + 系统信息，打成一个 zip':
    'Report + redacted configuration + logs + system info, zipped into one file',
  '没用过': 'never used',
  '测一次速度': 'Run a benchmark',
  '用量数据还没加载好，稍等一下': 'The usage data is not ready yet — one moment',
  '装一个模型': 'Install a model',
  '设好开机自启': 'Set up boot autostart',
  '诊断包': 'Diagnostic bundle',
  '诊断包已导出': 'Diagnostic bundle exported',
  '跟模型聊两句': 'Chat with the model',
  '闲置': 'Idle',
  '界面语言。切换后立刻生效，下次打开还是这个。': 'The interface language. It applies immediately and is remembered next time.',
  '语言：简体中文': 'Language: Simplified Chinese',
  '这些开关都是': 'These switches are',
  '的，改完不用重启电脑。': ', and you do not need to restart the computer.',
  '打开这个开关，控制台会每 15 秒检查一次，发现掉了就自动拉起来。':
    'With this on, the console checks every 15 seconds and restarts it if it is gone.',
  '显卡驱动更新、误关托盘程序、休眠没恢复时，':
    'Ollama can exit unexpectedly after a driver update, if the tray app is closed, or after sleep.',
  '会意外退出。': ' can exit unexpectedly.',
  '显卡驱动更新、误关托盘程序、休眠没恢复时，Ollama 会意外退出。':
    'Ollama can exit unexpectedly after a driver update, if the tray app is closed, or after sleep.',
  '你自己的机器上': 'on your own machine',
  '先装一个模型': 'Install a model first',
  '实测中…': 'Measuring…',
  '开始实测排行': 'Start the comparison',
  '异常': 'Critical',
  '模型实测排行': 'Model leaderboard',
  '每个模型都要先加载进显存，5 个模型大概 3~5 分钟。':
    'Each model has to be loaded into VRAM first — five models take about 3–5 minutes.',
  '磁盘健康': 'Disk health',
  '（空）': '(empty)',
  '权限': 'Permissions',
  '查看详细日志': 'View the detailed log',
  '校验模型': 'Verify the model',
  '检查下载残留': 'Check for leftovers',
  '检查中…': 'Checking…',
  '检查失败': 'Check failed',
  '检测中…': 'Detecting…',
  '检测完成 —— 点右下角「继续」': 'Detection done — click "Continue" at the bottom right',
  '模型占了多少显存': 'How much VRAM the models take',
  '模型名': 'Model name',
  '模型库': 'Model library',
  '模型推理服务。首次加载需要等待，就绪后即可开始对话。':
    'The inference service. The first load takes a while; once ready you can start chatting.',
  '正在下载并安装 Ollama…': 'Downloading and installing Ollama…',
  '正在依次跑…': 'Running one by one…',
  '正在取消': 'Cancelling',
  '正在启动服务': 'Starting the service',
  '正在处理': 'Working',
  '正在处理…': 'Working…',
  '正在处理，请稍候…': 'Working, please wait…',
  '正在安装依赖（约 1–3 分钟）': 'Installing dependencies (about 1–3 minutes)',
  '正在打包，请稍候（文件多的时候要十几秒）…': 'Packaging — this can take a while with many files…',
  '正在把模型加载进显存（首次约 1 分钟）': 'Loading the model into VRAM (about a minute the first time)',
  '正在测速…': 'Benchmarking…',
  '正在申请管理员权限…（请在 Windows 弹窗里点「是」）':
    'Requesting administrator rights… (click "Yes" in the Windows prompt)',
  '正在连接模型仓库，获取模型信息…': 'Connecting to the model registry to fetch model details…',
  '正在重新检测…': 'Re-detecting…',
  '正在重试安装…': 'Retrying the installation…',
  '没有可以重试的问题': 'Nothing to retry',
  '流式对话、文件夹上传和提示词润色。需要引擎先运行。':
    'Streaming chat, folder upload and prompt polishing. The engine must be running first.',
  '测生成速度': 'Measuring generation speed',
  '测读长提示词的速度': 'Measuring long-prompt speed',
  '测速中…': 'Benchmarking…',
  '测速历史已清空': 'Benchmark history cleared',
  '清掉已完成的': 'Clear finished',
  '温度': 'Temperature',
  '点下面的「重试安装」再试一次': 'Click "Retry installation" below to try again',
  '版本未知': 'Version unknown',
  '状态读取失败': 'Could not read the status',
  '生成': 'Generated',
  '生成慢': 'Slow generation',
  '用不上的时候': 'When it does not work',
  '留空 = 按窗口自动推导。压缩余量太小会让压缩过于频繁，太大会让压力预算变成负数——那样压缩会被静默禁用， 表现就是「聊久了回答越来越短」。下面的实时检查会替你算。':
    'Empty = derived from the window. Too small a headroom compacts too often; too large makes the pressure budget negative — compaction is then silently disabled, which shows up as "answers get shorter as the chat goes on". The live check below does the maths for you.',
  '看一眼': 'Take a look',
  '看看它有多快': 'See how fast it is',
  '看看硬盘到底被什么占了 —— 删掉不用的模型，空间会立刻回来。':
    'See what is filling the disk — delete models you do not use and the space comes straight back.',
  '确定要停止全部服务吗？ （引擎、WebUI、工作台都会关掉，显存会释放）':
    'Stop all services? (the engine, WebUI and workbench all shut down and VRAM is freed)',
  '确定要删除这些残留分片吗？ （已装的模型不受影响）':
    'Delete these leftover shards? (installed models are not affected)',
  '磁盘': 'Disk',
  '磁盘占用': 'Disk usage',
  '离线安装包已生成': 'Offline package built',
  '稍后再说': 'Maybe later',
  '空闲盘': 'Free space',
  '空间未知': 'Space unknown',
  '立即刷新': 'Refresh now',
  '等待你完成上一步操作…': 'Waiting for you to finish the previous step…',
  '等待数据': 'Waiting for data',
  '管理员': 'Administrator',
  '系统盘': 'System drive',
  '结束使用后，停止三个服务并释放模型占用的显存。':
    'When you are done, stop the three services to release the VRAM the models were using.',
  '聊天与文件': 'Chat & files',
  '聚焦模型搜索': 'Focus the model search',
  '能做什么': 'What you can do',
  '自动 0.25': 'Auto 0.25',
  '自动 0.6': 'Auto 0.6',
  '自动以管理员身份继续': 'Continue as administrator',
  '自动刷新（2 秒）': 'Auto refresh (every 2s)',
  '自动安装 Ollama': 'Install Ollama automatically',
  '自动提权失败 —— 请到部署包文件夹里右键「① 双击这里开始安装.cmd」，选「以管理员身份运行」':
    'Could not elevate automatically — right-click "① 双击这里开始安装.cmd" in the package folder and choose "Run as administrator"',
  '至少选一个模型': 'Pick at least one model',
  '装到用户目录不需要管理员': 'Installing into the user folder needs no administrator rights',
  '设置失败': 'Could not apply the setting',
  '诊断信息已复制': 'Diagnostics copied',
  '诊断信息已复制到剪贴板，直接粘贴发给别人即可':
    'Diagnostics copied to the clipboard — just paste them to someone',
  '诊断报告已开始下载': 'The diagnostic report is downloading',
  '语音': 'Audio',
  '请选择或输入一个模型': 'Pick or type a model',
  '读上下文慢': 'Slow context reading',
  '读写文件、运行命令、完成多步任务。启动时自动打开登录入口。':
    'Reads and writes files, runs commands and completes multi-step tasks. Opens the sign-in page on start.',
  '读取中…': 'Reading…',
  '读提示词参考': 'Prompt processing reference',
  '调提示词': 'Tune the prompt',
  '质量': 'Quality',
  '超支': 'Over budget',
  '跑一次就能看到对比': 'Run it once to see the comparison',
  '跑一次就能看到每类题的通过情况': 'Run it once to see the pass rate per category',
  '输出上限': 'Output limit',
  '输出预算': 'Output budget',
  '运行环境就绪': 'Runtime is ready',
  '还不行就关掉向导，重新双击「① 双击这里开始安装.cmd」':
    'If that does not work, close the wizard and double-click "① 双击这里开始安装.cmd" again',
  '还没开始。问点什么试试 —— 比如「用一句话解释什么是显存」。':
    'Nothing yet. Ask something — e.g. "explain what VRAM is in one sentence".',
  '还没有历史数据': 'No history yet',
  '还没有对话': 'No conversations yet',
  '还没有测过': 'Not benchmarked yet',
  '还没有跑过': 'Never run yet',
  '还没检查': 'Not checked yet',
  '还没检测完，等一下': 'Detection is not finished yet — one moment',
  '这里能管模型、聊模型、测模型、修问题。花一分钟看完这四点，以后就不用再问了。':
    'It manages models, lets you chat, benchmark and repair. Read these four points and you will not need to come back.',
  '选好模型，点「开始对比」。': 'Pick the models, then click "Start comparison".',
  '速度': 'Speed',
  '部分进程未能停止，请检查是否属于当前部署':
    'Some processes could not be stopped — check whether they belong to this deployment',
  '配置已导入': 'Configuration imported',
  '配置已应用，重启工作台后生效': 'Configuration applied — it takes effect after restarting the workbench',
  '重新检查（修复中心）': 'Re-check (Repair Center)',
  '量一量': 'Measure it',
  '需要 20 以上': 'Version 20 or newer is required',
  '需要你完成一步操作': 'You need to complete one step',
  '需要先装一个组件': 'A component has to be installed first',
  '需要管理员权限': 'Administrator rights are required',
  '页面': 'Page',
  '预热（把模型读进显存）': 'Warming up (loading the model into VRAM)',
  '驱动': 'Driver',
  '（当前）': '(current)',
  '（手动输入的模型不知道体积，先保守取 8K）': '(the size of a manually typed model is unknown, so 8K is assumed)',
  '（日志是空的）': '(the log is empty)',
  '（未设置模型）': '(no model set)',
  '（未设置）': '(not set)',
  '（未配置）': '(not configured)',
  '（模型没有返回内容）': '(the model returned nothing)',
  '（没有返回内容）': '(no content returned)',
  '（空对话）': '(empty conversation)',
  '（请先点一个磁盘，或在上面输入完整路径）': '(pick a disk first, or type a full path above)',

};

const LANGS = [
  { id: 'zh', label: '简体中文' },
  { id: 'en', label: 'English' },
];

const KEY = 'localai-lang';
let lang = 'zh';
const missing = new Set();

/** 取译文；没有对应译文就原样返回（中文） */
function t(text) {
  if (!text) return text;
  if (lang === 'zh') return text;
  const hit = DICT[text];
  if (hit === undefined) { missing.add(text); return text; }
  return hit;
}

/** 字典里的键按长度倒序排好，用来找「最长前缀匹配」 */
let sortedKeys = null;
function keysByLength() {
  if (!sortedKeys) sortedKeys = Object.keys(DICT).sort((a, b) => b.length - a.length);
  return sortedKeys;
}

/**
 * 短语表：含中文、长度 ≥3 的键。
 *
 * 分段翻译只认「以中文开头」的片段，但界面上有些句子是「NVMe 固态 · 1863 GB」
 * 这种以英文开头的 —— 光靠分段匹配不到。所以再走一遍「短语替换」：
 * 把文本里出现的整个短语直接换掉。
 */
let phrases = null;
function phraseList() {
  if (!phrases) {
    phrases = keysByLength().filter((k) => /[一-鿿]/.test(k) && k.length >= 3 && DICT[k]);
  }
  return phrases;
}

function translatePhrases(text) {
  let out = text;
  for (const k of phraseList()) {
    if (out.indexOf(k) < 0) continue;
    out = out.split(k).join(DICT[k]);
  }
  return out;
}

/**
 * 翻译一段可能混着动态内容的文本。
 *
 * 先试整段匹配（静态文案），不行就**按中文片段逐段翻译**（动态文案）。
 * 片段用「最长前缀匹配」来翻 —— 这样「已下载 12 MB」能翻成「Downloaded 12 MB」，
 * 而「显卡驱动更新、……，Ollama 会意外退出。」这种长句也能整段命中。
 */
function translateText(text) {
  if (!text || lang === 'zh') return text;
  if (!/[一-鿿]/.test(text)) return text;
  const trimmed = text.trim();
  // HTML 抽取器会合并换行和缩进；运行时也按相同规则查整句，避免长段落只翻译零散短语。
  const whole = DICT[trimmed] ?? DICT[trimmed.replace(/\s+/g, ' ')];
  if (whole !== undefined) return text.replace(trimmed, whole);
  const segmented = text.replace(/[一-鿿][一-鿿0-9A-Za-z：:，。、（）()「」·%/\-—…\s]{0,80}/g, (seg) => {
    const key = seg.trim();
    if (!key) return seg;
    if (DICT[key] !== undefined) return seg.replace(key, DICT[key]);
    for (const k of keysByLength()) {
      if (k.length < 2 || k.length > key.length) continue;
      if (key.startsWith(k)) return seg.replace(k, DICT[k]);
    }
    return seg;
  });
  // 分段只认「以中文开头」的片段，英文开头的句子靠短语替换兜底
  return translatePhrases(segmented);
}

/**
 * 把页面上的文案换成当前语言。
 *
 * 做法是按「元素自己的文字」去字典里查 —— 叶子元素替换整段，
 * 带子标签的元素逐个文本节点替换。
 */
function applyI18n(root = document) {
  if (lang === 'zh') return 0;
  let count = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  for (const node of nodes) {
    if (!node.parentElement) continue;
    const tag = node.parentElement.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA') continue;
    // 用户内容不翻（聊天记录、日志输出）
    if (node.parentElement.closest('[data-no-i18n]')) continue;
    const raw = node.nodeValue;
    if (!raw || !/[一-鿿]/.test(raw)) continue;
    const next = translateText(raw);
    if (next !== raw) { node.nodeValue = next; count += 1; }
  }
  return count;
}

/**
 * 盯着页面变化，动态生成的文案也翻译。
 *
 * 界面里大量文字是运行时拼出来的（「已下载 12 MB」这种），
 * 逐个调用点去包 t() 太啰嗦又容易漏 —— 用观察器统一处理更稳。
 * [data-no-i18n] 标记的子树不处理（聊天内容、日志）。
 */
let observer = null;
function observeI18n(root = document.body) {
  if (observer || typeof MutationObserver === 'undefined') return;
  observer = new MutationObserver((records) => {
    if (lang === 'zh') return;
    for (const r of records) {
      if (r.type === 'characterData') {
        const node = r.target;
        if (!node.parentElement) continue;
        if (node.parentElement.closest('[data-no-i18n]')) continue;
        const next = translateText(node.nodeValue);
        if (next !== node.nodeValue) node.nodeValue = next;
        continue;
      }
      for (const node of r.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.closest && node.closest('[data-no-i18n]')) continue;
        applyI18n(node);
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true, characterData: true });
}

/** 切换语言并落盘 */
function setLang(id) {
  lang = LANGS.some((l) => l.id === id) ? id : 'zh';
  try { localStorage.setItem(KEY, lang); } catch { /* ignore */ }
  return lang;
}

function getLang() { return lang; }
function currentLang() { return lang; }
function langs() { return LANGS; }

/** 没翻译的条目（设置页里会显示，方便补） */
function missingKeys() { return [...missing]; }

/** 初始化：读出用户上次选的语言 */
function initI18n() {
  let saved = 'zh';
  try { saved = localStorage.getItem(KEY) || 'zh'; } catch { saved = 'zh'; }
  lang = LANGS.some((l) => l.id === saved) ? saved : 'zh';
  if (lang === 'zh') {
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  }
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  return lang;
}

window.I18n = {
  t, translateText, setLang, getLang, currentLang, langs,
  applyI18n, observeI18n, initI18n, missingKeys, DICT,
};
