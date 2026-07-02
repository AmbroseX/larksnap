import type { DocInfo, Message, Response } from '../shared/types';
import { MSG } from '../shared/constants';
import { getRuntimeState } from '../shared/storage';
import { detectActiveDoc } from './doc-detect';
import { getSnapshot } from './feishu-proxy';
import { reportProgress } from './progress';
import { exportMarkdown } from './exporters/markdown';
import { exportPdf } from './exporters/pdf';
import { exportHtml } from './exporters/html';
import { exportAttachments } from './exporters/attachments';
import { cacheDoc, listCache, removeCache, getCache } from './cache-manager';
import { exportDiagnostic } from './diagnostic';
import { getCookie } from './cookie';
import { hasPermissionForHost, recordTrusted, revokePermission, listTrusted } from './permissions';
import { startBridge, getBridgeStatus } from './bridge';
import {
  setupWebcopy,
  webcopyPageMd,
  webcopySelectionMd,
  webcopyToggleUnlock,
  webcopyEnsure,
  webcopyGetState,
  copyTabs,
} from './webcopy';
import type { TabCopyFormat } from '../shared/types';

console.log('[feishu2md] Service Worker 启动');

// CC ⇄ 扩展 桥接：连原生宿主、长连保活、接收远程导出任务
startBridge();

// webcopy：右键菜单注册与分发（与飞书导出平行，互不干扰）
setupWebcopy();

// ==================== 点击图标打开侧边栏 ====================
chrome.sidePanel
  ?.setPanelBehavior?.({ openPanelOnActionClick: true })
  .catch(() => {});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.sidePanel.setOptions({
      tabId: tab.id,
      path: 'sidepanel.html',
      enabled: true,
    });
    await (chrome.sidePanel as { open: (o: unknown) => Promise<void> }).open({
      tabId: tab.id,
    });
  } catch (e) {
    console.warn('[feishu2md] 打开侧边栏失败:', e);
  }
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
      if (!name) return { success: false, error: '缺少 cookie 名' };
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
      if (!pattern) return { success: false, error: '缺少授权项' };
      return { success: true, data: await revokePermission(pattern) };
    }
    case MSG.LIST_TRUSTED: {
      return { success: true, data: await listTrusted() };
    }

    // ---------- 导出动作 ----------
    case MSG.EXPORT_MARKDOWN: {
      const doc = await detectActiveDoc();
      const err = requireReady(doc);
      return err ?? exportMarkdown(doc!);
    }

    case MSG.EXPORT_WORD: {
      await reportProgress('word', 'error', 'Word 导出功能开发中');
      return { success: false, error: 'Word 导出功能开发中' };
    }

    case MSG.EXPORT_PDF: {
      const doc = await detectActiveDoc();
      const err = requireReady(doc);
      return err ?? exportPdf(doc!);
    }

    case MSG.EXPORT_HTML: {
      const doc = await detectActiveDoc();
      const err = requireReady(doc);
      return err ?? exportHtml(doc!);
    }

    case MSG.EXPORT_ATTACHMENTS: {
      const doc = await detectActiveDoc();
      const err = requireReady(doc);
      return err ?? exportAttachments(doc!);
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
      if (!token) return { success: false, error: '缺少 token' };
      return getCache(token);
    }

    case MSG.CACHE_DELETE: {
      const { token } = (message.data || {}) as { token?: string };
      if (!token) return { success: false, error: '缺少 token' };
      return removeCache(token);
    }

    case MSG.EXPORT_DIAGNOSTIC: {
      const doc = await detectActiveDoc();
      return exportDiagnostic(doc);
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

    default:
      return { success: false, error: `未知消息类型: ${message.type}` };
  }
}

/** 校验文档是否就绪（已识别 + 已授权），否则返回错误 Response */
function requireReady(doc: DocInfo | null): Response | null {
  if (!doc || !doc.isFeishuDoc) {
    return { success: false, error: '无法识别当前页面，请在飞书文档页面操作' };
  }
  if (doc.needsAuth) {
    return { success: false, error: '检测到私有化飞书，请先在侧边栏授权访问该域名' };
  }
  return null;
}
