/**
 * 发布快照：把「拷到别的机器上就能直接跑」的一整套东西固化进 release/，
 * 同时生成一份能真正校验的 SHA256 清单。
 *
 * 为什么要脚本：这套东西以前是手工拷的，结果清单和文件对不上 ——
 * 删掉的文件还留在清单里、改过的文件哈希没更新，谁也没法用它验证包有没有坏。
 *
 * 用法：
 *   node scripts/build-release.mjs --version 1.11.0
 *   node scripts/build-release.mjs --version 1.11.0 --from "F:\本地AI" --prune
 *   node scripts/build-release.mjs --verify          # 只校验现有清单
 *
 * 产出：
 *   release/<版本>/local-ai-kit-<版本>-win-x64/   部署目录的完整快照
 *   release/SHA256SUMS.txt                        每个文件的 SHA256（LF 换行）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.dirname(HERE);

/** 部署目录里除项目本体之外的东西（跟源码一起构成一个能直接用的安装） */
const DEPLOY_ITEMS = ['launcher', 'shortcuts', 'workbench', 'dist', '本地AI.cmd', '使用入口说明.txt'];

/** 项目本体里不该进快照的东西 */
const KIT_SKIP = new Set([
  '.git', '.smoke', 'node_modules', 'node', 'release',
  'dsh-runtime', '__pycache__', 'check_out', 'probe_out',
  // tests 不进快照：快照是「拷走就能跑」的部署，不是源码归档（离线包里也没有）。
  // 而且 `node --test` 会递归收走快照里那份测试，跑一遍等于跑两遍，
  // 那份副本又不在仓库根目录，路径相关的用例必然失败。
  'tests',
]);
/**
 * 项目本体里不该进快照的东西。
 *
 * 这里排除的都是「跑起来才会生成的东西」和「别人机器上的残留」：
 *   - 配置.json / 使用记录.json / 出字快测.json：运行期数据，别人的机器不该带着
 *   - start-ai.cmd 等入口：安装向导会生成，仓库里本来就不提交
 *   - *.bak-2026... / *.tmp / *.log：备份和日志
 *
 * `.gitattributes` / `.gitignore` 也必须排除：它们一旦落进快照里的子目录，
 * 就会被 git 当成嵌套规则，反过来覆盖根目录的设置 ——
 * .gitattributes 会让包体走回换行符规范化（整份快照变假 diff），
 * .gitignore 会把本该入库的文件挡在仓库外（清单里算了它、仓库里却没有）。
 * 离线包里本来也没有这两个文件。
 */
const KIT_SKIP_FILE = new RegExp('^(' + [
  '配置\\.json(\\..*)?', '使用记录\\.json', '出字快测\\.json',
  '\\.gitattributes', '\\.gitignore', 'Thumbs\\.db', 'desktop\\.ini', '\\.DS_Store',
  'start-ai\\.cmd', 'stop-ai\\.cmd', '控制台\\.cmd', '重建桌面图标\\.cmd', '卸载\\.cmd',
  '.*\\.(bak|tmp|zip|log)([-.].*)?',
].join('|') + ')$');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function rel(p) {
  return path.relative(KIT, p).split(path.sep).join('/');
}

/** 递归列出目录下的文件；skip=true 时跳过 .git / 运行期产物（复制源码用），
 *  false 时一个不漏（生成清单用 —— 离线包 zip 不能被 *.zip 规则漏掉） */
function walk(dir, skip = true, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (skip && KIT_SKIP.has(e.name)) continue;
    if (skip && KIT_SKIP_FILE.test(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, skip, out);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

function copyInto(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

/** 找出部署目录里最新的那个离线包 */
function newestZip(dir) {
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.zip')); } catch { return null; }
  if (!names.length) return null;
  const withTime = names.map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }));
  withTime.sort((a, b) => b.t - a.t);
  return path.join(dir, withTime[0].n);
}

/**
 * 调 package-offline 现打一个包，返回 zip 路径。
 *
 * 打完做两件事：
 *   1. 把 dist/ 下解压出来的临时目录删掉（zip 里已经有了，留着只会越攒越乱）
 *   2. 把时间戳命名的 zip 改成带版本号的名字 —— 发布包按版本区分，
 *      而且重跑一次会覆盖同名文件，不会攒出一堆只差几秒的重复包
 */
function buildZip(deployDir, version) {
  const outDir = path.join(deployDir, 'dist');
  fs.mkdirSync(outDir, { recursive: true });
  console.log('正在打包离线安装包…');
  const out = execFileSync(process.execPath, [path.join(HERE, 'package-offline.mjs'), outDir], {
    cwd: KIT, encoding: 'utf8', timeout: 600000,
  });
  const built = newestZip(outDir);
  if (!built) {
    console.error(out.trim());
    throw new Error('打包没有产出 zip');
  }

  for (const n of fs.readdirSync(outDir)) {
    const full = path.join(outDir, n);
    if (!/^local-ai-kit-offline-/.test(n) || !fs.statSync(full).isDirectory()) continue;
    fs.rmSync(full, { recursive: true, force: true });
  }

  const wanted = path.join(outDir, `local-ai-kit-offline-${version}.zip`);
  if (path.resolve(built) === path.resolve(wanted)) return wanted;
  fs.rmSync(wanted, { force: true });
  fs.renameSync(built, wanted);
  return wanted;
}

/** 生成清单文本：按路径排序，LF 换行（CRLF 会让 sha256sum -c 把路径读成带 \r 的） */
function buildManifest(files) {
  return files
    .map((f) => ({ p: rel(f), h: sha256(f) }))
    .sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0))
    .map((x) => `${x.h}  ${x.p}`)
    .join('\n') + '\n';
}

