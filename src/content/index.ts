import { CONTENT_MSG } from '../shared/constants';
import { detectCurrentDoc } from './feishu-detect';
import { feishuGet, feishuPost } from './api/request';
import { downloadMediaByUrls } from './api/media';
import { captureSnapshot, scrollLoadAll } from './snapshot';

/**
 * Content script —— 在飞书文档页面按需注入（通过 chrome.scripting.executeScript）。
 * 职责：
 *   1. 识别当前页面的飞书文档信息（类型 / token / 标题）
 *   2. **代发飞书内部接口**（同源 + referer + CSRF，宪法原则 I）
 *   3. 下载媒体二进制、生成离线快照
 *
 * 注意：本文件被 esbuild 单独打成 IIFE（content.js）后注入；它 import 的
 * `api/*`、`snapshot.ts` 会被 bundle 进同一文件，可放心拆模块。
 */

/** 内部接口代发的请求描述（SW → content） */
interface FeishuReq {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}

async function handleAsync(msg: { type: string; data?: unknown }): Promise<unknown> {
  switch (msg.type) {
    case CONTENT_MSG.FEISHU_REQUEST: {
      const { method, path, body } = msg.data as FeishuReq;
      const data =
        method === 'POST' ? await feishuPost(path, body) : await feishuGet(path);
      return { success: true, data };
    }

    case CONTENT_MSG.DOWNLOAD_MEDIA: {
      const { urls } = msg.data as { urls: string[] };
      const data = await downloadMediaByUrls(urls);
      return { success: true, data };
    }

    case CONTENT_MSG.SCROLL_LOAD: {
      await scrollLoadAll();
      return { success: true };
    }

    case CONTENT_MSG.GET_SNAPSHOT: {
      const data = await captureSnapshot();
      return { success: true, data };
    }

    default:
      return { success: false, error: `未知 content 消息: ${msg.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // 同步消息：直接识别
  if (msg?.type === CONTENT_MSG.DETECT_DOC) {
    sendResponse(detectCurrentDoc());
    return false;
  }

  // 异步消息：保持通道开启，Promise 完成后回传
  if (
    msg?.type === CONTENT_MSG.FEISHU_REQUEST ||
    msg?.type === CONTENT_MSG.DOWNLOAD_MEDIA ||
    msg?.type === CONTENT_MSG.SCROLL_LOAD ||
    msg?.type === CONTENT_MSG.GET_SNAPSHOT
  ) {
    handleAsync(msg)
      .then(sendResponse)
      .catch((err: unknown) =>
        sendResponse({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        })
      );
    return true;
  }

  return false;
});

// 标记已注入，避免重复执行副作用
(window as unknown as { __larksnap__?: boolean }).__larksnap__ = true;
