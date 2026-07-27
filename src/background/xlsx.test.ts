import { describe, expect, it } from 'vitest';
import { colLetter, normalizeSheetNames } from './xlsx';

// 只测纯函数：createXlsxDataUrl 依赖 JSZip 产二进制，属打包行为，真机用 Excel/WPS 打开手测。

describe('colLetter 列号转字母', () => {
  it('单字母段 0→A、25→Z', () => {
    expect(colLetter(0)).toBe('A');
    expect(colLetter(25)).toBe('Z');
  });

  it('进位到双字母 26→AA、27→AB、51→AZ、701→ZZ', () => {
    expect(colLetter(26)).toBe('AA');
    expect(colLetter(27)).toBe('AB');
    expect(colLetter(51)).toBe('AZ');
    expect(colLetter(701)).toBe('ZZ');
  });
});

describe('normalizeSheetNames 工作表名规整', () => {
  it('剔除 Excel 禁用字符 []:*?/\\，空名兜底为 SheetN', () => {
    const out = normalizeSheetNames([
      { name: 'a[b]:c*d?e/f\\g', rows: [] },
      { name: '   ', rows: [] },
    ]);
    expect(out[0].name).toBe('a b  c d e f g');
    expect(out[1].name).toBe('Sheet2');
  });

  it('超过 31 字符截断', () => {
    const out = normalizeSheetNames([{ name: 'x'.repeat(40), rows: [] }]);
    expect(out[0].name.length).toBe(31);
  });

  it('同名去重（大小写不敏感），加序号且不超长', () => {
    const out = normalizeSheetNames([
      { name: '表', rows: [] },
      { name: '表', rows: [] },
      { name: '表', rows: [] },
    ]);
    expect(out.map((s) => s.name)).toEqual(['表', '表(2)', '表(3)']);
  });

  it('不改入参，只在返回值里替换 name', () => {
    const input = [{ name: 'a[b]', rows: [['x']] }];
    const out = normalizeSheetNames(input);
    expect(input[0].name).toBe('a[b]');
    expect(out[0].rows).toBe(input[0].rows); // rows 原样透传
  });
});
