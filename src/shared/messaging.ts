import type { Message, Response } from './types';

/**
 * 从 UI（侧边栏 / 设置 / 弹窗）向背景 Service Worker 发送消息。
 * 背景统一以 { success, data?, error? } 形式响应。
 */
export async function sendToBackground<T = unknown, D = unknown>(
  type: string,
  data?: D
): Promise<Response<T>> {
  try {
    const res = (await chrome.runtime.sendMessage({ type, data } as Message<D>)) as
      | Response<T>
      | undefined;
    if (!res) {
      return { success: false, error: '背景无响应（Service Worker 可能已休眠）' };
    }
    return res;
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 监听背景推送（如导出进度）。返回取消监听的函数。 */
export function onBackgroundMessage(
  handler: (msg: Message) => void
): () => void {
  const listener = (msg: Message) => handler(msg);
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
