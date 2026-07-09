// 视频下载（扩展侧）：识别当前标签页站点，把「页面 URL + 必要请求头 + cookie」
// 经桥接反向交给本地 daemon（daemon 跑 yt-dlp 下载落盘），进度转成统一 PROGRESS 推给侧边栏。
//
// 第一层策略（见 docs/plans/2026-07-09-网页视频下载.md）：只传页面 URL，提取全靠 yt-dlp；
// 抖音/TikTok 的 MAIN 世界取址专路属第二迭代，不在此文件。
import type { Response, VideoState } from '../shared/types';
import { VIDEO_SITES } from '../shared/constants';
import { requestVideoDownload, videoBridgeReady, type VideoJobRequest } from './bridge';
import { reportProgress } from './progress';
import { track } from './analytics';

/** hostname 命中站点表则返回站点枚举名 */
function matchSite(url: string): string | null {
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

async function activeTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

/** 侧边栏查询：当前页是否支持下载视频 + 桥接是否就绪 */
export async function getVideoState(): Promise<Response<VideoState>> {
  const tab = await activeTab();
  const site = tab?.url ? matchSite(tab.url) : null;
  const ready = videoBridgeReady();
  return {
    success: true,
    data: {
      supported: site != null,
      site: site ?? undefined,
      bridgeReady: ready.ok,
      reason: ready.reason,
    },
  };
}

/**
 * 收集该页面的 cookie 交给 daemon 写临时 cookie 文件（B 站登录后才有高清晰度）。
 * 需要该域名的 host 权限；默认站点不在 manifest 里 → 用户授权过才拿得到，拿不到就裸下载。
 */
async function collectCookies(url: string): Promise<VideoJobRequest['cookies']> {
  try {
    const list = await chrome.cookies.getAll({ url });
    if (!list.length) return undefined;
    return list.map((c) => ({
      // Chrome 的 domain 带前导点表示含子域，Netscape 格式同义，原样传
      domain: c.domain,
      path: c.path,
      name: c.name,
      value: c.value,
      secure: c.secure,
      expires: c.expirationDate ?? 0,
    }));
  } catch {
    return undefined; // 无 host 权限 → 不带 cookie
  }
}

/** 侧边栏点「下载视频」：任务交给 daemon，等到下载结束才 resolve（进度经 PROGRESS 推送） */
export async function downloadVideo(): Promise<Response<{ file?: string }>> {
  const tab = await activeTab();
  const url = tab?.url;
  if (!url) return { success: false, error: '无法获取当前标签页地址' };
  const site = matchSite(url);
  if (!site) return { success: false, error: '当前页面不是支持的视频站点' };

  const ready = videoBridgeReady();
  if (!ready.ok) return { success: false, error: ready.reason };

  const req: VideoJobRequest = {
    url,
    headers: {
      referer: new URL(url).origin + '/',
      'user-agent': navigator.userAgent,
    },
    cookies: await collectCookies(url),
  };

  await reportProgress('video', 'running', '正在把下载任务交给本地 daemon…', 0);

  return new Promise((resolve) => {
    try {
      requestVideoDownload(req, (ev) => {
        if (ev.type === 'video-progress') {
          void reportProgress('video', 'running', ev.message || '下载中…', ev.percent);
          return;
        }
        const ok = ev.type === 'video-result';
        void track({ name: 'video', url: '/video/download', data: { site, ok } });
        if (ok) {
          void reportProgress('video', 'success', `视频已保存：${ev.file || '下载目录/larksnap-video'}`, 100);
          resolve({ success: true, data: { file: ev.file } });
        } else {
          const message = ev.message || '下载失败';
          void reportProgress('video', 'error', message);
          resolve({ success: false, error: message });
        }
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      void reportProgress('video', 'error', message);
      resolve({ success: false, error: message });
    }
  });
}
