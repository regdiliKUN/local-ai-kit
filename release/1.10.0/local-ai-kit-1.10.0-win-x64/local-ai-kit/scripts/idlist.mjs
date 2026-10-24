/**
 * 构造 Windows 快捷方式的目标 ID 列表（MS-SHLLINK）。
 *
 * 结构：
 *   [IDListSize:2] [ItemID...] [TerminalID:2]
 *   ItemID: [Size:2][Type:1] + 内容，Size 含自身
 *     0x1f 我的电脑  → GUID 20D04FE0-3AEA-1069-A2D8-08002B30309D，共 20 字节
 *     0x2f 盘符根    → 'X:\' + NUL，再补 18 个 0，共 25 字节
 *     0x31 目录 / 0x32 文件
 *        [Size][type][00][filesize:4][0000 0000][0000] + name(ASCII,NUL) + [extsize:2]=0
 *        补齐到偶数长度
 *
 * 没有这个列表，Windows 不认 .lnk（双击会报"没有应用程序与此操作的指定文件有关联"）。
 */

import path from 'node:path';

const MY_COMPUTER = Buffer.from('50e04fd020ea3a6910a2d808002b30309d', 'hex');

function itemMyComputer() {
  const body = Buffer.concat([Buffer.from([0x1f]), MY_COMPUTER, Buffer.from([0x00])]);
  const size = Buffer.alloc(2);
  size.writeUInt16LE(body.length + 2);
  return Buffer.concat([size, body]);
}

function itemDrive(letter) {
  const name = Buffer.from(`${letter.toUpperCase()}:\\`, 'ascii');
  const body = Buffer.concat([
    Buffer.from([0x2f]),
    name,
    Buffer.from([0x00]),
    Buffer.alloc(18),
  ]);
  const size = Buffer.alloc(2);
  size.writeUInt16LE(body.length + 2);
  return Buffer.concat([size, body]);
}

function itemPathComponent(name, isDir) {
  const nameBuf = Buffer.from(name, 'ascii');
  const body = Buffer.concat([
    Buffer.from([isDir ? 0x31 : 0x32, 0x00]),
    Buffer.alloc(4),            // 文件大小
    Buffer.alloc(4),            // 未知
    Buffer.alloc(2),            // 未知
    nameBuf,
    Buffer.from([0x00]),
    Buffer.alloc(2),            // 扩展块大小 = 0
  ]);
  let size = body.length + 2;
  let pad = Buffer.alloc(0);
  if (size % 2) {
    pad = Buffer.from([0x00]);
    size += 1;
  }
  const sizeBuf = Buffer.alloc(2);
  sizeBuf.writeUInt16LE(size);
  return Buffer.concat([sizeBuf, body, pad]);
}

export function buildIdList(target) {
  const abs = path.resolve(target);
  const parsed = path.parse(abs);
  const drive = parsed.root.replace(/[\\/]+$/, '');      // 'C:'
  const rest = abs.slice(parsed.root.length);
  const parts = rest.split(/[\\/]+/).filter(Boolean);

  const chunks = [itemMyComputer(), itemDrive(drive[0])];
  parts.forEach((p, i) => chunks.push(itemPathComponent(p, i < parts.length - 1)));
  chunks.push(Buffer.alloc(2));                          // TerminalID

  const items = Buffer.concat(chunks);
  const sizeBuf = Buffer.alloc(2);
  sizeBuf.writeUInt16LE(items.length);
  return Buffer.concat([sizeBuf, items]);
}
