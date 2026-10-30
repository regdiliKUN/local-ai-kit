/**
 * 体检 + 修复。
 *
 * 「装完之后用不了」的原因其实就那么几种，而且都是能查出来、能修的：
 *   - Ollama 没装 / 没跑起来
 *   - 模型目录不存在或者不能写
 *   - 配置里写的模型和 Ollama 里实际有的对不上
 *   - dsh 的 profile 补丁没打上（于是工作台连不上本地模型）
 *   - 端口被别的东西占着
 *   - 磁盘空间不够
 *
 * 这里把「查」和「修」放在一起：先列出问题，再给一键修复。
 * 修复动作一律保守 —— 能只读就不写，能备份就备份。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

import { OLLAMA_BASE, findOllama, isUp, listServed, killOllama, spawnServe, waitUp } from './ollama.mjs';
import { loadConfig, saveConfig } from './config.mjs';
import { readPresetStandard, patchProfileText, resolveBudgets } from './install.mjs';
// 端口 → 进程号只有一份实现（detect.mjs）。以前 repair / strata / uninstall 各抄了一份，
// 三份正则还不一样：repair 认 0.0.0.0 和 [::]，uninstall 只认 127.0.0.1，
// 于是「开了局域网共享」或「dsh 走 IPv6」时，卸载会漏掉还在跑的进程。
import { pidOnPort, readNetstat } from './detect.mjs';

/* --------------------------------------------------------------- 检查项 */

/**
 * 跑一遍所有检查。
 *
 * @param {object} ctx { root, cfg, kitDir }
 */
export async function diagnose(ctx) {
  const { root, cfg } = ctx;
  const checks = [];
  const add = (id, label, level, detail, fixable) =>
    checks.push({ id, label, level, detail, fixable: !!fixable });

  /* ---- Node ---- */
  const major = Number(process.versions.node.split('.')[0]);
  add('node', 'Node.js 运行时',
    major >= 20 ? 'ok' : 'error',
    `v${process.versions.node}${major >= 20 ? '' : '（需要 20 以上）'}`,
    false);

  /* ---- Ollama ---- */
  const exe = findOllama();
  const up = await isUp(`${OLLAMA_BASE}/api/version`, 2000);
  if (!exe) add('ollama-install', 'Ollama 是否安装', 'error', '没找到 Ollama，请重新运行安装向导', 'ollama-install');
  else add('ollama-install', 'Ollama 是否安装', 'ok', exe, false);

  add('ollama-run', 'Ollama 是否在运行', up ? 'ok' : 'warn',
    up ? '运行中' : '没运行（管理模型时会自动启动）', 'ollama-start');

  /* ---- 模型目录 ---- */
  const dir = cfg.modelDir || '';
  if (!dir) {
    add('model-dir', '模型目录', 'warn', '还没配置模型目录', false);
  } else if (!fs.existsSync(dir)) {
    add('model-dir', '模型目录', 'error', `目录不存在：${dir}`, 'create-dir');
  } else {
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      add('model-dir', '模型目录', 'ok', dir, false);
    } catch {
      add('model-dir', '模型目录', 'error', `目录不可写：${dir}（换个盘，或以管理员身份运行一次）`, false);
    }
  }

  /* ---- 配置里的模型 ---- */
  const served = up ? await listServed() : null;
  if (cfg.model) {
    if (served === null) {
      add('model-exists', '配置里的模型', 'warn', `${cfg.model}（Ollama 没运行，暂时查不到）`, false);
    } else if (served.includes(cfg.model)) {
      add('model-exists', '配置里的模型', 'ok', `${cfg.model} 已安装`, false);
    } else {
      add('model-exists', '配置里的模型', 'error',
        `${cfg.model} 不在 Ollama 里（已装：${served.join('、') || '一个都没有'}）`, 'pick-model');
    }
  } else {
    add('model-exists', '配置里的模型', 'warn', '还没设置模型', false);
  }

  /* ---- dsh profile 补丁 ---- */
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const budgets = resolveBudgets(cfg);
  const presetText = readPresetStandard(ctx.kitDir || root);
  const missing = [];
  for (const profile of ['web', 'headless']) {
    const file = path.join(home, 'profiles', profile, 'cordis.patch.yml');
    let text = '';
    try { text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; } catch { /* ignore */ }
    if (!cfg.model || !text.includes(cfg.model)) missing.push(profile);
  }
  add('profiles', '工作台配置（dsh profile）',
    missing.length ? 'warn' : 'ok',
    missing.length ? `缺少 ${missing.join('、')} 的补丁（工作台可能连不上本地模型）` : '补丁已就位',
    missing.length ? 'patch-profiles' : false);

  /* ---- 开机自启项还在不在 ---- */
  const startupDir = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
    : '';
  if (startupDir) {
    const lnk = path.join(startupDir, '启动本地AI.lnk');
    const target = path.join(ctx.root || '', 'start-ai.cmd');
    if (fs.existsSync(lnk)) {
      if (fs.existsSync(target)) {
        add('autostart', '开机自启项', 'ok', `已开启，指向 ${target}`, false);
      } else {
        add('autostart', '开机自启项', 'warn',
          `自启项还在，但它指向的 ${target} 已经不存在了 —— 开机时会报错`, 'autostart-off');
      }
    } else {
      add('autostart', '开机自启项', 'ok', '没开启（正常）', false);
    }
  }

  /* ---- 端口 ---- */
  const ports = [
    { port: 11434, name: 'Ollama' },
    { port: 3080, name: '工作台 (dsh)' },
  ];
  // 一次 netstat 全表查完所有端口：以前每个端口跑一次，两个端口就是两次全表扫描
  const netstat = readNetstat();
  for (const p of ports) {
    const holder = pidOnPort(p.port, netstat);
    if (holder) add(`port-${p.port}`, `${p.name} 端口 ${p.port}`, 'ok', `被进程 ${holder} 占用（正常）`, false);
    else add(`port-${p.port}`, `${p.name} 端口 ${p.port}`, 'ok', '空闲', false);
  }

  /* ---- 磁盘 ---- */
  if (dir) {
    const free = freeGB(dir);
    if (free != null && free < 5) {
      add('disk', '模型盘剩余空间', 'error', `只剩 ${free} GB，模型可能下载不下来`, false);
    } else if (free != null) {
      add('disk', '模型盘剩余空间', 'ok', `${free} GB`, false);
    }
  }

  const level = checks.some((c) => c.level === 'error') ? 'error'
    : checks.some((c) => c.level === 'warn') ? 'warn' : 'ok';
  return { level, checks, at: Date.now() };
}

