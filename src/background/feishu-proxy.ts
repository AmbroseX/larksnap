import type { Response } from '../shared/types';
import type { MediaBlob } from '../content/api/media';
import { CONTENT_MSG } from '../shared/constants';
import { bytesToBase64 } from './media-util';
import { getActiveTab } from './doc-detect';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 内容请求的目标 tab 覆盖 —— 桥接模式下导出的是「后台新开的标签页」而非活跃页，
 * 故所有同源 content 请求需打到该 tab。设为 null 即回退活跃 tab（UI 触发路径）。
 */
let _contentTabId: number | null = null;
export function setContentTab(tabId: number | null): void {
  _contentTabId = tabId;
}

/**
 * SW 侧代发飞书内部接口的代理 —— 实际请求由 content script 同源发起（宪法原则 I）。
 * SW 这里只负责"确保 content 已注入 + 把请求转给它 + 取回结果"。
 */

/** 确保目标 tab 已注入 content.js */
async function ensureContent(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js'],
  });
}

async function send<T>(tabId: number, message: unknown): Promise<T> {
  const res = (await chrome.tabs.sendMessage(tabId, message)) as
    | Response<T>
    | undefined;
  if (!res) throw new Error('content 无响应（页面可能未注入或已关闭）');
  if (!res.success) throw new Error(res.error || 'content 请求失败');
  return res.data as T;
}

/**
 * 解析导出目标 tab 的 id —— 桥接模式用后台开的标签页，UI 模式用活跃页。
 * 与 activeContentTab 同源，但不注入 content.js（供 MAIN world executeScript 用）。
 */
export async function resolveTargetTabId(): Promise<number> {
  if (_contentTabId != null) return _contentTabId;
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error('无活跃标签页');
  return tab.id;
}

/** 取当前活跃 tab 的 id，并确保 content 已注入 */
async function activeContentTab(): Promise<number> {
  if (_contentTabId != null) {
    await ensureContent(_contentTabId);
    return _contentTabId;
  }
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error('无活跃标签页');
  await ensureContent(tab.id);
  return tab.id;
}

/** GET 内部接口（经 content 同源代发） */
export async function feishuGet<T = unknown>(path: string): Promise<T> {
  const tabId = await activeContentTab();
  return send<T>(tabId, {
    type: CONTENT_MSG.FEISHU_REQUEST,
    data: { method: 'GET', path },
  });
}

/**
 * POST 内部接口（经 content 同源代发，带 CSRF）。
 * opts.form=true 走表单编码（explorer/create 一类接口只认表单）。
 */
export async function feishuPost<T = unknown>(
  path: string,
  body: unknown,
  opts?: { form?: boolean }
): Promise<T> {
  const tabId = await activeContentTab();
  return send<T>(tabId, {
    type: CONTENT_MSG.FEISHU_REQUEST,
    data: { method: 'POST', path, body, form: opts?.form ?? false },
  });
}

/**
 * 下载媒体二进制(按候选 URL 顺序尝试),返回 base64 + mimeType。
 *
 * ⚠️ MV3 关键点：媒体在 `internal-api-drive-stream.{基础域}`(跨子域),content
 * script 在 MV3 下**无法用扩展 host 权限绕过 CORS**;只有 SW 的 fetch 能凭 host
 * 权限做跨源带 cookie 请求。故**默认 SW 直接 fetch**(需已授权基础域通配),
 * 失败再回退 content。`urls` 由 media-util 按"块 id 作 mount_node_token"构造。
 */
export async function downloadMedia(urls: string[]): Promise<MediaBlob> {
  try {
    return await downloadMediaInSW(urls);
  } catch (err) {
    console.warn('[larksnap] SW 媒体下载失败，回退 content:', err);
    const tabId = await activeContentTab();
    return send<MediaBlob>(tabId, {
      type: CONTENT_MSG.DOWNLOAD_MEDIA,
      data: { urls },
    });
  }
}

/** 在 SW 直接跨源下载（host 权限赋予跨源特权 + credentials 带 cookie），按候选 URL 逐个试 */
async function downloadMediaInSW(urls: string[]): Promise<MediaBlob> {
  let lastErr: unknown;
  for (let round = 0; round < 2; round++) {
    for (const url of urls) {
      try {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const mimeType =
          res.headers.get('content-type') || 'application/octet-stream';
        // 命中 JSON 多半是错误响应(如未授权)，跳过试下一个候选
        if (/application\/json/i.test(mimeType)) throw new Error('返回 JSON 非二进制');
        const buf = await res.arrayBuffer();
        if (buf.byteLength === 0) throw new Error('空响应');
        return { base64: bytesToBase64(buf), mimeType };
      } catch (err) {
        lastErr = err;
      }
    }
    await sleep(400 * (round + 1));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** 取页面单文件 HTML 快照（经 content） */
export async function getSnapshot(): Promise<{
  html: string;
  title: string;
  capturedAt: number;
}> {
  const tabId = await activeContentTab();
  return send(tabId, { type: CONTENT_MSG.GET_SNAPSHOT });
}
