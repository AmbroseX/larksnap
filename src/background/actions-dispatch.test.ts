import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionId, DispatchContext, DocInfo } from '../shared/types';
import { STORAGE_KEYS } from '../shared/constants';

// 底层实现全部 mock：本测试只锁分发层的两条硬约束——
// ① actionId 路由正确且 ActionId 全覆盖；② tabId/url 显式透传，绝不查活动标签页。
vi.mock('../shared/i18n', () => ({ t: (k: string) => k }));
vi.mock('./analytics', () => ({ track: vi.fn() }));
// 角标包装透传执行：badge 本体属 Chrome 真实行为，真机手测
vi.mock('./badge', () => ({
  runTracked: vi.fn((_id: unknown, _ctx: unknown, run: () => Promise<unknown>) => run()),
}));
vi.mock('./doc-detect', () => ({ detectDocForTab: vi.fn() }));
vi.mock('./feishu-proxy', () => {
  let cur: number | null = null;
  return {
    getContentTab: vi.fn(() => cur),
    setContentTab: vi.fn((v: number | null) => {
      cur = v;
    }),
  };
});
vi.mock('./exporters/markdown', () => ({ exportMarkdown: vi.fn(async () => ({ success: true })) }));
vi.mock('./exporters/sheet', () => ({ exportSheet: vi.fn(async () => ({ success: true })) }));
vi.mock('./exporters/pdf', () => ({ exportPdf: vi.fn(async () => ({ success: true })) }));
vi.mock('./exporters/html', () => ({ exportHtml: vi.fn(async () => ({ success: true })) }));
vi.mock('./exporters/screenshot', () => ({
  exportScreenshot: vi.fn(async () => ({ success: true })),
}));
vi.mock('./summarize', () => ({ summarizePage: vi.fn(async () => ({ success: true })) }));
vi.mock('./webcopy', () => ({
  webcopyPageMd: vi.fn(async () => ({ success: true })),
  webcopyPageMdInPage: vi.fn(async () => ({ success: true })),
  webcopySelectionMd: vi.fn(async () => ({ success: true })),
  webcopySelectionMdInPage: vi.fn(async () => ({ success: true })),
  webcopyUnlockInPage: vi.fn(async () => ({ success: true })),
}));

import { dispatchAction, resolveAction, withContentTab } from './actions-dispatch';
import { detectDocForTab } from './doc-detect';
import { getContentTab, setContentTab } from './feishu-proxy';
import { exportMarkdown } from './exporters/markdown';
import { exportPdf } from './exporters/pdf';
import { exportScreenshot } from './exporters/screenshot';
import { summarizePage } from './summarize';
import { webcopyPageMd, webcopyPageMdInPage } from './webcopy';

const ALL_ACTIONS: ActionId[] = [
  'page-md',
  'selection-md',
  'screenshot',
  'summarize',
  'unlock',
  'open-panel',
  'feishu-md',
  'feishu-pdf',
  'feishu-html',
];

const CTX_PANEL: DispatchContext = { tabId: 42, url: 'https://example.com/a', source: 'panel' };
const CTX_MENU: DispatchContext = { tabId: 42, url: 'https://example.com/a', source: 'menu' };

function fakeDoc(docType: DocInfo['docType'] = 'docx'): DocInfo {
  return {
    isFeishuDoc: true,
    docType,
    token: 'AbCdEfGhIjKlMnOpQrStUv12',
    title: '测试文档',
    url: 'https://xxx.feishu.cn/docx/AbCdEfGhIjKlMnOpQrStUv12',
    host: 'xxx.feishu.cn',
    isPrivateDeploy: false,
  };
}

/** 活动页查询哨兵：分发层之下任何实现调用它即为违规 */
const tabsQuery = vi.fn(async () => {
  throw new Error('分发层之下禁止 chrome.tabs.query({active:true})');
});
const sessionSet = vi.fn(async (_items: Record<string, unknown>) => {});
const sidePanelOpen = vi.fn(async () => {});

beforeEach(() => {
  vi.clearAllMocks();
  setContentTab(null);
  (globalThis as Record<string, unknown>).chrome = {
    tabs: { query: tabsQuery },
    storage: { session: { set: sessionSet } },
    sidePanel: { open: sidePanelOpen },
  };
});

