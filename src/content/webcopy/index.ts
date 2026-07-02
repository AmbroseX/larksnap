import { CONTENT_MSG, STORAGE_KEYS } from '../../shared/constants';
import { getConfig } from '../../shared/storage';
import type { WebCopyState } from '../../shared/types';
import { pageToMarkdown, selectionToMarkdown } from './html2md';
import { startUnlock, stopUnlock, isUnlocked } from './unlock';
import { applyAutoCopyConfig } from './auto-copy';
import { writeClipboard } from './clipboard';
import { showToast } from './toast';

/**
 * webcopy content 入口 —— 通过 chrome.scripting.executeScript 按需注入任意网页。
 * 与飞书 content（content.js）完全平行：消息类型不同、入口文件不同。
 *
 * 幂等挂载：executeScript 可能被重复调用（右键菜单/侧边栏各触发一次），
 * 用 window 标记保证监听器只注册一次。
 */

declare global {
  interface Window {
    __larksnap_webcopy?: boolean;
  }
}

if (!window.__larksnap_webcopy) {
  window.__larksnap_webcopy = true;
  mount();
}

function mount(): void {
  // 挂载即按当前配置决定是否启动自动复制；配置改动热更新，无需刷新页面
  getConfig().then((cfg) => applyAutoCopyConfig(cfg.webcopy));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEYS.CONFIG]) {
      getConfig().then((cfg) => applyAutoCopyConfig(cfg.webcopy));
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (
      msg?.type !== CONTENT_MSG.WEBCOPY_PAGE_TO_MD &&
      msg?.type !== CONTENT_MSG.WEBCOPY_SELECTION_TO_MD &&
      msg?.type !== CONTENT_MSG.WEBCOPY_UNLOCK &&
      msg?.type !== CONTENT_MSG.WEBCOPY_STATE
    ) {
      return false;
    }
    handle(msg)
      .then(sendResponse)
      .catch((err: unknown) =>
        sendResponse({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        })
      );
    return true;
  });
}

async function handle(msg: { type: string; data?: unknown }): Promise<unknown> {
  switch (msg.type) {
    case CONTENT_MSG.WEBCOPY_PAGE_TO_MD: {
      const { writeClipboard: doWrite } = (msg.data || {}) as {
        writeClipboard?: boolean;
      };
      const result = pageToMarkdown();
      if (doWrite) {
        await writeClipboard(result.markdown);
        showToast('整页 Markdown 已复制');
      }
      return { success: true, data: result };
    }

    case CONTENT_MSG.WEBCOPY_SELECTION_TO_MD: {
      const { writeClipboard: doWrite } = (msg.data || {}) as {
        writeClipboard?: boolean;
      };
      const result = selectionToMarkdown();
      if (doWrite) {
        await writeClipboard(result.markdown);
        showToast('选中内容已复制为 Markdown');
      }
      return { success: true, data: result };
    }

    case CONTENT_MSG.WEBCOPY_UNLOCK: {
      const { enabled } = (msg.data || {}) as { enabled?: boolean };
      const next = enabled ?? !isUnlocked();
      if (next) startUnlock();
      else stopUnlock();
      showToast(next ? '已解除复制限制' : '已恢复页面原状');
      return { success: true, data: { enabled: next } };
    }

    case CONTENT_MSG.WEBCOPY_STATE: {
      const state: WebCopyState = { mounted: true, unlocked: isUnlocked() };
      return { success: true, data: state };
    }

    default:
      return { success: false, error: `未知 webcopy 消息: ${msg.type}` };
  }
}