/* --------------------------------------------------------------- 修复项 */

function freeGB(p) {
  try {
    const st = fs.statfsSync(path.parse(path.resolve(p)).root);
    return Math.round((st.bsize * st.bavail) / 1e9);
  } catch { return null; }
}

/**
 * 执行一个修复动作。
 *
 * @param {string} action 动作名
 * @param {object} ctx { root, cfg, kitDir }
 */
export async function repair(action, ctx) {
  const { root, cfg } = ctx;
  switch (action) {
    case 'create-dir': {
      if (!cfg.modelDir) throw new Error('还没配置模型目录');
      fs.mkdirSync(cfg.modelDir, { recursive: true });
      return { ok: true, message: `已创建 ${cfg.modelDir}` };
    }

    case 'ollama-start': {
      const exe = findOllama();
      if (!exe) throw new Error('找不到 Ollama，请重新运行安装向导');
      killOllama();
      spawnServe(exe, cfg, { detached: true });
      const ready = await waitUp(30);
      if (!ready) throw new Error('Ollama 没能启动，请看日志');
      return { ok: true, message: 'Ollama 已启动' };
    }

    case 'ollama-install': {
      throw new Error('请重新双击「① 双击这里开始安装.cmd」，向导会自动下载并安装 Ollama');
    }

    case 'patch-profiles': {
      const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
      const budgets = resolveBudgets(cfg);
      const presetText = readPresetStandard(ctx.kitDir || root);
      const notes = [];
      for (const profile of ['web', 'headless']) {
        const file = path.join(home, 'profiles', profile, 'cordis.patch.yml');
        const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        const { text, notes: n } = patchProfileText(prev, {
          profile, model: cfg.model, contextWindow: budgets.contextWindow,
          input: '[text, image]', presetText, budgets,
        });
        if (prev !== text) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.${Date.now()}.bak`);
          fs.writeFileSync(file, text, 'utf8');
          notes.push(`${profile} 档：${n.join('、')}`);
        } else notes.push(`${profile} 档：已是最新`);
      }
      return { ok: true, message: notes.join('；') };
    }

    case 'autostart-off': {
      // 把坏掉的自启项删掉：它指向的程序没了，留着只会开机报错
      const dir = process.env.APPDATA
        ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
        : '';
      const lnk = path.join(dir, '启动本地AI.lnk');
      try {
        fs.rmSync(lnk, { force: true });
        return { ok: true, message: '已移除失效的开机自启项' };
      } catch (e) {
        throw new Error(`移除失败：${e.message}`);
      }
    }

    case 'pick-model': {
      const served = await listServed();
      if (!served || !served.length) throw new Error('Ollama 里一个模型都没有，先去「模型管理」装一个');
      const next = served[0];
      const updated = { ...cfg, model: next };
      saveConfig(root, updated);
      for (const key of Object.keys(cfg)) delete cfg[key];
      Object.assign(cfg, updated);
      return { ok: true, message: `已把当前模型改成 ${next}` };
    }

    default:
      throw new Error(`未知的修复动作：${action}`);
  }
}
