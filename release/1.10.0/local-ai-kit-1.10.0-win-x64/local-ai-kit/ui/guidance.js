/*
 * 引导与解释。
 *
 * 这个项目的用户是「不想跟命令行较劲」的人，所以界面上的每一句
 * 「暂无数据」都应该变成「现在该做什么」。
 *
 * 这里集中放三样东西：
 *   1. EMPTY  —— 各种空状态该显示什么、下一步做什么
 *   2. ERRORS —— 常见报错翻译成人话 + 对应动作
 *   3. TOURS  —— 分场景的引导（刚装完 / 出问题 / 想换模型）
 */

const Guidance = (() => {
  /** 空状态：每种场景给一句「下一步做什么」 */
  const EMPTY = {
    models: {
      title: '还没有装任何模型',
      hint: '模型是本地 AI 的「大脑」，至少要有一个才能开始用。',
      action: '去装一个',
      where: 'models',
    },
    modelsNoneRunning: {
      title: '现在没有模型驻留显存',
      hint: '这说明显存已经全部还给游戏 / 渲染软件了 —— 状态正常。',
      action: null,
    },
    space: {
      title: '模型目录还是空的',
      hint: '装好第一个模型后，这里会显示每个模型各占多少空间。',
      action: '去装一个',
      where: 'models',
    },
    trend: {
      title: '还没有历史记录',
      hint: '每跑一次体检 / 测速就会留下一条记录，跑两次就能看出变化趋势。',
      action: '跑一次体检',
      where: 'health',
    },
    compare: {
      title: '选好模型，点「开始对比」',
      hint: '同一个问题同时问几个模型，并排看答案与速度，差别一眼就清楚。',
      action: null,
    },
    health: {
      title: '还没有跑过体检',
      hint: '觉得「模型变笨了」的时候跑一次 —— 40 秒，能分清是能力问题还是配置问题。',
      action: '开始体检',
      where: 'health',
    },
    bench: {
      title: '还没有测过速',
      hint: '测一次就知道「慢」是生成慢还是读上下文慢 —— 这两种解法完全不同。',
      action: '开始测速',
      where: 'bench',
    },
    library: {
      title: '搜一下官方模型库',
      hint: '几百个模型里挑一个合适的：带能力标签、尺寸和下载量。',
      action: null,
    },
    services: {
      title: '没有检测到在跑的服务',
      hint: '点下面的按钮启动；工作台需要引擎先就绪。',
      action: null,
    },
    caps: {
      title: '没有已安装的模型',
      hint: '先去「模型管理」装一个，装完这里就能看到每个模型的能力了。',
      action: '去装一个',
      where: 'models',
    },
  };

  /**
   * 常见报错 → 人话 + 该做什么。
   * 键是报错里出现的关键词（小写匹配）。
   */
  const ERRORS = [
    {
      match: ['out of memory', 'oom', 'cuda out of memory'],
      title: '显存不够',
      why: '模型 + 上下文超过了显卡能装的量。',
      fix: '把上下文调小一档，或者换一个更小的模型。',
      where: 'context',
    },
    {
      match: ['model not found', '404', 'not found'],
      title: '模型不在 Ollama 里',
      why: '配置里写的模型名，和 Ollama 里实际装的不是同一个。',
      fix: '去「模型管理」看看装了什么，然后把配置改成正确的名字。',
      where: 'models',
    },
    {
      match: ['connection refused', 'econnrefused', 'fetch failed'],
      title: '连不上 Ollama',
      why: 'Ollama 服务没在运行，或者被防火墙拦了。',
      fix: '去「服务」页把 Ollama 启起来。',
      where: 'services',
    },
    {
      match: ['timeout', 'timed out', 'etimedout'],
      title: '等太久了',
      why: '模型第一次加载要读硬盘，几 GB 的模型可能要十几秒；网络请求超时多半是网速慢。',
      fix: '先等一等再试；如果总超时，去「诊断与维护」检查网络。',
      where: 'tools',
    },
    {
      match: ['no space', 'enospc', '磁盘空间'],
      title: '磁盘空间不够',
      why: '模型还没下完，或者残留文件太多。',
      fix: '换个盘，或者去「诊断与维护」清理下载残留。',
      where: 'tools',
    },
    {
      match: ['permission', 'eacces', 'access is denied', '拒绝访问'],
      title: '没有权限',
      why: '文件被别的程序占着，或者需要管理员权限。',
      fix: '关掉正在用这个文件的程序，或以管理员身份运行一次。',
      where: 'fix',
    },
    {
      match: ['eaddrinuse', 'address already in use', '端口'],
      title: '端口被占用了',
      why: '另一个程序用了同一个端口。',
      fix: '关掉那个程序，或改用别的端口。',
      where: 'services',
    },
    {
      match: ['signature', '签名', 'checksum', 'sha256'],
      title: '安装包校验没通过',
      why: '下载的文件不完整或被改过 —— 出于安全考虑不会安装。',
      fix: '重新下载一遍（换个网络可能更稳）。',
      where: null,
    },
    {
      match: ['proxy', '代理'],
      title: '代理没生效',
      why: 'Node 自带的 fetch 不认系统代理设置，Ollama 才认。',
      fix: '在安装向导的「存放位置 → 设置网络代理」里填代理地址。',
      where: 'tools',
    },
  ];

  /** 把一段报错翻译成 { title, why, fix, where }；认不出来就返回 null */
  function explain(text) {
    const s = String(text || '').toLowerCase();
    if (!s) return null;
    for (const e of ERRORS) {
      if (e.match.some((k) => s.includes(String(k).toLowerCase()))) return e;
    }
    return null;
  }

  /** 引导：按场景给不同的内容 */
  const TOURS = {
    first: [
      { title: '欢迎来到本地 AI 控制台', text: '这里能管模型、聊模型、测模型、修问题。花一分钟看完这几步，以后就不用再问了。' },
      { title: '「系统概览」先看一眼', text: '显存被模型占了多少、还剩多少，准备打游戏之前来这里确认一下就知道。' },
      { title: 'Ctrl+K 打开命令面板', text: '所有页面和动作都在里面，输入关键字直接跳过去。' },
      { title: '出问题先别重装', text: '「诊断与维护」查网络、清残留、导出报告；「修复中心」能一键修好常见问题。' },
    ],
    broken: [
      { title: '用不上的时候按这个顺序查', text: '先点「修复中心 → 重新检查」，它会告诉你哪一环断了。' },
      { title: '模型下不下来？', text: '去「诊断与维护 → 检查网络」，看是仓库不通还是代理没生效。' },
      { title: '硬盘越来越满？', text: '「模型管理 → 空间分析」能看出空间都去哪了；「清理下载残留」能回收下了一半的分片。' },
      { title: '还是不行就导出报告', text: '「诊断与维护 → 下载诊断报告」，把那个文件发给别人就行。' },
    ],
    swap: [
      { title: '想换个模型？', text: '「模型管理」里可以搜索官方模型库，点一下就进下载队列。' },
      { title: '不确定该选哪个？', text: '「模型对比」把同一个问题问几个模型，并排一看就清楚。' },
      { title: '换完记得重启', text: '模型装好后要重启工作台才会用上；「服务」页可以一键启停。' },
      { title: '怕换错？', text: '「上下文与模型」里改配置会先自动备份，改坏了能一键回滚。' },
    ],
  };

  return { EMPTY, ERRORS, TOURS, explain };
})();

window.Guidance = Guidance;
