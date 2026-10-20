import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createSafeServer, readBody, tokenMatches } from '../scripts/local-http.mjs';
import { copyRuntime } from '../scripts/runtime-assets.mjs';
import { loadConfig, saveConfig } from '../scripts/config.mjs';
import { isUp } from '../scripts/ollama.mjs';
import { handleStrata, runStrataAction } from '../scripts/strata.mjs';

const kit = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function serve(handler, work) {
  const server = createSafeServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await work(base); } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
}

test('HTTP health rejects server errors', async () => {
  await serve((_req, res) => { res.writeHead(500); res.end('failed'); }, async (base) => assert.equal(await isUp(base), false));
  await serve((_req, res) => res.end('ready'), async (base) => assert.equal(await isUp(base), true));
});

test('tokens compare byte lengths and malformed bodies do not kill HTTP service', async () => {
  assert.equal(tokenMatches('é'.repeat(48), 'a'.repeat(48)), false);
  assert.equal(tokenMatches('secret', 'secret'), true);
  await serve(async (req, res) => { const body = await readBody(req); res.end(JSON.stringify(body)); }, async (base) => {
    for (const [body, code] of [['{', 400], ['null', 400], ['[]', 400], ['"text"', 400], ['x'.repeat(70000), 413]]) {
      assert.equal((await fetch(base, { method: 'POST', body })).status, code);
    }
    const response = await fetch(base, { method: 'POST', body: JSON.stringify({ message: '本地 AI ✓' }) });
    assert.deepEqual(await response.json(), { message: '本地 AI ✓' });
  });
});

test('newly installed flat runtime has a working console, presets and healthcheck', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-runtime-'));
  let child;
  try {
    copyRuntime(kit, root);
    fs.cpSync(path.join(kit, 'ui'), path.join(root, 'ui'), { recursive: true });
    const { readPresetStandard } = await import('file:///' + path.join(root, 'install.mjs').replaceAll('\\', '/'));
    assert.match(readPresetStandard(root), /compaction-basic/);
    assert.ok(fs.existsSync(path.join(root, 'healthcheck', 'golden.jsonl')));
    child = spawn(process.execPath, [path.join(root, 'console.mjs')], { windowsHide: true,
      env: { ...process.env, LOCALAI_NO_BROWSER: '1', DSH_HOME: path.join(root, 'state') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    child.stderr.on('data', (chunk) => { errors += chunk; });
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Console failed to start: ${errors}`)), 12000);
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Console exited ${code}: ${errors}`)); });
      child.stdout.on('data', (chunk) => {
        output += chunk;
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
    });
    const html = await (await fetch(url)).text();
    const token = html.match(/window\.__TOKEN__='([^']+)'/)[1];
    assert.equal((await fetch(url + 'api/config', { method: 'POST', headers: { 'X-LocalAI-Token': 'é'.repeat(token.length) }, body: '{}' })).status, 403);
    assert.equal((await fetch(url + 'api/config', { method: 'POST', headers: { 'X-LocalAI-Token': token }, body: '{' })).status, 400);
    assert.equal((await fetch(url)).status, 200);
    assert.equal(errors, '');
  } finally {
    if (child && child.exitCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('configuration accepts Windows BOM and replaces files atomically', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-config-'));
  try {
    fs.writeFileSync(path.join(root, '配置.json'), '\uFEFF{"model":"first"}');
    assert.equal(loadConfig(root).model, 'first');
    saveConfig(root, { model: 'second' });
    assert.equal(loadConfig(root).model, 'second');
    assert.deepEqual(fs.readdirSync(root), ['配置.json']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Strata mode blocks every Ollama mutation and reports independent service health', async () => {
  await serve((_req, res) => res.end('ok'), async (engine) => {
    const enginePort = Number(new URL(engine).port);
    const cfg = { backend: 'strata', deploymentRoot: 'F:\\本地AI', enginePort, webPort: 1, dshPort: 2 };
    await serve((req, res) => handleStrata(req, res, { cfg, ui: path.join(kit, 'ui'), token: 'example' }), async (base) => {
      for (const endpoint of ['pull', 'delete', 'config', 'settings', 'health']) {
        assert.equal((await fetch(`${base}/api/${endpoint}`, { method: 'POST', body: '{}' })).status, 409);
      }
      const state = await (await fetch(base + '/api/state')).json();
      assert.equal(state.engine.online, true);
      assert.equal(state.webui.online, false);
      assert.equal(state.dsh.online, false);
      assert.equal((await fetch(base + '/api/service', { method: 'POST', body: '{"action":"uninstall"}' })).status, 400);
      assert.match(await (await fetch(base)).text(), /window\.__TOKEN__="example"/);
    });
  });
});

test('Windows stop refuses an unrelated listener and stops owned processes, including loading engines', { skip: process.platform !== 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-进程-'));
  const engine = path.join(root, 'strata');
  const dsh = path.join(root, 'dsh');
  const script = path.join(engine, 'serve', 'server.py');
  const files = [script, path.join(root, 'workbench/tools/run-strata.bat'), path.join(root, 'workbench/webui/server.py'), path.join(dsh, 'node_modules/@deepseek-ai/dsh/lib/bin.js')];
  for (const file of files) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ''); }
  let child;
  try {
    await serve((_req, res) => res.end('unrelated'), async (base) => {
      const cfg = { deploymentRoot: root, strataHome: engine, dshDir: dsh,
        enginePort: Number(new URL(base).port), webPort: 1, dshPort: 2 };
      const refused = await runStrataAction(cfg, 'stop');
      assert.equal(refused.ok, false);
      assert.ok(refused.refused.includes(process.pid));
      assert.equal((await fetch(base)).status, 200);
    });
    fs.writeFileSync(script, 'console.log("ready");setInterval(()=>{},1000);');
    child = spawn(process.execPath, [script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    await once(child.stdout, 'data');
    const cfg = { deploymentRoot: root, strataHome: engine, dshDir: dsh, enginePort: 3, webPort: 1, dshPort: 2 };
    const dry = await runStrataAction(cfg, 'stop', { dryRun: true });
    assert.ok(dry.stopped.includes(child.pid));
    assert.equal(child.exitCode, null);
    const closed = once(child, 'close');
    const stopped = await runStrataAction(cfg, 'stop');
    assert.equal(stopped.ok, true);
    assert.ok(stopped.stopped.includes(child.pid));
    await closed;
  } finally {
    if (child && child.exitCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
