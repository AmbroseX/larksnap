import type {
  ActionId,
  DispatchContext,
  DocInfo,
  NavigationIntent,
  Response,
  ScreenshotFormat,
  SelectionPrompt,
} from '../shared/types';
import { STORAGE_KEYS } from '../shared/constants';
import { t, type TranslationKey } from '../shared/i18n';
import { track } from './analytics';
import { runTracked } from './badge';
import { detectDocForTab } from './doc-detect';
import { getContentTab, setContentTab } from './feishu-proxy';
import { exportMarkdown } from './exporters/markdown';
import { exportSheet } from './exporters/sheet';
import { exportPdf } from './exporters/pdf';
import { exportHtml } from './exporters/html';
import { exportScreenshot } from './exporters/screenshot';
import { summarizePage } from './summarize';
import {
  toastInMainWorld,
  webcopyPageMd,
  webcopyPageMdDownloadInPage,
  webcopyPageMdInPage,
  webcopySelectionMd,
  webcopySelectionMdInPage,
  webcopyUnlockInPage,
} from './webcopy';

/**
 * 统一动作分发层（006）：右键菜单、键盘快捷键、侧边栏按钮三类入口
 * 都在触发瞬间捕获 tabId/url 后进到这里。
 *
 * 约定（评审阻断项 1，第一验收标准）：本文件之下的所有实现
 * 禁止调用 chrome.tabs.query({ active: true })，目标页只认 ctx 里的 tabId/url。
 */

/** 动作附加参数：截图格式（侧边栏按钮与右键「整页导出 PDF」传 pdf，其余入口缺省 png） */
export interface ActionPayload {
  format?: ScreenshotFormat;
  /** 截图总时长上限（秒，侧边栏输入；无限滚动页控制截多久）。缺省用内置兜底 */
  maxSeconds?: number;
  /** 每屏滚动后的最少停顿（秒，侧边栏输入；重动画/背景图页手动加大）。缺省纯自适应 */
  stepSeconds?: number;
  /** ask-ai-selection：右键时的选中文字（onClicked 动态注入） */
  selectionText?: string;
  /** ask-ai-selection：推荐指令 */
  selPrompt?: SelectionPrompt;
}

export interface ActionRoute {
  /** 后台入口（menu/command）结束后的反馈方式：badge=角标+任务记录；none=自身已有反馈 */
  feedback: 'badge' | 'none';
  run: (ctx: DispatchContext, payload?: ActionPayload) => Promise<Response>;
}

export async function dispatchAction(
  id: ActionId,
  ctx: DispatchContext,
  payload?: ActionPayload
): Promise<Response> {
  const route = resolveAction(id);
  // 后台入口（右键/快捷键）：包一层任务记录 + 角标反馈；侧边栏入口沿用状态栏反馈
  if (ctx.source !== 'panel' && route.feedback === 'badge') {
    const res = await runTracked(id, ctx, () => route.run(ctx, payload));
    // 失败原因页内 toast 直接可见（角标"!"太隐蔽，用户会以为动作没生效）。
    // 右键/快捷键自带 activeTab，注入基本必成；个别注入不了的页面静默放弃即可。
    if (!res.success && res.error) {
      void toastInMainWorld(ctx.tabId, res.error).catch(() => {});
    }
    return res;
  }
  return route.run(ctx, payload);
}

/** 路由表查询（纯函数，单测断言 ActionId 全覆盖与反馈策略） */
export function resolveAction(id: ActionId): ActionRoute {
  return ROUTES[id];
}

const ROUTES: Record<ActionId, ActionRoute> = {
  'page-md': {
    feedback: 'badge',
    // 侧边栏：结果回传由 UI 写剪贴板；右键/快捷键：手势在页面里，页面侧写剪贴板+toast
    run: (ctx) =>
      ctx.source === 'panel'
        ? webcopyPageMd(ctx.tabId, ctx.url)
        : webcopyPageMdInPage(ctx.tabId, ctx.url),
  },
  'page-md-download': {
    feedback: 'badge',
    // 右键入口的下载版（侧边栏有自己的下载按钮，不走这里）：产物由 SW 直接落盘
    run: (ctx) => webcopyPageMdDownloadInPage(ctx.tabId, ctx.url),
  },
  'selection-md': {
    feedback: 'badge',
    run: (ctx) =>
      ctx.source === 'panel'
        ? webcopySelectionMd(ctx.tabId, ctx.url)
        : webcopySelectionMdInPage(ctx.tabId, ctx.url),
  },
  screenshot: {
    feedback: 'badge',
    run: (ctx, payload) => {
      const fmt: ScreenshotFormat = payload?.format === 'pdf' ? 'pdf' : 'png';
      return trackedExport('screenshot', () =>
        exportScreenshot(fmt, ctx.tabId, {
          maxSeconds: payload?.maxSeconds,
          stepSeconds: payload?.stepSeconds,
        })
      );
    },
  },
  summarize: {
    // 总结结果由侧边栏承载：后台入口只发导航意图（评审阻断项 2），无需角标
    feedback: 'none',
    run: (ctx) =>
      ctx.source === 'panel'
        ? summarizePage({ tabId: ctx.tabId, url: ctx.url })
        : sendSummarizeIntent(ctx),
  },
  'ask-ai-selection': {
    // 结果由侧边栏对话页承载：只写导航意图 + 开面板，纯聊天通路零授权
    feedback: 'none',
    run: (ctx, payload) => sendChatSelectionIntent(ctx, payload),
  },
  unlock: {
    // 页内 toast 已是反馈；侧边栏的显式开关（带 enabled 参数）走原消息通道
    feedback: 'none',
    run: (ctx) => webcopyUnlockInPage(ctx.tabId, ctx.url),
  },
  'open-panel': {
    feedback: 'none',
    run: async (ctx) => {
      await chrome.sidePanel.open({ tabId: ctx.tabId });
      return { success: true };
    },
  },
  'feishu-md': { feedback: 'badge', run: (ctx) => runFeishuExport(ctx, 'markdown') },
  'feishu-pdf': { feedback: 'badge', run: (ctx) => runFeishuExport(ctx, 'pdf') },
  'feishu-html': { feedback: 'badge', run: (ctx) => runFeishuExport(ctx, 'html') },
};

