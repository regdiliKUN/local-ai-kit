/**
 * 直接构造 Windows 快捷方式（.lnk）—— 不依赖 COM / Python。
 *
 * 为什么手写：PowerShell 的 WScript.Shell COM 在受限环境下会被安全策略拦截，
 * 而手写二进制是纯文件写入，不涉及任何代码执行。
 */

import fs from 'node:fs';
import { buildIdList } from './idlist.mjs';

const HAS_LINK_TARGET_ID_LIST = 0x00000001;
const HAS_LINK_INFO = 0x00000002;
const HAS_NAME = 0x00000004;
const HAS_WORKING_DIR = 0x00000010;
const HAS_ARGUMENTS = 0x00000020;
const HAS_ICON_LOCATION = 0x00000040;
const IS_UNICODE = 0x00000080;

const LINK_CLSID = Buffer.from('0114020000000000C000000000000046', 'hex');
const HEADER_SIZE = 0x4c; // 76

function u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; }
function i32(v) { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; }
function u64(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; }

/** StringData：2 字节字符数 + UTF-16LE（不含结尾 NUL） */
function stringData(text) {
  const raw = Buffer.from(text, 'utf16le');
  return Buffer.concat([u16(raw.length / 2), raw]);
}

/**
 * LinkInfo：用 VolumeIDAndLocalBasePath 携带绝对目标路径。
 *
 * 路径含中文时要用「Unicode 变体」：LinkInfoHeaderSize 放到 0x24（36），
 * 末尾就多出两个字段 —— LocalBasePathOffsetUnicode / CommonPathSuffixOffsetUnicode，
 * 指向 UTF-16LE 版本的路径。这是 MS-SHLLINK 规定的做法。
 *
 * ASCII 那段必须留着（老解析器只认它），但没法表示中文时写一个空字符串，
 * 真正的路径交给 Unicode 那段 —— Windows 会优先用 Unicode。
 */
function linkInfo(localBasePath) {
  const ascii = /^[\x20-\x7e]*$/.test(localBasePath) ? localBasePath : '';
  const lbpAscii = Buffer.concat([Buffer.from(ascii, 'ascii'), Buffer.from([0])]);
  const suffixAscii = Buffer.from([0]);
  const lbpUni = Buffer.concat([Buffer.from(localBasePath, 'utf16le'), Buffer.from([0, 0])]);
  const suffixUni = Buffer.from([0, 0]);
  const label = Buffer.alloc(0);

  const volumeIdSize = 16 + label.length + 1;
  const volumeId = Buffer.concat([
    u32(volumeIdSize),
    u32(3),                 // DRIVE_FIXED
    u32(0),                 // 卷序列号
    u32(0x10),              // 卷标偏移
    label,
    Buffer.from([0]),
  ]);

  const HEADER = 0x24;      // 36：带 Unicode 偏移字段
  const volumeIdOff = HEADER;
  const lbpAsciiOff = volumeIdOff + volumeId.length;
  const suffixAsciiOff = lbpAsciiOff + lbpAscii.length;

  // UTF-16 字符串必须 2 字节对齐（相对 LinkInfo 起点）
  const pad = (HEADER + volumeId.length + lbpAscii.length + suffixAscii.length) % 2;
  const lbpUniOff = suffixAsciiOff + suffixAscii.length + pad;
  const suffixUniOff = lbpUniOff + lbpUni.length;
  const total = suffixUniOff + suffixUni.length;

  return Buffer.concat([
    u32(total),
    u32(HEADER),
    u32(0x00000001),        // VolumeIDAndLocalBasePath
    u32(volumeIdOff),
    u32(lbpAsciiOff),
    u32(0),                 // 无 CommonNetworkRelativeLink
    u32(suffixAsciiOff),
    u32(lbpUniOff),
    u32(suffixUniOff),
    volumeId,
    lbpAscii,
    suffixAscii,
    Buffer.alloc(pad),
    lbpUni,
    suffixUni,
  ]);
}

export function makeLnk({ lnkPath, target, workingDir, iconPath, iconIndex = 0, arguments: args, description }) {
  let flags = HAS_LINK_TARGET_ID_LIST | HAS_LINK_INFO | HAS_WORKING_DIR | HAS_ICON_LOCATION | IS_UNICODE;
  if (description) flags |= HAS_NAME;
  if (args) flags |= HAS_ARGUMENTS;

  const header = Buffer.concat([
    u32(HEADER_SIZE),
    LINK_CLSID,
    u32(flags),
    u32(0x00000020),        // FILE_ATTRIBUTE_ARCHIVE
    u64(0),                 // CreationTime
    u64(0),                 // AccessTime
    u64(0),                 // WriteTime
    u32(0),                 // FileSize
    i32(iconIndex),         // IconIndex
    u32(1),                 // ShowCommand = SW_SHOWNORMAL
    u16(0),                 // HotKey
    u16(0),                 // Reserved
    u32(0),                 // Reserved2
    u32(0),                 // Reserved3
  ]);
  if (header.length !== HEADER_SIZE) throw new Error(`header 长度错误: ${header.length}`);

  const parts = [header, buildIdList(target), linkInfo(target)];
  if (flags & HAS_NAME) parts.push(stringData(description));
  if (flags & HAS_WORKING_DIR) parts.push(stringData(workingDir));
  if (flags & HAS_ARGUMENTS) parts.push(stringData(args));
  if (flags & HAS_ICON_LOCATION) parts.push(stringData(iconPath));
  parts.push(u32(0));       // ExtraData 终止块

  const data = Buffer.concat(parts);
  fs.writeFileSync(lnkPath, data);
  return data.length;
}

/** 回读校验 */
export function verifyLnk(lnkPath) {
  const b = fs.readFileSync(lnkPath);
  if (b.readUInt32LE(0) !== HEADER_SIZE) throw new Error('HeaderSize 错误');
  return { size: b.length, flags: '0x' + b.readUInt32LE(20).toString(16) };
}
