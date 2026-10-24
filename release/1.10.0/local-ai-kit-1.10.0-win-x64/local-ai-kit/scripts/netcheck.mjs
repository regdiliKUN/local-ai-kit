/**
 * 网络连通性诊断。
 *
 * 「模型下不下来」「更新查不到」这类问题，八成是网络的事：
 *   - 机器上根本没配代理，但平时上网必须走代理
 *   - 配了代理，但 Node 默认不认系统代理（Ollama 认，Node 的 fetch 不认）
 *   - DNS 不通 / 防火墙拦了 443
 *
 * 这里挨个探一遍，给出「哪里不通、可能怎么修」。
 */

const TARGETS = [
  { host: 'ollama.com', label: '模型官网', url: 'https://ollama.com/library' },
  // 仓库根路径：返回 200 表示网络通（具体模型路径可能 401/404，不影响连通性判断）
  { host: 'registry.ollama.ai', label: '模型仓库（下载模型用）', url: 'https://registry.ollama.ai/v2/' },
  { host: 'github.com', label: 'GitHub（检查更新用）', url: 'https://api.github.com/repos/regdiliKUN/local-ai-kit/releases/latest' },
];

/** 环境变量里的代理设置 */
export function proxySettings(env = process.env) {
  const out = [];
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    const value = env[key];
    if (value) out.push({ key, value: String(value).replace(/:\/\/[^@]*@/, '://***@') });
  }
  return out;
}

/** 探一个地址，返回可达性与耗时 */
async function probe(target, timeoutMs) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(target.url, {
      method: 'GET',
      headers: { 'User-Agent': 'local-ai-kit' },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);
    // 拿到任何 HTTP 响应都说明网络是通的（401/404 也是「服务器应答了」）
    return {
      ok: true,
      status: r.status,
      ms: Date.now() - started,
      error: r.ok ? null : `HTTP ${r.status}（服务器有应答，只是这个地址没有内容）`,
      warn: r.ok ? null : `HTTP ${r.status}`,
    };
  } catch (e) {
    clearTimeout(timer);
    const msg = e.name === 'AbortError' ? '超时' : String(e.message || e);
    return { ok: false, status: null, ms: Date.now() - started, error: msg, warn: null };
  }
}

/**
 * 跑一遍连通性检查。
 *
 * @param {object} opts { timeoutMs }
 */
export async function checkNetwork({ timeoutMs = 5000 } = {}) {
  const results = [];
  for (const target of TARGETS) {
    const r = await probe(target, timeoutMs);
    results.push({ ...target, ...r });
  }
  const proxies = proxySettings();
  const failed = results.filter((r) => !r.ok);

  let advice = [];
  if (failed.length === 0) {
    advice.push('网络都通，模型应该能正常下载。');
  } else {
    if (proxies.length) {
      advice.push(`检测到代理设置（${proxies.map((p) => p.key).join('、')}）。`
        + '注意：Node 自带的 fetch 不认这些环境变量，Ollama 认 —— '
        + '所以「控制台能查更新但模型下不下来」是正常现象。');
      advice.push('下载模型建议走 Ollama 自己的代理设置（安装向导里有「设置网络代理」）。');
    } else {
      advice.push('没有检测到代理设置。如果你平时上网必须走代理，'
        + '请在安装向导的「存放位置 → 设置网络代理」里填上代理地址。');
    }
    advice.push('也可以检查一下防火墙 / 杀毒软件是否拦了 443 端口。');
  }
  if (results.some((r) => r.ok && r.ms > 3000)) {
    advice.push('有些地址响应很慢（超过 3 秒），下载大模型会非常慢 —— 建议走代理或换个网络。');
  }

  return {
    results,
    proxies,
    advice,
    allOk: failed.length === 0,
    at: Date.now(),
  };
}
