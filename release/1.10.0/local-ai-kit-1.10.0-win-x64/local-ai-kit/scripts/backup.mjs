/**
 * 配置导出 / 导入。
 *
 * 场景：换电脑、或者想把「我现在这套调好的参数」存一份。
 * 需要带走的东西有三样：
 *   - 配置.json（模型、模型目录、上下文、端口……）
 *   - dsh 的两个 profile 补丁（web / headless）
 *
 * 打包成一个 JSON，用户点一下下载；换台电脑再点导入就能还原。
 *
 * 安全上要注意：导入的东西会写进本地文件，所以：
 *   - 路径类字段必须校验（不能是任意路径）
 *   - profile 文本按大小限制
 *   - 导入前一定先备份
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, saveConfig, sanitizeConfig } from './config.mjs';

export const BUNDLE_VERSION = 1;
const MAX_PROFILE_BYTES = 256 * 1024;

/** 读 dsh 的 profile 补丁（没有就返回空串） */
function readProfile(dir, profile) {
  try {
    const file = path.join(dir, 'profiles', profile, 'cordis.patch.yml');
    if (!fs.existsSync(file)) return '';
    const text = fs.readFileSync(file, 'utf8');
    return text.length > MAX_PROFILE_BYTES ? text.slice(0, MAX_PROFILE_BYTES) : text;
  } catch { return ''; }
}

/** 写 dsh 的 profile 补丁（先备份） */
function writeProfile(dir, profile, text) {
  const target = path.join(dir, 'profiles', profile, 'cordis.patch.yml');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let backup = null;
  try {
    if (fs.existsSync(target)) {
      backup = `${target}.${Date.now()}.bak`;
      fs.copyFileSync(target, backup);
    }
  } catch { /* ignore */ }
  fs.writeFileSync(target, text, 'utf8');
  return { file: target, backup };
}

/**
 * 导出成一个可下载的 JSON 包。
 */
export function exportBundle(root, { dshHome } = {}) {
  const home = dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const config = loadConfig(root) || {};
  return {
    kind: 'local-ai-kit/config-bundle',
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    kitVersion: (() => {
      try {
        const text = fs.readFileSync(path.join(root, 'scripts', 'install.mjs'), 'utf8');
        const m = text.match(/KIT_VERSION\s*=\s*'([^']+)'/);
        return m ? m[1] : null;
      } catch { return null; }
    })(),
    config: sanitizeConfig(config),
    profiles: {
      web: readProfile(home, 'web'),
      headless: readProfile(home, 'headless'),
    },
  };
}

/** 校验导入包；不合格就抛错（错误信息要能直接给用户看） */
export function validateBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') throw new Error('这不是一个有效的配置包');
  if (bundle.kind !== 'local-ai-kit/config-bundle') throw new Error('文件格式不对：这不是本地 AI 的配置包');
  if (Number(bundle.version) > BUNDLE_VERSION) throw new Error('配置包版本太新，请先更新本地 AI');
  if (!bundle.config || typeof bundle.config !== 'object') throw new Error('配置包里没有配置内容');
  if (bundle.profiles && typeof bundle.profiles !== 'object') {
    for (const [k, v] of Object.entries(bundle.profiles)) {
      if (typeof v !== 'string') throw new Error(`profile「${k}」的内容不是文本`);
      if (v.length > MAX_PROFILE_BYTES) throw new Error(`profile「${k}」太大了`);
    }
  }
  return true;
}

/**
 * 导入配置包。
 *
 * @param {string} root 安装目录
 * @param {object} bundle 配置包
 * @param {object} opts { dshHome, dryRun }
 */
export function importBundle(root, bundle, { dshHome, dryRun = false } = {}) {
  validateBundle(bundle);
  const home = dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const next = sanitizeConfig(bundle.config);

  // 路径类字段做个基本体检：要是用户换机器后路径变了，导入进去也用不了
  const warnings = [];
  if (next.modelDir && !path.isAbsolute(next.modelDir)) {
    warnings.push(`模型目录「${next.modelDir}」不是绝对路径，导入后可能需要改`);
  }
  if (next.modelDir && !fs.existsSync(path.parse(next.modelDir).root)) {
    warnings.push(`模型目录所在的盘「${path.parse(next.modelDir).root}」在这台机器上不存在`);
  }

  if (dryRun) return { config: next, warnings, applied: false };

  saveConfig(root, next);
  const written = [];
  for (const profile of ['web', 'headless']) {
    const text = bundle.profiles && bundle.profiles[profile];
    if (typeof text !== 'string' || !text.trim()) continue;
    const out = writeProfile(home, profile, text);
    written.push({ profile, file: out.file, backup: out.backup });
  }
  return { config: next, warnings, applied: true, profiles: written };
}
