/** Keep source and installed console dependencies in one manifest. */
import fs from 'node:fs';
import path from 'node:path';

export const SCRIPT_FILES = [
  'config.mjs', 'models.mjs', 'ollama.mjs', 'detect.mjs', 'idlist.mjs', 'make-lnk.mjs',
  'make-shortcuts.mjs', 'start-local-ai.mjs', 'stop-local-ai.mjs',
  'console.mjs', 'uninstall.mjs', 'install.mjs', 'yamlpatch.mjs',
  'preset-standard.patch.yml', 'local-http.mjs', 'runtime-assets.mjs', 'strata.mjs',
  'strata-process.ps1',
  // v1.4.0 新增
  'metrics.mjs', 'history.mjs', 'space.mjs', 'pull-queue.mjs',
  'chat.mjs', 'bench.mjs', 'backup.mjs', 'repair.mjs', 'version.mjs',
  // v1.5.0 新增
  'store.mjs', 'library.mjs', 'netcheck.mjs', 'report.mjs',
  // v1.6.1 新增
  'zip.mjs',
  // v1.7.3 新增
  'usage.mjs',
];

export function copyRuntime(kitDir, root) {
  fs.mkdirSync(root, { recursive: true });
  for (const file of SCRIPT_FILES) fs.copyFileSync(path.join(kitDir, 'scripts', file), path.join(root, file));
  fs.cpSync(path.join(kitDir, 'healthcheck'), path.join(root, 'healthcheck'), {
    recursive: true,
    filter: (source) => !['check_out', 'probe_out', '__pycache__'].includes(path.basename(source)),
  });
}