describe('resolveAction 路由表', () => {
  it('ActionId 全覆盖，每个动作都有处理器与反馈策略', () => {
    for (const id of ALL_ACTIONS) {
      const route = resolveAction(id);
      expect(route, `缺少动作 ${id} 的路由`).toBeTruthy();
      expect(typeof route.run).toBe('function');
      expect(['badge', 'none']).toContain(route.feedback);
    }
  });

  it('导出类动作走 badge 反馈，面板承载类动作走 none', () => {
    expect(resolveAction('screenshot').feedback).toBe('badge');
    expect(resolveAction('feishu-md').feedback).toBe('badge');
    expect(resolveAction('summarize').feedback).toBe('none');
    expect(resolveAction('open-panel').feedback).toBe('none');
  });
});

describe('tabId 显式透传（评审阻断项 1）', () => {
  it('screenshot：tabId 原样传给导出器，右键/快捷键固定 png', async () => {
    await dispatchAction('screenshot', CTX_MENU);
    expect(exportScreenshot).toHaveBeenCalledWith('png', 42);
    expect(tabsQuery).not.toHaveBeenCalled();
  });

  it('screenshot：侧边栏入口可指定 pdf', async () => {
    await dispatchAction('screenshot', CTX_PANEL, { format: 'pdf' });
    expect(exportScreenshot).toHaveBeenCalledWith('pdf', 42);
  });

  it('summarize（panel）：目标页参数原样传入', async () => {
    await dispatchAction('summarize', CTX_PANEL);
    expect(summarizePage).toHaveBeenCalledWith({ tabId: 42, url: CTX_PANEL.url });
    expect(tabsQuery).not.toHaveBeenCalled();
  });

  it('feishu-md：按 ctx.tabId 识别文档，全程不查活动页', async () => {
    vi.mocked(detectDocForTab).mockResolvedValue(fakeDoc());
    const res = await dispatchAction('feishu-md', CTX_PANEL);
    expect(res.success).toBe(true);
    expect(detectDocForTab).toHaveBeenCalledWith(42);
    expect(exportMarkdown).toHaveBeenCalled();
    expect(tabsQuery).not.toHaveBeenCalled();
  });
});

describe('按触发来源路由', () => {
  it('page-md：panel 走结果回传版，menu 走页内剪贴板版', async () => {
    await dispatchAction('page-md', CTX_PANEL);
    expect(webcopyPageMd).toHaveBeenCalledWith(42, CTX_PANEL.url);
    expect(webcopyPageMdInPage).not.toHaveBeenCalled();

    vi.clearAllMocks();
    await dispatchAction('page-md', CTX_MENU);
    expect(webcopyPageMdInPage).toHaveBeenCalledWith(42, CTX_MENU.url);
    expect(webcopyPageMd).not.toHaveBeenCalled();
  });

  it('summarize（menu）：只写导航意图并开侧边栏，不后台执行总结（评审阻断项 2）', async () => {
    await dispatchAction('summarize', CTX_MENU);
    expect(summarizePage).not.toHaveBeenCalled();
    expect(sessionSet).toHaveBeenCalledTimes(1);
    const written = sessionSet.mock.calls[0][0];
    expect(written[STORAGE_KEYS.INTENT]).toMatchObject({
      target: 'summary',
      autoStart: true,
      tabId: 42,
      url: CTX_MENU.url,
    });
    expect(sidePanelOpen).toHaveBeenCalledWith({ tabId: 42 });
  });
});

describe('飞书导出的就绪校验与目标锁定', () => {
  it('非飞书页：直接返回错误，不触发导出', async () => {
    vi.mocked(detectDocForTab).mockResolvedValue(null);
    const res = await dispatchAction('feishu-md', CTX_PANEL);
    expect(res.success).toBe(false);
    expect(exportMarkdown).not.toHaveBeenCalled();
  });

  it('电子表格：PDF 导出被挡，Markdown 走 sheet 通道', async () => {
    vi.mocked(detectDocForTab).mockResolvedValue(fakeDoc('sheets'));
    const res = await dispatchAction('feishu-pdf', CTX_PANEL);
    expect(res.success).toBe(false);
    expect(exportPdf).not.toHaveBeenCalled();
  });

  it('导出期间取数锁到目标 tab，结束恢复先前值（不覆盖桥接设置）', async () => {
    setContentTab(7); // 模拟桥接任务已占用
    vi.mocked(detectDocForTab).mockResolvedValue(fakeDoc());
    await dispatchAction('feishu-md', CTX_PANEL);
    const calls = vi.mocked(setContentTab).mock.calls.map((c) => c[0]);
    expect(calls).toContain(42); // 导出期间锁到目标 tab
    expect(getContentTab()).toBe(7); // 结束恢复桥接的值
  });

  it('withContentTab：run 抛错也恢复先前值', async () => {
    setContentTab(null);
    await expect(
      withContentTab(42, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(getContentTab()).toBeNull();
  });
});
