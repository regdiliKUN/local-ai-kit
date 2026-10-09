/** 部署包的配置文件读写（存在安装目录下的 配置.json）。 */

import fs from 'node:fs';
import path from 'node:path';

const FILE = '配置.json';

export function loadConfig(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, FILE), 'utf8'));
  } catch {
    return null;
  }
}

export function saveConfig(root, cfg) {
  fs.writeFileSync(path.join(root, FILE), JSON.stringify(cfg, null, 2), 'utf8');
}
