import { describe, expect, it } from 'vitest';
import { adler32 } from './feishu-clip';

/**
 * 剪存分块校验和锁值测试。
 * 期望值由 Python zlib.adler32（RFC 1950 标准实现）生成，
 * 与飞书上传服务端及目标扩展 WASM 的算法一致（无符号 32 位大端读出）。
 */
describe('adler32（剪存 x-block-list-checksum）', () => {
  it('标准向量与 zlib.adler32 一致', () => {
    expect(adler32(new Uint8Array())).toBe(0x00000001);
    expect(adler32(new TextEncoder().encode('a'))).toBe(0x00620062);
    expect(adler32(new TextEncoder().encode('hello world'))).toBe(0x1a0b045d);
    expect(adler32(new TextEncoder().encode('Wikipedia'))).toBe(0x11e60398);
    expect(
      adler32(new TextEncoder().encode('The quick brown fox jumps over the lazy dog'))
    ).toBe(0x5bdc0fda);
  });

  it('0..255 全字节值覆盖（无符号读出，不因 >2^31 变负）', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const v = adler32(bytes);
    expect(v).toBe(0xadf67f81);
    expect(v >>> 0).toBe(v); // 无符号
  });

  it('大块数据（超过 mod 65521 多轮取模）稳定', () => {
    const big = new Uint8Array(200_000).fill(0xab);
    const v = adler32(big);
    expect(v).toBeGreaterThan(0);
    expect(adler32(big)).toBe(v); // 幂等
  });
});