function verify() {
  const manifestPath = path.join(KIT, 'release', 'SHA256SUMS.txt');
  if (!fs.existsSync(manifestPath)) {
    console.error('没有找到 release/SHA256SUMS.txt');
    return 1;
  }
  const lines = fs.readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean);
  let ok = 0;
  const bad = [];
  const missing = [];
  const seen = new Set();
  for (const line of lines) {
    const m = /^([0-9a-f]{64})\s\s(.+)$/.exec(line.replace(/\r$/, ''));
    if (!m) { bad.push(`格式不对：${line.slice(0, 60)}`); continue; }
    const file = path.join(KIT, m[2]);
    seen.add(path.normalize(file));
    if (!fs.existsSync(file)) { missing.push(m[2]); continue; }
    if (sha256(file) === m[1]) ok++;
    else bad.push(m[2]);
  }
  // 清单之外多出来的文件（改了文件忘了重跑脚本时能发现）
  const extra = walk(path.join(KIT, 'release'), false)
    .filter((f) => path.basename(f) !== 'SHA256SUMS.txt')
    .filter((f) => !seen.has(path.normalize(f)));

  console.log(`清单：${lines.length} 条`);
  console.log(`  一致  ${ok}`);
  console.log(`  不符  ${bad.length}`);
  console.log(`  缺失  ${missing.length}`);
  console.log(`  未登记 ${extra.length}`);
  for (const p of bad.slice(0, 20)) console.log(`  ✗ ${p}`);
  for (const p of missing.slice(0, 20)) console.log(`  ? ${p}`);
  for (const p of extra.slice(0, 20)) console.log(`  + ${rel(p)}`);
  if (bad.length + missing.length + extra.length) {
    console.log('\n不一致 —— 重跑一次 `npm run release` 会重新生成快照和清单。');
    return 1;
  }
  console.log('\n全部一致。');
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (name, fallback = null) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
  };

  if (argv.includes('--verify')) return verify();

  const pkg = JSON.parse(fs.readFileSync(path.join(KIT, 'package.json'), 'utf8'));
  const version = arg('version', pkg.version);
  if (!version) { console.error('缺少 --version'); return 1; }
  if (version !== pkg.version) {
    console.error(`版本对不上：package.json 是 ${pkg.version}，命令行给的是 ${version}。`);
    console.error('先把 package.json 的 version 改好，再跑这个脚本。');
    return 1;
  }

  // 部署目录：默认取仓库的上一级（本项目就装在「本地AI」下面）
  const deployDir = path.resolve(arg('from', path.dirname(KIT)));
  if (!fs.existsSync(path.join(deployDir, 'local-ai-kit'))) {
    console.error(`部署目录 ${deployDir} 里没有 local-ai-kit/，用 --from 指定正确的位置。`);
    return 1;
  }

  const outRoot = path.join(KIT, 'release');
  const name = `local-ai-kit-${version}-win-x64`;
  const dest = path.join(outRoot, version, name);

  const zip = argv.includes('--no-zip') ? newestZip(path.join(deployDir, 'dist')) : buildZip(deployDir, version);

  console.log(`正在生成快照 release/${version}/${name}/ …`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  // 1. 项目本体（walk 已经跳过 .git / release / 运行期产物）
  for (const f of walk(KIT)) copyInto(f, path.join(dest, 'local-ai-kit', path.relative(KIT, f)));

  // 2. 部署目录里的周边（启动器、快捷方式、Strata 工作台、离线包）
  for (const item of DEPLOY_ITEMS) {
    const src = path.join(deployDir, item);
    if (!fs.existsSync(src)) continue;
    if (fs.statSync(src).isDirectory()) {
      if (item === 'dist') {
        // dist 只带最新那个包，历史包留在本地就行
        if (zip) copyInto(zip, path.join(dest, 'dist', path.basename(zip)));
      } else {
        for (const f of walk(src)) copyInto(f, path.join(dest, item, path.relative(src, f)));
      }
    } else {
      copyInto(src, path.join(dest, item));
    }
  }

  const snapFiles = walk(dest, false);
  const sizeMB = (snapFiles.reduce((s, f) => s + fs.statSync(f).size, 0) / 1048576).toFixed(1);

  // 3. 清掉旧版本（默认保留，加 --prune 才删）
  if (argv.includes('--prune')) {
    for (const d of fs.readdirSync(outRoot)) {
      const full = path.join(outRoot, d);
      if (d === version || !fs.statSync(full).isDirectory()) continue;
      fs.rmSync(full, { recursive: true, force: true });
      console.log(`已移除旧版本快照 release/${d}/`);
    }
  }

  // 4. 清单覆盖 release/ 下的全部文件（含历史版本），这样 --verify 不会有「未登记」
  const all = walk(outRoot, false).filter((f) => path.basename(f) !== 'SHA256SUMS.txt');
  fs.writeFileSync(path.join(outRoot, 'SHA256SUMS.txt'), buildManifest(all), 'utf8');

  console.log('');
  console.log(`快照完成：${snapFiles.length} 个文件，${sizeMB} MB`);
  console.log(`  目录：release/${version}/${name}/`);
  console.log(`  清单：release/SHA256SUMS.txt（${all.length} 条）`);
  if (zip) console.log(`  离线包：${zip}（${(fs.statSync(zip).size / 1048576).toFixed(1)} MB）`);
  console.log('');

  return verify();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