/**
 * 「AI 总结」后台入口：写一次性导航意图（storage.session，读到即删）再开侧边栏，
 * 意图经存储传递以消除侧边栏加载竞态；总结本体由 SummaryView 携带 tabId/url 发起。
 */
async function sendSummarizeIntent(ctx: DispatchContext): Promise<Response> {
  const intent: NavigationIntent = {
    target: 'summary',
    autoStart: true,
    tabId: ctx.tabId,
    url: ctx.url,
    createdAt: Date.now(),
  };
  await chrome.storage.session.set({ [STORAGE_KEYS.INTENT]: intent });
  await chrome.sidePanel.open({ tabId: ctx.tabId });
  return { success: true };
}

/**
 * 「问 AI 选中文字」后台入口（008）：同 sendSummarizeIntent 的意图接力方式，
 * 但目标是对话页的纯聊天通路——选中文字随意图带过去，全程不抓页面、零授权。
 */
async function sendChatSelectionIntent(
  ctx: DispatchContext,
  payload?: ActionPayload
): Promise<Response> {
  const text = (payload?.selectionText || '').trim();
  if (!text) return { success: false, error: t('bg.noSelection') };
  const intent: NavigationIntent = {
    target: 'chat-selection',
    autoStart: true,
    tabId: ctx.tabId,
    url: ctx.url,
    selectionText: text.slice(0, 8000),
    selPrompt: payload?.selPrompt ?? 'summarize',
    createdAt: Date.now(),
  };
  await chrome.storage.session.set({ [STORAGE_KEYS.INTENT]: intent });
  await chrome.sidePanel.open({ tabId: ctx.tabId });
  return { success: true };
}

/** 飞书导出：识别指定 tab → 就绪校验 → 导出期间把取数锁到该 tab */
async function runFeishuExport(
  ctx: DispatchContext,
  kind: 'markdown' | 'pdf' | 'html'
): Promise<Response> {
  const doc = await detectDocForTab(ctx.tabId);
  const err = requireReady(doc);
  if (err) return err;
  return withContentTab(ctx.tabId, () => {
    if (kind === 'markdown') {
      // 电子表格走专门的内存抽取导出（docx 那套 client_vars 对表格是空的）
      const isSheet = doc!.docType === 'sheets';
      return trackedExport(isSheet ? 'sheet' : 'markdown', () =>
        isSheet ? exportSheet(doc!) : exportMarkdown(doc!)
      );
    }
    const blocked = blockSheetOnly(doc!);
    if (blocked) return Promise.resolve(blocked);
    return kind === 'pdf'
      ? trackedExport('pdf', () => exportPdf(doc!))
      : trackedExport('html', () => exportHtml(doc!));
  });
}

/** 导出期间把飞书取数目标锁到指定 tab；结束恢复先前值（不清空，避免覆盖桥接任务的设置） */
export async function withContentTab<T>(tabId: number, run: () => Promise<T>): Promise<T> {
  const prev = getContentTab();
  setContentTab(tabId);
  try {
    return await run();
  } finally {
    setContentTab(prev);
  }
}

/**
 * 多维表格（base）走的又是另一套接口，现有任何管线都处理不了，全局挡掉。
 * 电子表格（sheets）已由 exportSheet 支持导出 Markdown/CSV，故不在此列——
 * 但 PDF/HTML/附件对表格仍不适用，由 blockSheetOnly 单独挡。
 */
const UNSUPPORTED_EXPORT_TYPES: Partial<Record<DocInfo['docType'], TranslationKey>> = {
  base: 'bg.docTypeBase',
};

/** 校验文档是否就绪（已识别 + 已授权 + 类型可导出），否则返回错误 Response */
export function requireReady(doc: DocInfo | null): Response | null {
  if (!doc || !doc.isFeishuDoc) {
    return { success: false, error: t('bg.notFeishuPage') };
  }
  if (doc.needsAuth) {
    return { success: false, error: t('bg.privateNeedsAuth') };
  }
  const unsupported = UNSUPPORTED_EXPORT_TYPES[doc.docType];
  if (unsupported) {
    return {
      success: false,
      error: t('bg.unsupportedDocType', { type: t(unsupported) }),
    };
  }
  return null;
}

/** 电子表格只支持 Markdown/CSV 导出；PDF/HTML/附件对表格不适用，单独挡 */
export function blockSheetOnly(doc: DocInfo): Response | null {
  if (doc.docType === 'sheets') {
    return {
      success: false,
      error: t('bg.sheetOnlyMarkdown'),
    };
  }
  return null;
}

/** 执行导出并上报结果（格式、成败、耗时秒），统计失败不影响导出 */
export async function trackedExport(
  format: string,
  run: () => Promise<Response>
): Promise<Response> {
  const started = Date.now();
  const res = await run();
  void track({
    name: 'export',
    url: `/export/${format}`,
    data: {
      format,
      ok: !!res.success,
      secs: Math.round((Date.now() - started) / 1000),
    },
  });
  return res;
}
