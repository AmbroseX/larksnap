// 零依赖的 data URL 落盘 + zip 解包（仅用 Node 内置 zlib）。
// 扩展产出的 zip 由 JSZip 生成（store/deflate），尺寸以「中央目录」为准
// （本地头可能因 data descriptor 位而置 0），故一律从中央目录读尺寸。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** data URL → Buffer（支持 base64 与 percent-encoding 两种）。 */
export function dataUrlToBuffer(dataUrl) {
  // data:[<mediatype>][;base64],<data>，其中 mediatype 可带任意 ;参数（如 ;charset=utf-8）
  const comma = typeof dataUrl === 'string' ? dataUrl.indexOf(',') : -1;
  if (!dataUrl || !dataUrl.startsWith('data:') || comma < 0) {
    throw new Error('无效的 data URL');
  }
  const meta = dataUrl.slice(5, comma); // 去掉 "data:"
  const data = dataUrl.slice(comma + 1);
  const isB64 = /;base64$/i.test(meta);
  return isB64
    ? Buffer.from(data, 'base64')
    : Buffer.from(decodeURIComponent(data), 'utf8');
}

/** 把单个 data URL 写到 outPath。 */
export function writeDataUrl(dataUrl, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, dataUrlToBuffer(dataUrl));
}

/** 解包 zip 的 data URL 到 destDir，返回写入的相对路径列表。 */
export function unzipInto(dataUrl, destDir) {
  const buf = dataUrlToBuffer(dataUrl);
  const written = [];
  for (const e of readZipEntries(buf)) {
    if (e.name.endsWith('/')) continue; // 目录项
    const data = e.method === 8 ? zlib.inflateRawSync(e.compressed) : e.compressed;
    // 防目录穿越
    const safe = e.name
      .split(/[\\/]/)
      .filter((p) => p && p !== '..' && p !== '.')
      .join(path.sep);
    if (!safe) continue;
    const out = path.join(destDir, safe);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
    written.push(safe);
  }
  return written;
}

function readZipEntries(buf) {
  // 从尾部定位 EOCD（End Of Central Directory，含可选注释，反向扫描）
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('非法 zip：未找到 EOCD');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16); // 中央目录起始偏移
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('非法中央目录项');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);

    // 本地头只用来定位数据起点（名长/扩展长可能与中央目录不同）
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('非法本地头');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const compressed = buf.subarray(dataStart, dataStart + compSize);

    entries.push({ name, method, compressed });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
