import type { PageKindInfo } from './types';
import { VIDEO_SITES } from './constants';
import { detectDocFromUrl } from '../content/feishu-detect';

/**
 * 页面分类（006）：把散落在 webcopy/transcript/video 的判断收敛为一个纯函数，
 * 侧边栏上下文区与右键菜单都以它的结论为准。此文件不得出现 chrome API。
 */

/** 浏览器保留页面，无法注入任何脚本（bridge 后台通道也复用此判断） */
export function isRestrictedUrl(url: string): boolean {
  return (
    !/^https?:/i.test(url) ||
    url.startsWith('https://chrome.google.com/webstore') ||
    url.startsWith('https://chromewebstore.google.com')
  );
}

/** hostname 命中视频站点表则返回站点枚举名（bilibili/youtube/douyin/tiktok） */
export function matchVideoSite(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const { site, hosts } of VIDEO_SITES) {
    if (hosts.some((h) => host === h || host.endsWith(`.${h}`))) return site;
  }
  return null;
}

/** 是否 YouTube 视频观看页：host 复用 VIDEO_SITES 的 youtube 列表，仅 /watch 路径算 */
export function isYoutubeWatchUrl(url: string): boolean {
  if (!url || isRestrictedUrl(url)) return false;
  try {
    const u = new URL(url);
    const hosts = VIDEO_SITES.find((s) => s.site === 'youtube')?.hosts ?? [];
    const hit = hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
    return hit && u.pathname === '/watch' && !!u.searchParams.get('v');
  } catch {
    return false;
  }
}

/**
 * 页面五分类（判定顺序互斥完备）：
 *   restricted（不可注入）→ feishu（URL 双信号识别，含私有化）→
 *   youtube（观看页，字幕/总结上下文）→ video（其余可下载视频站点）→ generic
 */
export function classifyPage(url: string | undefined, title?: string): PageKindInfo {
  if (!url || isRestrictedUrl(url)) {
    return { kind: 'restricted', url };
  }
  if (detectDocFromUrl(url).isFeishuDoc) {
    return { kind: 'feishu', url, title };
  }
  if (isYoutubeWatchUrl(url)) {
    return { kind: 'youtube', url, title, videoSite: 'youtube' };
  }
  const videoSite = matchVideoSite(url);
  if (videoSite) {
    return { kind: 'video', url, title, videoSite };
  }
  return { kind: 'generic', url, title };
}
