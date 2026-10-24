/**
 * 离线安装包制作。
 *
 * 场景：给一台没网的机器装本地 AI，或者一次性做很多台。
 * 这时「先下载再拷贝」比「到机器上再下」快得多，也不怕网不好。
 *
 * 这个脚本把整套东西打成 zip：
 *   - 项目本体（脚本、界面、图标、文档）
 *   - 可选的便携 Node.js（从本机拷一份过去，免得到目标机器上再下）
 *   - 一份清单（每个文件的 SHA256），装完可以校验
 *
 * 用法：
 *   node scripts/package-offline.mjs [输出目录]
 *   node scripts/package-offline.mjs --with-node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.dirname(HERE);

/** 要打进去的目录 / 文件（相对项目根） */
const INCLUDE = [
  'scripts', 'ui', 'icons', 'healthcheck', 'docs',
  '① 双击这里开始安装.cmd', '备用-命令行安装.cmd',
  '使用说明.html', '使用说明（纯文本版）.md',
  'LICENSE', 'README.md', 'CHANGELOG.md', 'package.json',
];

/** 不该进包的东西 */
const EXCLUDE = new Set(['node_modules', '.git', 'check_out', 'probe_out', '__pycache__', 'node']);

function walk(dir, base = dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (EXCLUDE.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else if (e.isFile()) out.push(path.relative(base, full));
  }
  return out;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 找一台便携 Node（优先用项目自带的 node/，其次用当前的） */
function findPortableNode() {
  const bundled = path.join(KIT, 'node');
  if (fs.existsSync(path.join(bundled, 'node.exe'))) return bundled;
  return null;
}

/** 收集要打包的文件（相对项目根），排除掉不该进包的东西 */
export function collectFiles(kit = KIT) {
  const files = [];
  for (const item of INCLUDE) {
    const src = path.join(kit, item);
    if (!fs.existsSync(src)) continue;
    if (fs.statSync(src).isDirectory()) {
      for (const rel of walk(src)) files.push(path.join(item, rel));
    } else {
      files.push(item);
    }
  }
  return files;
}

/** 生成校验清单：每个文件一行 "<sha256>  <相对路径>" */
export function buildManifest(stage, files) {
  return files.map((rel) => `${sha256(path.join(stage, rel))}  ${rel}`).join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const withNode = args.includes('--with-node');
  const outDir = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(os.tmpdir(), 'local-ai-offline'));
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const stage = path.join(outDir, `local-ai-kit-offline-${stamp}`);

  fs.mkdirSync(stage, { recursive: true });

  const files = collectFiles(KIT);
  for (const rel of files) {
    const from = path.join(KIT, rel);
    const to = path.join(stage, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }

  let nodeDir = null;
  if (withNode) {
    nodeDir = findPortableNode();
    if (!nodeDir) {
      console.error('没有找到便携 Node（项目里的 node/ 目录）。先跑一次安装向导，它会准备好。');
    } else {
      const dest = path.join(stage, 'node');
      fs.mkdirSync(dest, { recursive: true });
      for (const rel of walk(nodeDir)) {
        const from = path.join(nodeDir, rel);
        const to = path.join(dest, rel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
      }
      console.log(`已包含便携 Node：${nodeDir}`);
    }
  }

  // 清单：每个文件的 SHA256，装完能校验有没有损坏
  const manifest = buildManifest(stage, files);
  fs.writeFileSync(path.join(stage, 'manifest.sha256'), `${manifest}\n`, 'utf8');

  // 打包成 zip（优先用 Windows 自带的 Compress-Archive）
  const zip = path.join(outDir, `local-ai-kit-offline-${stamp}.zip`);
  try {
    execFileSync('powershell', [
      '-NoProfile', '-Command',
      `Compress-Archive -Path '${stage}\\*' -DestinationPath '${zip}' -Force`,
    ], { stdio: 'ignore', timeout: 300000 });
  } catch {
    console.error('打包 zip 失败（PowerShell 不可用？）');
    console.log(`文件已经放在：${stage}`);
    return;
  }

  const sizeMB = (fs.statSync(zip).size / 1048576).toFixed(1);
  console.log('');
  console.log('离线安装包已生成');
  console.log(`  压缩包：${zip}（${sizeMB} MB）`);
  console.log(`  文件数：${files.length}（含 manifest.sha256 校验清单）`);
  console.log('');
  console.log('拷到目标机器上，解压后双击「① 双击这里开始安装.cmd」即可。');
  if (!nodeDir) {
    console.log('提示：目标机器如果没网，勾上 --with-node 重新打包会带上便携 Node。');
  }
}

// 直接运行时才打包（被测试 import 时不跑）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
