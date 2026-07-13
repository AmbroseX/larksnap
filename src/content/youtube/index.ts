import { YT_MSG } from '../../shared/constants';
import { getTranscript, listTracks } from './transcript';

/**
 * YouTube 字幕抓取 content 入口 —— 经 chrome.scripting.executeScript 按需注入
 * /watch 页（独立 IIFE → dist/youtube.js），与 webcopy.js / content.js 完全平行。
 *
 * 幂等挂载：executeScript 可能被重复调用，用 window 标记保证监听器只注册一次
 * （同 webcopy 现有模式，plan §5.11）。
 */

declare global {
  interface Window {
    __larksnap_yt__?: boolean;
  }
}

if (!window.__larksnap_yt__) {
  window.__larksnap_yt__ = true;
  mount();
}

function mount(): void {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== YT_MSG.GET_TRANSCRIPT && msg?.type !== YT_MSG.LIST_TRACKS) {
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
    return true; // 异步响应
  });
}

async function handle(msg: { type: string; data?: unknown }): Promise<unknown> {
  switch (msg.type) {
    case YT_MSG.LIST_TRACKS: {
      return { success: true, data: await listTracks() };
    }
    case YT_MSG.GET_TRANSCRIPT: {
      const { lang } = (msg.data || {}) as { lang?: string };
      return { success: true, data: await getTranscript(lang || 'zh') };
    }
    default:
      return { success: false, error: `未知 youtube 消息: ${msg.type}` };
  }
}
