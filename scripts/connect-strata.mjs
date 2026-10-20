/** Attach to an existing deployment; does not download models or edit dsh profiles. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveConfig } from './config.mjs';
import { validateStrataConfig } from './strata.mjs';

const args = process.argv.slice(2);
function option(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`缺少 ${name} 的值`);
  return args[i + 1];
}
if (args.includes('--help')) {
  console.log('node scripts/connect-strata.mjs --root F:\\本地AI --strata-home F:\\Strata --dsh-dir C:\\path\\dsh-runtime [--engine-port 8080] [--web-port 8090] [--dsh-port 3080] [--python EXE] [--model-dir DIR] [--dsh-home DIR]');
} else {
  try {
    const deploymentRoot = path.resolve(option('--root', '.'));
    const strataHome = path.resolve(option('--strata-home', path.join(path.dirname(deploymentRoot), 'Strata')));
    const cfg = validateStrataConfig({ backend: 'strata', deploymentRoot, strataHome,
      dshDir: path.resolve(option('--dsh-dir', path.join(os.homedir(), 'dsh-runtime'))),
      dshHome: path.resolve(option('--dsh-home', process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))),
      pythonExe: path.resolve(option('--python', path.join(strataHome, '.venv', 'Scripts', 'python.exe'))),
      modelDir: path.resolve(option('--model-dir', path.join(path.dirname(deploymentRoot), 'Strata-data'))),
      enginePort: Number(option('--engine-port', 8080)), webPort: Number(option('--web-port', 8090)),
      dshPort: Number(option('--dsh-port', 3080)) });
    if (!fs.existsSync(cfg.pythonExe)) throw new Error(`Python 不存在：${cfg.pythonExe}`);
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const file = path.join(root, '配置.json');
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.${Date.now()}.bak`);
    saveConfig(root, cfg);
    console.log('已接入 Strata。运行 node scripts/console.mjs 打开控制台。');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
