import type { DocInfo, Message, Response, TrackEvent } from '../shared/types';
import { MSG, OFFSCREEN_MSG } from '../shared/constants';
import { ensureI18n, t, type TranslationKey } from '../shared/i18n';
import { getRuntimeState } from '../shared/storage';
import { detectActiveDoc } from './doc-detect';
import { getSnapshot } from './feishu-proxy';
import { reportProgress } from './progress';
import { exportMarkdown } from './exporters/markdown';
import { exportSheet } from './exporters/sheet';
import { exportPdf } from './exporters/pdf';
import { exportHtml } from './exporters/html';
import { exportAttachments } from './exporters/attachments';
import { exportXhs } from './exporters/xhs';
import { exportWechat } from './exporters/wechat';
import { exportScreenshot } from './exporters/screenshot';
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
import {
  exportTranscript,
  listCaptionTracks,
  isYoutubeWatchUrl,
} from './exporters/transcript';
import { summarizePage } from './summarize';
import type { PageKind, SummaryResult } from '../shared/types';
import { detectDocFromUrl } from '../content/feishu-detect';
import { getActiveTab } from './doc-detect';
import {
  setupWebcopy,
  isRestrictedUrl,
  webcopyPageMd,
  webcopySelectionMd,
  webcopyToggleUnlock,
  webcopyEnsure,
  webcopyGetState,
  copyTabs,
} from './webcopy';
import type { TabCopyFormat } from '../shared/types';

console.log('[larksnap] Service Worker 启动');

// i18n：尽早开始初始化（幂等单例）；所有产生用户文案的入口各自 await ensureI18n()
void ensureI18n();

// CC ⇄ 扩展 桥接：连原生宿主、长连保活、接收远程导出任务
startBridge();

// webcopy：右键菜单注册与分发（与飞书导出平行，互不干扰）
setupWebcopy();

// 匿名统计：安装/更新事件（可在设置页关闭）
initAnalytics();

