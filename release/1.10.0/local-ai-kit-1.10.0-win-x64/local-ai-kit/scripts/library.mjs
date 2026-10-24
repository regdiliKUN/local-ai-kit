/**
 * Ollama 官方模型库搜索。
 *
 * 装模型最麻烦的一步是「该装哪个」。模型库有几百个模型，官网的搜索很好用，
 * 但它是个网页 —— 这里把它的结果解析出来，直接在控制台里搜、点一下就加入下载队列。
 *
 * 解析逻辑写成纯函数（parseLibrary），方便写单元测试。
 */

const LIBRARY_URL = 'https://ollama.com/library';
const CACHE_TTL = 10 * 60 * 1000;

/** 缓存：同一个关键字 10 分钟内不重复请求官网 */
const cache = new Map();

/** 解码 HTML 实体（官网的描述里有 &#39; 这种） */
export function decodeEntities(text) {
  return String(text || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 解析模型库页面。
 *
 * 页面结构（简化后）：
 *   <li ...>
 *     <a href="/library/qwen3">
 *       <h2 ...><span>qwen3</span></h2>
 *       <p class="max-w-lg ...">Qwen3 is the latest ...</p>
 *       <span class="... bg-indigo-50 ...">tools</span>   ← 能力
 *       <span class="... bg-[#ddf4ff] ...">8b</span>       ← 尺寸
 *       <span>40.7M</span> Pulls
 *     </a>
 *   </li>
 */
export function parseLibrary(html) {
  const out = [];
  const text = String(html || '');
  // 按模型条目切分：每条都从 <a href="/library/ 开始
  const parts = text.split(/<a\s+href="\/library\//i).slice(1);
  for (const part of parts) {
    const nameMatch = /^([^"]+)"/i.exec(part);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();
    if (!name || !/^[a-z0-9][a-z0-9._\-/]*$/i.test(name)) continue;

    // 描述：class 里带 max-w-lg 的那个 <p>
    const descMatch = /<p[^>]*max-w-lg[^>]*>([\s\S]*?)<\/p>/i.exec(part);
    const description = descMatch ? decodeEntities(descMatch[1]) : '';

    // 能力标签：bg-indigo-50 那一组（tools / vision / thinking / embedding / audio）
    const capabilities = [];
    const capRe = /<span[^>]*bg-indigo-50[^>]*>([\s\S]*?)<\/span>/gi;
    let m;
    while ((m = capRe.exec(part)) !== null) {
      const label = decodeEntities(m[1]).toLowerCase();
      if (label && !capabilities.includes(label)) capabilities.push(label);
    }

    // 尺寸标签：bg-[#ddf4ff] 那一组（0.5b / 8b / 70b …）
    const sizes = [];
    const sizeRe = /<span[^>]*ddf4ff[^>]*>([\s\S]*?)<\/span>/gi;
    while ((m = sizeRe.exec(part)) !== null) {
      const label = decodeEntities(m[1]).toLowerCase();
      if (label && !sizes.includes(label)) sizes.push(label);
    }

    // 下载量：数字 + "Pulls"
    // 注意大小写敏感：官网页面里尺寸标签是 "32b"（小写 b），下载量是 "40.7M"（大写 M）。
    // 如果这里开了忽略大小写，"32b" 会被当成 32B 的下载量。
    const pullsMatch = /<span[^>]*>([\d.]+[KMB]?)<\/span>[\s\S]{0,240}?Pulls/.exec(part);
    const pulls = pullsMatch ? pullsMatch[1] : '';

    out.push({ name, description, capabilities, sizes, pulls });
  }
  return out;
}

/** 把下载量文本变成可比较的数字（120.4M → 120400000） */
export function parsePulls(text) {
  const m = /^([\d.]+)\s*([KMB])?$/i.exec(String(text || '').trim());
  if (!m) return 0;
  const n = Number(m[1]) || 0;
  const unit = (m[2] || '').toUpperCase();
  if (unit === 'K') return n * 1e3;
  if (unit === 'M') return n * 1e6;
  if (unit === 'B') return n * 1e9;
  return n;
}

/**
 * 搜模型库。
 *
 * 离线或网络不通时返回空数组 + 原因，不要抛异常把界面搞崩。
 */
export async function searchLibrary(query = '', { timeoutMs = 6000 } = {}) {
  const q = String(query || '').trim();
  const key = q.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return { ...hit.value, cached: true };

  const url = q ? `${LIBRARY_URL}?q=${encodeURIComponent(q)}` : LIBRARY_URL;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const r = await fetch(url, {
      headers: { 'User-Agent': 'local-ai-kit', Accept: 'text/html' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return { items: [], error: `官网返回 ${r.status}`, offline: false };
    const items = parseLibrary(await r.text());
    const value = { items, error: null, offline: false };
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (e) {
    return { items: [], error: '连不上 ollama.com（离线？）', offline: true };
  }
}

/** 把模型库里的能力标签翻译成中文，界面上更好懂 */
export const CAPABILITY_TEXT = {
  tools: '工具调用',
  vision: '看图',
  thinking: '深度思考',
  embedding: '向量化',
  audio: '语音',
  cloud: '云端',
};
