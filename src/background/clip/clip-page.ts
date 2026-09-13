/**
 * 「转存到飞书」编排（任意网页 → 飞书云文档）：
 *   ① webcopy content 提取正文 HTML（复用剪藏注入管线，权限不足回 needsPermission）
 *   ② 解析一个可用飞书租户 host（授权时记的真实租户 origin → 已打开的飞书标签 → 默认兜底）
 *   ③ feishu-clip 走官方「剪存」通道上传并轮询出 docUrl
 *
 * 协议与常量见 feishu-clip.ts / doc/02-feishu-api-and-clip-protocol.md（逆向自 v0.8.19）。
 */
import type { Response, WebCopyNeedsPermission } from '../../shared/types';
import { t } from '../../shared/i18n';
import { getTrustedOrigins } from '../../shared/storage';
import { hostOf, originOf } from '../../shared/feishu-host';
import { detectDocFromUrl } from '../../content/feishu-detect';
import { reportProgress } from '../progress';
import { webcopyClipHtml } from '../webcopy';
import { clipHtmlToFeishu } from './feishu-clip';

/** 找不到任何租户线索时的兜底 host（与目标扩展解析失败时的默认值一致） */
const FALLBACK_HOST = 'my.feishu.cn';

export interface ClipPageResult {
  docUrl: string;
}

/**
 * 解析上传用的租户 host。
 * 剪存请求发到 internal-api-space.*（固定域名），Origin/Referer 伪装成租户页——
 * 租户越真实越不容易触发风控，因此优先用户自己的租户，而不是随便编一个域名。
 */
async function resolveTenant(): Promise<{ host: string; origin?: string }> {
  // ① 授权那一刻记下的真实租户 origin（用户活跃使用过的租户）
  for (const origin of Object.values(await getTrustedOrigins())) {
    const host = hostOf(origin);
    if (host) return { host, origin };
  }
  // ② 当前已打开的飞书文档标签（隐含「此刻已登录」）
  const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]);
  for (const tab of tabs) {
    const url = tab.url || '';
    if (url && detectDocFromUrl(url).isFeishuDoc) {
      const host = hostOf(url);
      if (host) return { host, origin: originOf(url) || undefined };
    }
  }
  // ③ 兜底：登录态 Cookie 挂基础域时照样可用（与目标扩展行为一致）
  return { host: FALLBACK_HOST };
}

/** 侧边栏/右键入口：把指定标签页的正文转存为飞书云文档，返回 docUrl */
export async function clipPageToFeishu(
  tabId: number,
  url: string
): Promise<Response<ClipPageResult | WebCopyNeedsPermission>> {
  // ① 正文 HTML（注入失败会带 needsPermission 回传给 UI，在同一次手势里授权后重试）
  const extracted = await webcopyClipHtml(tabId, url);
  if (!extracted.success || !extracted.data) {
    // 失败可能带 needsPermission（UI 在同手势里授权后重试），原样回传
    return extracted as Response<WebCopyNeedsPermission>;
  }
  if ('needsPermission' in extracted.data) {
    return { success: false, error: extracted.error, data: extracted.data };
  }
  const { html, title } = extracted.data;

  // ② 租户 host
  const { host, origin } = await resolveTenant();

  // ③ 剪存上传（进度经统一进度通道推给侧边栏状态栏）
  try {
    const { docUrl } = await clipHtmlToFeishu({
      html,
      title: title || t('webcopy.defaultFilename'),
      originUrl: url,
      host,
      origin,
      onProgress: (p) => void reportProgress('clip', 'running', p.message, p.percent),
    });
    await reportProgress('clip', 'success', t('clip.saved', { url: docUrl }), 100);
    return { success: true, data: { docUrl } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await reportProgress('clip', 'error', message);
    return { success: false, error: message };
  }
}
