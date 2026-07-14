import type { Response, WebCopyNeedsPermission } from '../shared/types';
import { sendToBackground } from '../shared/messaging';
import { t } from '../shared/i18n';

/**
 * 侧边栏公用小工具（004 新增，供 TranscriptCard / SummaryView 用）：
 *   - callWithPermission：消息调用 + 注入无权限时在用户手势里授权后重试
 *     （与 WebCopyView 内部 callWebcopy 同模式；那边可能在并行改动，暂不合并）
 *   - copyToClipboard：剪贴板写入 + execCommand 降级
 */

/** 消息调用；SW 回 needsPermission 时在同一手势里 permissions.request 后重试 */
export async function callWithPermission<T>(
  type: string,
  data?: unknown
): Promise<Response<T>> {
  const res = await sendToBackground<T | WebCopyNeedsPermission>(type, data);
  const fallback = res.data as WebCopyNeedsPermission | undefined;
  if (!res.success && fallback?.needsPermission) {
    // request 异常不吞：真实原因（如手势失效）直接回给 UI 显示，便于定位授权弹不出的问题
    let reqErr = '';
    const granted = await chrome.permissions
      .request({ origins: [fallback.originPattern] })
      .catch((e: unknown) => {
        reqErr = e instanceof Error ? e.message : String(e);
        return false;
      });
    if (!granted) {
      return { success: false, error: reqErr || t('webcopy.notAuthorized') };
    }
    return (await sendToBackground<T>(type, data)) as Response<T>;
  }
  return res as Response<T>;
}

/**
 * 写剪贴板：navigator.clipboard 依赖用户激活窗口，异步任务完成时可能已过期，
 * 失败降级临时 textarea + execCommand。都失败返回 false，由调用方给手动复制预览。
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 降级 execCommand
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}
