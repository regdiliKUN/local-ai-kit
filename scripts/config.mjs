/** 部署包的配置文件读写（存在安装目录下的 配置.json）。 */

import fs from 'node:fs';
import path from 'node:path';

const FILE = '配置.json';

export function loadConfig(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, FILE), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

export function saveConfig(root, cfg) {
  const file = path.join(root, FILE);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}

export function deploymentRoot(here) {
  if (fs.existsSync(path.join(here, FILE))) return here;
  const parent = path.dirname(here);
  return path.basename(here) === 'scripts' ? parent : here;
}
