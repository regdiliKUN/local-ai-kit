/**
 * Ollama 启动环境。
 *
 * 这里的核心约束：开了局域网共享（OLLAMA_HOST=0.0.0.0:11434）之后，
 * 任何「自愈拉起」都不能把它改回 127.0.0.1——否则用户看到的开关是开的，
 * 实际监听又变回本地，同一个 WiFi 下谁也连不上。
 */
import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const kit = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { ollamaEnv, ollamaVars } = await import(pathToFileURL(path.join(kit, 'scripts/ollama.mjs')).href);

const CFG = { contextWindow: 8192, modelDir: 'D:\\models' };

function withEnv(key, value, fn) {
  const old = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try { return fn(); } finally {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  }
}

test('没设置 OLLAMA_HOST 时默认只听本地', () => {
  withEnv('OLLAMA_HOST', undefined, () => {
    assert.equal(ollamaEnv(CFG).OLLAMA_HOST, '127.0.0.1:11434');
  });
});

test('开了局域网共享时保留 0.0.0.0，不被覆盖回本地', () => {
  withEnv('OLLAMA_HOST', '0.0.0.0:11434', () => {
    assert.equal(ollamaEnv(CFG).OLLAMA_HOST, '0.0.0.0:11434',
      '硬编码 127.0.0.1 会让共享开关形同虚设');
  });
});

test('自定义端口也保留', () => {
  withEnv('OLLAMA_HOST', '0.0.0.0:12345', () => {
    assert.equal(ollamaEnv(CFG).OLLAMA_HOST, '0.0.0.0:12345');
  });
});

test('其它 Ollama 参数照常注入', () => {
  withEnv('OLLAMA_HOST', undefined, () => {
    const env = ollamaEnv(CFG);
    assert.equal(env.OLLAMA_FLASH_ATTENTION, '1');
    assert.equal(env.OLLAMA_KV_CACHE_TYPE, 'q8_0');
    assert.equal(env.OLLAMA_CONTEXT_LENGTH, '8192');
    assert.equal(env.OLLAMA_MODELS, 'D:\\models');
  });
});

test('ollamaVars 在没给模型目录时不带 OLLAMA_MODELS', () => {
  const vars = ollamaVars({ contextWindow: 4096 });
  assert.equal(vars.OLLAMA_MODELS, undefined, '不设的话应该让 Ollama 用默认目录');
  assert.equal(vars.OLLAMA_CONTEXT_LENGTH, '4096');
});

test('ollamaVars 默认上下文是 8192', () => {
  assert.equal(ollamaVars({}).OLLAMA_CONTEXT_LENGTH, '8192');
});
