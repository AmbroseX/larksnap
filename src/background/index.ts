import type { DispatchContext, Message, Response, TrackEvent } from '../shared/types';
import { MSG, OFFSCREEN_MSG } from '../shared/constants';
import { ensureI18n, t } from '../shared/i18n';
import { getRuntimeState } from '../shared/storage';
import { detectActiveDoc, detectDocForTab, getActiveTab } from './doc-detect';
import { getSnapshot } from './feishu-proxy';
import { reportProgress } from './progress';
import { exportAttachments } from './exporters/attachments';
import { exportXhs } from './exporters/xhs';
import { exportWechat } from './exporters/wechat';
import type { XhsRenderProgress } from './xhs/types';
import type { ScreenshotFormat, ShotStitchProgress } from '../shared/types';
import { cacheDoc, listCache, removeCache, getCache } from './cache-manager';
import { exportDiagnostic } from './diagnostic';
import { getCookie } from './cookie';
import { hasPermissionForHost, recordTrusted, revokePermission, listTrusted } from './permissions';
import { startBridge, getBridgeStatus } from './bridge';
import {
  getVideoState,
  probeVideo,
  downloadVideo,
  listVideoTasks,
  clearVideoTasks,
  revealVideoTask,
} from './video';
import { track, initAnalytics } from './analytics';
import { exportTranscript, listCaptionTracks } from './exporters/transcript';
import { classifyPage } from '../shared/page-kind';
import type { SummaryResult } from '../shared/types';
import {
  webcopyToggleUnlock,
  webcopyEnsure,
  webcopyGetState,
  copyTabs,
} from './webcopy';
import type { ActionId, TabCopyFormat } from '../shared/types';
// 统一动作分发层（006）：入口捕获 tabId 后全链路显式传递
import {
  dispatchAction,
  requireReady,
  blockSheetOnly,
  trackedExport,
  withContentTab,
} from './actions-dispatch';
import { setupContextMenus } from './context-menus';
import { setupBadge, clearBadge, listTaskRecords } from './badge';
// AI 对话页（007）：prepare + 流式 Port + 会话存取
import {
  prepareSummarize,
  setupChatPort,
  listChatSessions,
  getChatSession,
} from './summarize/chat-port';

console.log('[larksnap] Service Worker 启动');

// i18n：尽早开始初始化（幂等单例）；所有产生用户文案的入口各自 await ensureI18n()
void ensureI18n();

// CC ⇄ 扩展 桥接：连原生宿主、长连保活、接收远程导出任务
startBridge();

// 右键菜单：全部入口收敛在 LarkSnap 父菜单下（006 阶段1b）
setupContextMenus();

// 角标反馈：切到该 tab 即清角标（006 阶段1b）
setupBadge();

// AI 对话流式长连接（007）：侧边栏 connect 后经 Port 收 delta/done/error
setupChatPort();

// 匿名统计：安装/更新事件（可在设置页关闭）
initAnalytics();

// 点击工具栏图标直开侧边栏（006 阶段1c）：popup 已删除，桥接状态迁入侧边栏 header。
// openPanelOnActionClick 是浏览器持久化的设置，升级安装的老用户此前被设为 false，必须显式设回 true。
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

// ==================== 键盘快捷键（006 阶段1b） ====================
// command 名 → 动作 id；触发瞬间用事件携带的 tab，异常时才退化查一次活动页（入口层唯一允许点）
const COMMAND_ACTION: Record<string, ActionId> = {
  'open-panel': 'open-panel',
  'page-md': 'page-md',
  screenshot: 'screenshot',
  summarize: 'summarize',
};
chrome.commands?.onCommand.addListener((command, tab) => {
  const action = COMMAND_ACTION[command];
  if (!action) return;
  const run = (target: chrome.tabs.Tab | undefined) => {
    if (!target?.id) return;
    const tabId = target.id;
    // sidePanel.open 必须留在手势的同步调用栈内（await 之后调用会被浏览器拒绝）
    if (action === 'open-panel' || action === 'summarize') {
      chrome.sidePanel.open({ tabId }).catch(() => {});
      if (action === 'open-panel') return;
    }
    // 受限页不预先拦截：让动作自然失败并落角标+任务记录（可感知，不静默）
    void ensureI18n().then(() =>
      dispatchAction(action, { tabId, url: target.url || '', source: 'command' })
    );
  };
  if (tab?.id != null) run(tab);
  else void chrome.tabs.query({ active: true, currentWindow: true }).then(([t2]) => run(t2));
});

