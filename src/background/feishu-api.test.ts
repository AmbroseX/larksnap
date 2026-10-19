import { describe, it, expect, vi, beforeEach } from 'vitest';

// 代理层整个替换掉：fetchClientVars 的翻页请求全部由测试按 cursor 回包
vi.mock('./feishu-proxy', () => ({
  feishuGet: vi.fn(),
  feishuPost: vi.fn(),
  fetchSubtrees: vi.fn(async () => ({ pages: [], requests: 0, truncated: false })),
}));

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

// ==================== fetchClientVars 翻页 ====================

import { fetchClientVars, PAGING_LIMIT } from './feishu-api';
import { feishuGet, fetchSubtrees } from './feishu-proxy';

const mockedGet = vi.mocked(feishuGet);
const mockedSubtrees = vi.mocked(fetchSubtrees);

/** 从请求路径里取 cursor 参数（没有就是首屏） */
function cursorOf(path: string): string {
  return new URLSearchParams(path.split('?')[1] ?? '').get('cursor') ?? '';
}

/** 造一页：root 是 page 块，children 指向本页正文块 */
function page(ids: string[], opts: { hasMore: boolean; cursor?: string }) {
  const block_map: Record<string, unknown> = {
    root: { type: 'page', children: ids },
  };
  for (const id of ids) block_map[id] = { type: 'text', data: { text: id } };
  return {
    code: 0,
    data: {
      block_map,
      block_sequence: ids,
      has_more: opts.hasMore,
      cursor: opts.cursor ?? '',
    },
  };
}

const DOC = { objToken: 'doxcnTest' };

/**
 * issue #13：翻页上限曾是 50 页，超长文档静默截断。这里守住三件事：
 * 正常翻到 has_more=false 能把块全合并进来；撞上限要标 pagingTruncated；
 * 服务端提前不给新块要标 pagingStopped（和"上限"分开，文案不能说错）。
 */
describe('fetchClientVars 翻页', () => {
  beforeEach(() => {
    mockedGet.mockReset();
    mockedSubtrees.mockClear();
  });

  it('翻到 has_more=false 为止，所有页的块和顺序都合并进来，没有 warnings', async () => {
    const pages: Record<string, unknown> = {
      '': page(['a1', 'a2'], { hasMore: true, cursor: 'c1' }),
      c1: page(['b1', 'b2'], { hasMore: true, cursor: 'c2' }),
      c2: page(['c1x'], { hasMore: false }),
    };
    mockedGet.mockImplementation(async (path: string) => pages[cursorOf(path)]);

    const res = await fetchClientVars(DOC);
    const data = res.data as { block_map: Record<string, unknown>; block_sequence: string[] };

    expect(Object.keys(data.block_map).sort()).toEqual(['a1', 'a2', 'b1', 'b2', 'c1x', 'root']);
    expect(data.block_sequence).toEqual(['a1', 'a2', 'b1', 'b2', 'c1x']);
    // 根块 children 是各页的并集，不是最后一页覆盖
    expect((data.block_map.root as { children: string[] }).children).toEqual([
      'a1', 'a2', 'b1', 'b2', 'c1x',
    ]);
    expect(res.warnings).toBeUndefined();
    expect(mockedGet).toHaveBeenCalledTimes(3);
  });

  it(`每页都有新块且 has_more 一直为 true：在 ${PAGING_LIMIT} 页停下并标 pagingTruncated`, async () => {
    mockedGet.mockImplementation(async (path: string) => {
      const c = cursorOf(path);
      const n = c ? Number(c.slice(1)) : 0;
      return page([`blk${n}`], { hasMore: true, cursor: `c${n + 1}` });
    });

    const res = await fetchClientVars(DOC);
    const data = res.data as { block_map: Record<string, unknown> };

    // 首屏 + PAGING_LIMIT 页续页，每页一个正文块
    expect(Object.keys(data.block_map).length).toBe(PAGING_LIMIT + 2);
    expect(mockedGet).toHaveBeenCalledTimes(PAGING_LIMIT + 1);
    expect(res.warnings).toEqual({ pagingTruncated: true });
  });

  it('续页只返回旧块：试完所有参数组合就停，标 pagingStopped 而不是上限', async () => {
    mockedGet.mockImplementation(async (path: string) =>
      cursorOf(path)
        ? page(['a1'], { hasMore: true, cursor: 'c1' }) // 原地踏步
        : page(['a1'], { hasMore: true, cursor: 'c1' })
    );

    const res = await fetchClientVars(DOC);
    const data = res.data as { block_map: Record<string, unknown> };

    expect(Object.keys(data.block_map).sort()).toEqual(['a1', 'root']);
    // 首屏只有 cursor 没有 next_cursors：续页会把 m1 / prid / bid 三种组合都试一遍再放弃
    expect(mockedGet).toHaveBeenCalledTimes(1 + 3);
    expect(res.warnings).toEqual({ pagingStopped: true });
  });

  it('补拉子树撞到上限：标 subtreeTruncated', async () => {
    mockedGet.mockImplementation(async () => {
      const p = page(['a1'], { hasMore: false });
      (p.data as Record<string, unknown>).skip_blocks = ['tbl1'];
      return p;
    });
    mockedSubtrees.mockResolvedValueOnce({ pages: [], requests: 51, truncated: true });

    const res = await fetchClientVars(DOC);
    expect(res.warnings).toEqual({ subtreeTruncated: true });
  });
});
