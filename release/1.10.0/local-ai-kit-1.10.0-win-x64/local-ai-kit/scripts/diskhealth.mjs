/**
 * 磁盘健康检测。
 *
 * 「硬盘是不是快坏了」「模型该放哪个盘」—— 这两个问题 Windows 自己知道答案，
 * 只是没告诉你。这里用 PowerShell 的存储查询把它挖出来。
 *
 * 能拿到的：
 *   - 介质类型（SSD / HDD / NVMe）
 *   - 健康状态、剩余寿命百分比、通电时间、磨损度
 *   - 每个盘符对应的物理磁盘
 *   - 容量与剩余空间
 *
 * 拿不到就返回空数组（老系统、或没装存储相关服务），不能因此报错。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$out = @()
try {
  $phys = Get-PhysicalDisk
  foreach ($d in $phys) {
    $rel = $d | Get-StorageReliabilityCounter
    $letter = ''
    $vol = ''
    try {
      $part = Get-Partition -DiskNumber $d.DeviceId | Where-Object { $_.DriveLetter } | Select-Object -First 1
      if ($part) {
        $letter = $part.DriveLetter
        $v = Get-Volume -DriveLetter $letter -ErrorAction SilentlyContinue
        if ($v) { $vol = [math]::Round($v.Size / 1GB, 1) }
      }
    } catch {}
    $out += [PSCustomObject]@{
      name = $d.FriendlyName
      media = $d.MediaType
      bus = $d.BusType
      health = $d.HealthStatus
      size = [math]::Round($d.Size / 1GB, 1)
      letter = $letter
      volumeGB = $vol
      temp = if ($rel) { $rel.Temperature } else { $null }
      wear = if ($rel) { $rel.Wear } else { $null }
      lifeLeft = if ($rel) { $rel.DiskHealthPercentage } else { $null }
      powerOn = if ($rel) { $rel.PowerOnHours } else { $null }
    }
  }
} catch {}
$out | ConvertTo-Json -Compress -Depth 3
`;

/** 跑一次 PowerShell 存储查询 */
function queryDisks() {
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT,
    ], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    const text = String(out || '').trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

let cache = { at: 0, items: null };

/**
 * 磁盘健康信息。
 *
 * @param {object} opts { refresh }
 */
export function diskHealth({ refresh = false } = {}) {
  if (!refresh && cache.items && Date.now() - cache.at < 60000) return cache.items;
  const raw = queryDisks();
  const items = mergePhysical(raw.map((d) => normalize(d)));
  cache = { at: Date.now(), items };
  return items;
}

/** 把 PowerShell 的输出整理成好用的形状 */
function normalize(d) {
  const letter = d.letter ? `${d.letter}:` : '';
  const health = String(d.health || '').toLowerCase();
  // DiskHealthPercentage 在「拿不到计数」时是 0，不是「寿命归零」。
  // 0 寿命的盘根本挂不出来 —— 所以 0 一律当成「没有数据」。
  const rawLife = Number(d.lifeLeft);
  const life = Number.isFinite(rawLife) && rawLife > 0 ? rawLife : null;
  const rawWear = Number(d.wear);
  const wear = Number.isFinite(rawWear) && rawWear > 0 ? rawWear : null;
  const rawTemp = Number(d.temp);
  const temp = Number.isFinite(rawTemp) && rawTemp > 0 ? rawTemp : null;

  let level = 'ok';
  let note = '';
  if (health && health !== 'healthy' && health !== 'ok') {
    level = 'error';
    note = `Windows 报告的状态是 ${d.health}`;
  } else if (life != null && life <= 10) {
    level = 'error';
    note = `剩余寿命只剩 ${life}%，该换盘了`;
  } else if (life != null && life <= 25) {
    level = 'warn';
    note = `剩余寿命 ${life}%，还能用但该留意`;
  } else if (wear != null && wear >= 90) {
    level = 'warn';
    note = `磨损 ${wear}%，写入量已经很大了`;
  } else if (temp != null && temp >= 55) {
    level = 'warn';
    note = `温度 ${temp}°C 偏高`;
  } else if (life != null) {
    note = `剩余寿命 ${life}%`;
  } else {
    note = '系统没有提供寿命数据';
  }

  return {
    name: d.name || '未知磁盘',
    letter,
    media: String(d.media || '').toLowerCase(),
    mediaText: mediaText(d),
    bus: d.bus || '',
    health: d.health || '未知',
    sizeGB: Number(d.size) || 0,
    volumeGB: Number(d.volumeGB) || 0,
    temp,
    wear,
    lifeLeft: life,
    powerOnHours: Number.isFinite(Number(d.powerOn)) ? Number(d.powerOn) : null,
    level,
    note,
  };
}

/**
 * 同一块物理盘有多个分区时，PowerShell 会报好几条。
 * 这里按盘名合并，把盘符串起来 —— 界面上一块盘一行。
 */
function mergePhysical(items) {
  const byName = new Map();
  for (const d of items) {
    const hit = byName.get(d.name);
    if (!hit) { byName.set(d.name, { ...d, letters: d.letter ? [d.letter] : [] }); continue; }
    if (d.letter) hit.letters.push(d.letter);
    // 任何一条有寿命数据就用它
    if (d.lifeLeft != null && hit.lifeLeft == null) hit.lifeLeft = d.lifeLeft;
    if (d.temp != null && hit.temp == null) hit.temp = d.temp;
    if (d.wear != null && hit.wear == null) hit.wear = d.wear;
    if (d.level !== 'ok') hit.level = d.level;
  }
  return [...byName.values()].map((d) => ({
    ...d,
    letter: d.letters.join(' '),
  }));
}

function mediaText(d) {
  const m = String(d.media || '').toLowerCase();
  const b = String(d.bus || '').toLowerCase();
  if (m.includes('nvme') || b.includes('nvme')) return 'NVMe 固态';
  if (m.includes('ssd')) return '固态硬盘';
  if (m.includes('hdd')) return '机械硬盘';
  if (m.includes('removable')) return '可移动';
  if (b.includes('usb')) return 'USB 外接';
  return d.media || '未知';
}

/**
 * 某个目录所在物理磁盘的健康情况（模型目录该放哪盘、那盘还撑得住吗）。
 */
export function diskForPath(p) {
  const all = diskHealth();
  if (!p || !all.length) return null;
  const root = path.parse(path.resolve(p)).root.toUpperCase();
  const letter = root.slice(0, 2);
  return all.find((d) => String(d.letter || '').toUpperCase().includes(letter)) || null;
}

/** 给界面用的一句总结 */
export function diskSummary(items) {
  if (!items || !items.length) return [];
  const out = [];
  const bad = items.filter((d) => d.level === 'error');
  const warn = items.filter((d) => d.level === 'warn');
  if (bad.length) {
    out.push(`有 ${bad.length} 块磁盘状态异常：${bad.map((d) => `${d.name}（${d.note}）`).join('、')} —— 别把模型放在这些盘上。`);
  }
  if (warn.length) {
    out.push(`${warn.length} 块磁盘需要注意：${warn.map((d) => `${d.name}（${d.note}）`).join('、')}。`);
  }
  if (!bad.length && !warn.length) out.push('所有磁盘状态正常。');
  const ssds = items.filter((d) => /nvme|ssd/i.test(d.mediaText));
  if (ssds.length) out.push(`固态盘有 ${ssds.length} 块 —— 模型放固态上加载快得多。`);
  return out;
}