// 点击图标弹出状态 popup（manifest 的 default_popup），侧边栏从 popup 里的按钮打开。
// 注意：openPanelOnActionClick 是浏览器持久化的设置，旧版本设过 true，必须显式改回
// false，否则点图标仍然开侧边栏、popup 不会显示。
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => {});
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
      return { success: true, data: state };
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
      // UI 已在用户手势中完成 chrome.permissions.request；此处仅持久化授权 pattern
      const { pattern } = (message.data || {}) as { pattern?: string };
      if (pattern) await recordTrusted(pattern);
      return { success: true };
    }
    case MSG.REVOKE_PERMISSION: {
      const { pattern } = (message.data || {}) as { pattern?: string };
      if (!pattern) return { success: false, error: t('bg.missingPermissionPattern') };
      return { success: true, data: await revokePermission(pattern) };
    }
    case MSG.LIST_TRUSTED: {
      return { success: true, data: await listTrusted() };
    }

    // ---------- 导出动作 ----------
    case MSG.EXPORT_MARKDOWN: {
      const doc = await detectActiveDoc();
      const err = requireReady(doc);
      if (err) return err;
      // 电子表格走专门的内存抽取导出（docx 那套 client_vars 对表格是空的）
      const isSheet = doc!.docType === 'sheets';
      return trackedExport(isSheet ? 'sheet' : 'markdown', () =>
        isSheet ? exportSheet(doc!) : exportMarkdown(doc!)
      );
    }

    case MSG.EXPORT_WORD: {
      await reportProgress('word', 'error', t('progress.word.wip'));
      return { success: false, error: t('progress.word.wip') };
    }

    case MSG.EXPORT_PDF: {
      const doc = await detectActiveDoc();
      const err = requireReady(doc);
      return err ?? blockSheetOnly(doc!) ?? trackedExport('pdf', () => exportPdf(doc!));
    }

    case MSG.EXPORT_HTML: {
      const doc = await detectActiveDoc();
      const err = requireReady(doc);
      return err ?? blockSheetOnly(doc!) ?? trackedExport('html', () => exportHtml(doc!));
    }

    case MSG.EXPORT_XHS: {
      const doc = await detectActiveDoc();
      const err = requireReady(doc);
      const { themeId } = (message.data || {}) as { themeId?: string };
      return err ?? blockSheetOnly(doc!) ?? trackedExport('xhs', () => exportXhs(doc!, themeId));
    }

    case MSG.EXPORT_WECHAT: {
      const doc = await detectActiveDoc();
      const err = requireReady(doc);
      const { themeId } = (message.data || {}) as { themeId?: string };
      return (
        err ?? blockSheetOnly(doc!) ?? trackedExport('wechat', () => exportWechat(doc!, themeId))
      );
    }

    // ---------- 整页截图（任意网页长图，与飞书通道解耦） ----------
    case MSG.EXPORT_SCREENSHOT: {
      const { format } = (message.data || {}) as { format?: ScreenshotFormat };
      const fmt: ScreenshotFormat = format === 'pdf' ? 'pdf' : 'png';
      return trackedExport('screenshot', () => exportScreenshot(fmt));
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
      const doc = await detectActiveDoc();
      const err = requireReady(doc);
      return (
        err ??
        blockSheetOnly(doc!) ??
        trackedExport('attachments', () => exportAttachments(doc!))
      );
    }

    case MSG.CACHE_DOC: {
      const doc = await detectActiveDoc();
      const err = requireReady(doc);
      if (err) return err;
      const snapshot = await getSnapshot().catch(() => null);
      return cacheDoc(doc!, snapshot);
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
      return webcopyPageMd();
    }
    case MSG.WEBCOPY_SELECTION_MD: {
      return webcopySelectionMd();
    }
    case MSG.WEBCOPY_TOGGLE_UNLOCK: {
      const { enabled } = (message.data || {}) as { enabled?: boolean };
      return webcopyToggleUnlock(!!enabled);
    }
    case MSG.WEBCOPY_ENSURE: {
      return webcopyEnsure();
    }
    case MSG.WEBCOPY_GET_STATE: {
      return webcopyGetState();
    }
    case MSG.COPY_TABS: {
      const { scope, format } = (message.data || {}) as {
        scope?: 'current' | 'all';
        format?: TabCopyFormat;
      };
      return copyTabs(scope ?? 'all', format ?? 'markdown');
    }

    // ---------- YouTube 字幕 + AI 总结（004） ----------
    // 页面类型三态：feishu 走现有导出 / youtube 出字幕+总结入口 / generic 出总结入口
    case MSG.GET_PAGE_KIND: {
      const tab = await getActiveTab();
      const url = tab?.url || '';
      let kind: PageKind;
      if (!url || isRestrictedUrl(url)) kind = 'restricted';
      else if (detectDocFromUrl(url).isFeishuDoc) kind = 'feishu';
      else if (isYoutubeWatchUrl(url)) kind = 'youtube';
      else kind = 'generic';
      return { success: true, data: { kind, url } };
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
      // 统计只报枚举/数值 {kind, ok, chunks, secs}，绝不含内容/URL/端点（FR-006）
      const started = Date.now();
      const res = await summarizePage();
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

    // ---------- 匿名统计（UI 页面转发，SW 统一收口） ----------
    case MSG.TRACK: {
      void track(message.data as TrackEvent);
      return { success: true };
    }

    default:
      return { success: false, error: t('bg.unknownMessage', { type: message.type }) };
  }
}

/**
 * 多维表格（base）走的又是另一套接口，现有任何管线都处理不了，全局挡掉。
 * 电子表格（sheets）已由 exportSheet 支持导出 Markdown/CSV，故不在此列——
 * 但 PDF/HTML/附件对表格仍不适用，由各自 handler 单独挡（见 blockSheetOnly）。
 * 详见 docs/plans/2026-07-03-sheets导出适配研究.md
 */
const UNSUPPORTED_EXPORT_TYPES: Partial<Record<DocInfo['docType'], TranslationKey>> = {
  base: 'bg.docTypeBase',
};

/** 校验文档是否就绪（已识别 + 已授权 + 类型可导出），否则返回错误 Response */
function requireReady(doc: DocInfo | null): Response | null {
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

/** 执行导出并上报结果（格式、成败、耗时秒），统计失败不影响导出 */
async function trackedExport(
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

/** 电子表格只支持 Markdown/CSV 导出；PDF/HTML/附件对表格不适用，单独挡 */
function blockSheetOnly(doc: DocInfo): Response | null {
  if (doc.docType === 'sheets') {
    return {
      success: false,
      error: t('bg.sheetOnlyMarkdown'),
    };
  }
  return null;
}
