import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { compressionFor, createZipDataUrl, megabytesOf } from './zip';

/**
 * issue #9：几百张图的文档打 zip 卡几十秒。图片本身已压缩，再 DEFLATE 一遍只费 CPU，
 * 这里守住"图片走 STORE、文本走 DEFLATE"，并确认 JSZip 真按逐文件设置写进了包里。
 */
describe('compressionFor 按后缀选压缩方式', () => {
  it('图片 / PDF / 压缩包 / 视频 / Office 文档直接存', () => {
    for (const p of ['images/a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.pdf', 'g.zip', 'h.mp4', 'i.docx']) {
      expect(compressionFor(p), p).toBe('STORE');
    }
  });

  it('文本类和不认识的后缀仍压缩', () => {
    for (const p of ['doc.md', 'a.txt', 'b.svg', 'c.csv', 'd.html', 'weird.xyz', 'noext']) {
      expect(compressionFor(p), p).toBe('DEFLATE');
    }
  });
});

describe('createZipDataUrl', () => {
  it('包里图片条目是 STORE，md 条目是 DEFLATE', async () => {
    const url = await createZipDataUrl([
      { path: 'doc.md', content: '# 标题\n'.repeat(100) },
      { path: 'images/a.png', content: new Uint8Array(2048).fill(7) },
    ]);
    expect(url.startsWith('data:application/zip;base64,')).toBe(true);

    const base64 = url.slice('data:application/zip;base64,'.length);
    // 不依赖 JSZip 内部字段：直接读 zip 本地文件头，第 8-9 字节是压缩方式（0 = STORE，8 = DEFLATE）
    expect(localHeaderMethods(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)))).toEqual({
      'doc.md': 8,
      'images/a.png': 0,
    });
    const zip = await JSZip.loadAsync(base64, { base64: true });
    expect(await zip.files['doc.md'].async('string')).toBe('# 标题\n'.repeat(100));
  });
});

/** 扫描 zip 里每个本地文件头（签名 50 4B 03 04），取出 文件名 → 压缩方式；目录条目（名字以 / 结尾）跳过 */
function localHeaderMethods(bytes: Uint8Array): Record<string, number> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Record<string, number> = {};
  let i = 0;
  while (i + 30 <= bytes.length) {
    if (view.getUint32(i, true) !== 0x04034b50) {
      i++;
      continue;
    }
    const method = view.getUint16(i + 8, true);
    const nameLen = view.getUint16(i + 26, true);
    const extraLen = view.getUint16(i + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(i + 30, i + 30 + nameLen));
    if (!name.endsWith('/')) out[name] = method;
    i += 30 + nameLen + extraLen;
  }
  return out;
}

describe('megabytesOf', () => {
  it('二进制按字节数、字符串按两字节估算，一位小数', () => {
    expect(megabytesOf([{ path: 'a.png', content: new Uint8Array(1048576) }])).toBe('1.0');
    expect(megabytesOf([{ path: 'a.md', content: 'x'.repeat(524288) }])).toBe('1.0');
    expect(megabytesOf([])).toBe('0.0');
  });
});
