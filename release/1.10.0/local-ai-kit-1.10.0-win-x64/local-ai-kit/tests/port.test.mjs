/**
 * 端口归属查询。
 *
 * 这个函数存在的意义是：Ollama 开了局域网共享会监听 0.0.0.0，
 * dsh 可能监听 [::]。只匹配 127.0.0.1 的话，用户点「停止」会得到
 * 「本来就没在运行」，而进程还在占显存——最难查的那种。
 */
import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const kit = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { pidOnPort } = await import(pathToFileURL(path.join(kit, 'scripts/detect.mjs')).href);

// 真实的 netstat -ano -p TCP 输出片段（中英文系统头部不同，这里只留数据行）
const NETSTAT = `
  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1024
  TCP    127.0.0.1:11434        0.0.0.0:0              LISTENING       2048
  TCP    0.0.0.0:11434          0.0.0.0:0              LISTENING       4096
  TCP    [::]:3080              [::]:0                 LISTENING       5120
  TCP    [::1]:7791             [::]:0                 LISTENING       6144
  TCP    192.168.1.5:8080       0.0.0.0:0              LISTENING       7168
`;

test('能查到绑定 127.0.0.1 的进程', () => {
  assert.equal(pidOnPort(11434, NETSTAT), 2048, '同一端口出现多次时取第一条');
});

test('能查到绑定 0.0.0.0 的进程（局域网共享）', () => {
  assert.equal(pidOnPort(135, NETSTAT), 1024);
});

test('能查到 IPv6 通配地址 [::] 的进程', () => {
  assert.equal(pidOnPort(3080, NETSTAT), 5120, '[::] 只匹配 127.0.0.1 会漏掉');
});

test('能查到 IPv6 回环 [::1] 的进程', () => {
  assert.equal(pidOnPort(7791, NETSTAT), 6144);
});

test('能查到绑定具体网卡 IP 的进程', () => {
  assert.equal(pidOnPort(8080, NETSTAT), 7168);
});

test('端口没人监听时返回 null', () => {
  assert.equal(pidOnPort(9999, NETSTAT), null);
});

test('空输出不抛异常', () => {
  assert.equal(pidOnPort(11434, ''), null);
  assert.equal(pidOnPort(11434, null), null);
});

test('端口号按数字比较，不受前导零影响', () => {
  const text = '  TCP    0.0.0.0:08080          0.0.0.0:0              LISTENING       9001\n';
  assert.equal(pidOnPort(8080, text), 9001);
});