// ==================== 消息路由 ====================
chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error: unknown) => {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies Response);
    });
  return true; // 异步响应
});

async function handleMessage(
  message: Message,
  sender: chrome.runtime.MessageSender
): Promise<Response> {
  // 所有响应文案（错误/进度）都可能面向用户，先保证语言就绪
  await ensureI18n();
  switch (message.type) {
    case MSG.GET_STATUS: {
      const state = await getRuntimeState();
      // 侧边栏打开即视为「用户已看到结果」：清当前 tab 的角标（006，US5）
      const tab = await getActiveTab();
      if (tab?.id) void clearBadge(tab.id);
      return { success: true, data: state };
    }

    case MSG.LIST_TASK_RECORDS: {
      const tab = await getActiveTab();
      if (!tab?.id) return { success: true, data: [] };
      return { success: true, data: await listTaskRecords(tab.id) };
    }

    case MSG.GET_BRIDGE_STATUS: {
      return { success: true, data: await getBridgeStatus() };
    }

    case MSG.GET_DOC_INFO: {
      const doc = await detectActiveDoc();
      return { success: true, data: doc };
    }

    // ---------- 认证：content 读 HttpOnly CSRF cookie ----------
    case MSG.GET_COOKIE: {
      const { name } = (message.data || {}) as { name?: string };
      const url = sender.tab?.url || '';
      if (!name) return { success: false, error: t('bg.missingCookieName') };
      const value = await getCookie(name, url);
      return { success: true, data: value };
    }

    // ---------- 私有化域名权限 ----------
    case MSG.CHECK_PERMISSION: {
      const { host } = (message.data || {}) as { host?: string };
      return { success: true, data: await hasPermissionForHost(host || '') };
    }
    case MSG.REQUEST_PERMISSION: {
      // UI 已在用户手势中完成 chrome.permissions.request；此处只持久化授权 pattern。
      // 右键菜单的飞书组可见性按当前页识别动态维护，与授权列表无关。
      const { pattern } = (message.data || {}) as { pattern?: string };
      if (pattern) await recordTrusted(pattern);
      return { success: true };
    }
    case MSG.REVOKE_PERMISSION: {
      const { pattern } = (message.data || {}) as { pattern?: string };
      if (!pattern) return { success: false, error: t('bg.missingPermissionPattern') };
      const removed = await revokePermission(pattern);
      return { success: true, data: removed };
    }
    case MSG.LIST_TRUSTED: {
      return { success: true, data: await listTrusted() };
    }

    // ---------- 导出动作 ----------
    case MSG.EXPORT_MARKDOWN: {
      const ctx = await capturePanelCtx();
      if (!ctx) return noActiveTab();
      return dispatchAction('feishu-md', ctx);
    }

    case MSG.EXPORT_WORD: {
      await reportProgress('word', 'error', t('progress.word.wip'));
      return { success: false, error: t('progress.word.wip') };
    }

    case MSG.EXPORT_PDF: {
      const ctx = await capturePanelCtx();
      if (!ctx) return noActiveTab();
      return dispatchAction('feishu-pdf', ctx);
    }

    case MSG.EXPORT_HTML: {
      const ctx = await capturePanelCtx();
      if (!ctx) return noActiveTab();
      return dispatchAction('feishu-html', ctx);
    }

    case MSG.EXPORT_XHS: {
      const ctx = await capturePanelCtx();
      if (!ctx) return noActiveTab();
      const doc = await detectDocForTab(ctx.tabId);
      const err = requireReady(doc);
      const { themeId } = (message.data || {}) as { themeId?: string };
      return (
        err ??
        blockSheetOnly(doc!) ??
        withContentTab(ctx.tabId, () => trackedExport('xhs', () => exportXhs(doc!, themeId)))
      );
    }

    case MSG.EXPORT_WECHAT: {
      const ctx = await capturePanelCtx();
      if (!ctx) return noActiveTab();
      const doc = await detectDocForTab(ctx.tabId);
      const err = requireReady(doc);
      const { themeId } = (message.data || {}) as { themeId?: string };
      return (
        err ??
        blockSheetOnly(doc!) ??
        withContentTab(ctx.tabId, () => trackedExport('wechat', () => exportWechat(doc!, themeId)))
      );
    }

    // ---------- 整页截图（任意网页长图，与飞书通道解耦） ----------
    case MSG.EXPORT_SCREENSHOT: {
      const ctx = await capturePanelCtx();
      if (!ctx) return noActiveTab();
      const { format, maxSeconds, stepSeconds } = (message.data || {}) as {
        format?: ScreenshotFormat;
        maxSeconds?: number;
        stepSeconds?: number;
      };
      return dispatchAction('screenshot', ctx, {
        format,
        maxSeconds: typeof maxSeconds === 'number' ? maxSeconds : undefined,
        stepSeconds: typeof stepSeconds === 'number' ? stepSeconds : undefined,
      });
    }

    // offscreen 页逐屏拼接进度，转成统一进度推给侧边栏
    case OFFSCREEN_MSG.SHOT_PROGRESS: {
      const { done, total } = (message.data ?? {}) as ShotStitchProgress;
      if (done && total) {
        await reportProgress(
          'screenshot',
          'running',
          t('progress.screenshot.stitchingProgress', { done, total }),
          90 + Math.round((done / total) * 8)
        );
      }
      return { success: true };
    }

    // offscreen 页逐张卡片的渲染进度，转成统一进度推给侧边栏
    case OFFSCREEN_MSG.XHS_PROGRESS: {
      const { done, total } = (message.data ?? {}) as XhsRenderProgress;
      if (done && total) {
        await reportProgress(
          'xhs',
          'running',
          t('progress.xhs.renderingProgress', { done, total }),
          45 + Math.round((done / total) * 50)
        );
      }
      return { success: true };
    }

    case MSG.EXPORT_ATTACHMENTS: {
      const ctx = await capturePanelCtx();
      if (!ctx) return noActiveTab();
      const doc = await detectDocForTab(ctx.tabId);
      const err = requireReady(doc);
      return (
        err ??
        blockSheetOnly(doc!) ??
        withContentTab(ctx.tabId, () =>
          trackedExport('attachments', () => exportAttachments(doc!))
        )
      );
    }

    case MSG.CACHE_DOC: {
      const ctx = await capturePanelCtx();
      if (!ctx) return noActiveTab();
      const doc = await detectDocForTab(ctx.tabId);
      const err = requireReady(doc);
      if (err) return err;
      return withContentTab(ctx.tabId, async () => {
        const snapshot = await getSnapshot().catch(() => null);
        return cacheDoc(doc!, snapshot);
      });
    }

    case MSG.CACHE_LIST: {
      return listCache();
    }

    case MSG.CACHE_GET: {
      const { token } = (message.data || {}) as { token?: string };
      if (!token) return { success: false, error: t('bg.missingToken') };
      return getCache(token);
    }

    case MSG.CACHE_DELETE: {
      const { token } = (message.data || {}) as { token?: string };
      if (!token) return { success: false, error: t('bg.missingToken') };
      return removeCache(token);
    }

    case MSG.EXPORT_DIAGNOSTIC: {
      const doc = await detectActiveDoc();
      return exportDiagnostic(doc);
    }

    // ---------- 视频下载（daemon 跑 yt-dlp） ----------
    case MSG.GET_VIDEO_STATE: {
      return getVideoState();
    }
    case MSG.PROBE_VIDEO: {
      return probeVideo();
    }
    case MSG.DOWNLOAD_VIDEO: {
      const { quality, route } = (message.data || {}) as {
        quality?: string;
        route?: 'auto' | 'direct' | 'proxy';
      };
      return downloadVideo(quality, route);
    }
    case MSG.LIST_VIDEO_TASKS: {
      return { success: true, data: listVideoTasks() };
    }
    case MSG.CLEAR_VIDEO_TASKS: {
      return clearVideoTasks();
    }
    case MSG.REVEAL_VIDEO_FILE: {
      const { taskId } = (message.data || {}) as { taskId?: string };
      return revealVideoTask(taskId);
    }

    // ---------- 网页复制（webcopy） ----------
    case MSG.WEBCOPY_PAGE_MD: {
      const ctx = await capturePanelCtx();
      if (!ctx) return noActiveTab();
      return dispatchAction('page-md', ctx);
    }
    case MSG.WEBCOPY_SELECTION_MD: {
      const ctx = await capturePanelCtx();
      if (!ctx) return noActiveTab();
      return dispatchAction('selection-md', ctx);
    }
    case MSG.WEBCOPY_TOGGLE_UNLOCK: {
      const ctx = await capturePanelCtx();
      if (!ctx) return noActiveTab();
      const { enabled } = (message.data || {}) as { enabled?: boolean };
      return webcopyToggleUnlock(ctx.tabId, ctx.url, !!enabled);
    }
    case MSG.WEBCOPY_ENSURE: {
      const ctx = await capturePanelCtx();
      if (!ctx) return noActiveTab();
      return webcopyEnsure(ctx.tabId, ctx.url);
    }
    case MSG.WEBCOPY_GET_STATE: {
      const tab = await getActiveTab();
      return webcopyGetState(tab?.id ?? null);
    }
    case MSG.COPY_TABS: {
      const { scope, format } = (message.data || {}) as {
        scope?: 'current' | 'all';
        format?: TabCopyFormat;
      };
      return copyTabs(scope ?? 'all', format ?? 'markdown');
    }

    // ---------- 页面分类（006：五分类，驱动侧边栏上下文区） ----------
    case MSG.GET_PAGE_KIND: {
      const tab = await getActiveTab();
      return { success: true, data: classifyPage(tab?.url, tab?.title) };
    }

    case MSG.LIST_CAPTION_TRACKS: {
      return listCaptionTracks();
    }

    case MSG.EXPORT_TRANSCRIPT: {
      const { lang, mode } = (message.data || {}) as {
        lang?: string;
        mode?: 'download' | 'copy';
      };
      return trackedExport('transcript', () =>
        exportTranscript(lang, mode === 'copy' ? 'copy' : 'download')
      );
    }

    case MSG.SUMMARIZE_PAGE: {
      // 导航意图触发时侧边栏带 tabId/url（锁定触发瞬间的页面）；直接点卡片则捕获当前页
      const { tabId, url } = (message.data || {}) as { tabId?: number; url?: string };
      const ctx: DispatchContext | null =
        tabId != null
          ? { tabId, url: url || '', source: 'panel' }
          : await capturePanelCtx();
      if (!ctx) return noActiveTab();
      // 统计只报枚举/数值 {kind, ok, chunks, secs}，绝不含内容/URL/端点（FR-006）
      const started = Date.now();
      const res = await dispatchAction('summarize', ctx);
      const data = res.data as (SummaryResult & { needsAck?: boolean }) | undefined;
      if (!data?.needsAck) {
        void track({
          name: 'summarize',
          url: '/summarize',
          data: {
            kind: data?.kind ?? 'page',
            ok: !!res.success,
            chunks: data?.chunks ?? 0,
            secs: Math.round((Date.now() - started) / 1000),
          },
        });
      }
      return res;
    }

    // ---------- AI 对话页（007） ----------
    case MSG.SUMMARIZE_PREPARE: {
      // 意图触发时侧边栏带 tabId/url 锁定目标页；直接点入口则捕获当前页
      const { tabId, url } = (message.data || {}) as { tabId?: number; url?: string };
      const ctx =
        tabId != null
          ? { tabId, url: url || '' }
          : await capturePanelCtx();
      if (!ctx) return noActiveTab();
      return prepareSummarize({ tabId: ctx.tabId, url: ctx.url });
    }

    case MSG.CHAT_LIST_SESSIONS:
      return listChatSessions();

    case MSG.CHAT_GET_SESSION: {
      const { id } = (message.data || {}) as { id?: string };
      if (!id) return { success: false, error: t('bg.chatSessionGone') };
      return getChatSession(id);
    }

    case MSG.GET_SELECTION: {
      // 读当前活动页的选中文字：只用 activeTab，没授权/受限页读不到就当没选中，
      // 绝不弹授权框（008 的零授权承诺；右键菜单 selectionText 是兜底通路）
      const tab = await getActiveTab();
      if (!tab?.id) return { success: true, data: { text: '' } };
      try {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => window.getSelection()?.toString() ?? '',
        });
        const text = String(res?.result ?? '').trim();
        // 超长选区截断：纯聊天通路不走 refine 切块，避免一次塞爆上下文
        return { success: true, data: { text: text.slice(0, 8000) } };
      } catch {
        return { success: true, data: { text: '' } };
      }
    }

    // ---------- 匿名统计（UI 页面转发，SW 统一收口） ----------
    case MSG.TRACK: {
      void track(message.data as TrackEvent);
      return { success: true };
    }

    default:
      return { success: false, error: t('bg.unknownMessage', { type: message.type }) };
  }
}

// requireReady / blockSheetOnly / trackedExport 已随分发层迁至 actions-dispatch.ts（006）

/** 侧边栏入口：处理消息的瞬间捕获目标标签页，此后全链路显式传递（006） */
async function capturePanelCtx(): Promise<DispatchContext | null> {
  const tab = await getActiveTab();
  if (!tab?.id) return null;
  return { tabId: tab.id, url: tab.url || '', source: 'panel' };
}

function noActiveTab(): Response {
  return { success: false, error: t('bg.noActiveTab') };
}
