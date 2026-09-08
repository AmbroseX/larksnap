import { describe, it, expect } from 'vitest';
import { sheetKindOf } from './feishu-api';

/**
 * wiki 节点类型判定（2026-09-07 实测数据见
 * docs/plans/2026-09-07-wiki表格节点导出修复.md）。
 *
 * 这里守住两件事：认得出表格，以及**认不出的一律返回 null**——
 * 返回 null 时调用方保持原样走 docx 管线，误判会把本来正常的文档带沟里。
 */
describe('sheetKindOf', () => {
  it('obj_type 3 是电子表格（讯飞私有化租户实测）', () => {
    expect(sheetKindOf(3, 'shtrzuUc5MtWN9bjdmnze0lE02b')).toBe('sheets');
  });

  it('obj_type 8 是多维表格', () => {
    expect(sheetKindOf(8, 'bascnAbCdEf123456')).toBe('base');
  });

  it('只有 token 前缀也能认出来（obj_type 缺失时的兜底）', () => {
    expect(sheetKindOf(undefined, 'shtabc123')).toBe('sheets');
    expect(sheetKindOf(undefined, 'bascnabc123')).toBe('base');
  });

  it('只有 obj_type 也能认出来（token 前缀不认识时的兜底）', () => {
    expect(sheetKindOf(3, 'unknownprefix123')).toBe('sheets');
    expect(sheetKindOf(8, 'unknownprefix123')).toBe('base');
  });

  it('新版文档不算表格', () => {
    expect(sheetKindOf(22, 'doxcnAbCdEf123456')).toBeNull();
  });

  it('旧版文档不算表格', () => {
    expect(sheetKindOf(2, 'doccnAbCdEf123456')).toBeNull();
  });

  it('什么都没有时返回 null，不瞎猜', () => {
    expect(sheetKindOf(undefined, undefined)).toBeNull();
    expect(sheetKindOf(undefined, '')).toBeNull();
  });

  it('没见过的类型返回 null，让调用方保持原样', () => {
    expect(sheetKindOf(11, 'bmncnAbCdEf123456')).toBeNull();
  });
});
