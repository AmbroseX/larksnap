import type { TrackEvent, TrackEventName } from '../shared/types';
import { UMAMI_HOST, UMAMI_WEBSITE_ID } from '../shared/constants';
import { getConfig } from '../shared/storage';

/**
 * 匿名使用统计（Umami）。
 * MV3 禁止加载远程 script.js，直接调 Umami 的上报接口 /api/send。
 * 隐私约定：只上报白名单内的事件名 + 版本号 + 枚举值，
 * 不生成设备 ID（Umami 靠 IP+UA 做当日去重），不采集任何文档内容 / URL。
 * 上报"能丢"：失败、超时一律静默，绝不影响主流程。
 */

const EVENT_WHITELIST: ReadonlySet<TrackEventName> = new Set([
  'install',
  'update',
  'open',
  'export',
  'webcopy',
  'bridge',
  'edit',
  // AI 总结：data 只带 {kind, ok, chunks, secs} 枚举/数值，无内容/URL/端点（FR-006）
  'summarize',
]);

/** 上报一次事件。即发即弃，调用方无需 await。 */
export async function track(event: TrackEvent): Promise<void> {
  try {
    if (!event?.name || !EVENT_WHITELIST.has(event.name)) return;
    const config = await getConfig();
    if (!config.analyticsEnabled) return;

    const payload = {
      website: UMAMI_WEBSITE_ID,
      hostname: 'extension',
      language: navigator.language || '',
      title: 'larksnap',
      url: event.url || `/${event.name}`,
      name: event.name,
      data: { v: chrome.runtime.getManifest().version, ...event.data },
    };
    await fetch(`${UMAMI_HOST}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'event', payload }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // 统计失败不影响任何功能，静默丢弃
  }
}

/** SW 启动时调用一次：注册安装/更新事件上报 */
export function initAnalytics(): void {
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
      void track({ name: 'install', url: '/lifecycle/install' });
    } else if (details.reason === 'update') {
      void track({
        name: 'update',
        url: '/lifecycle/update',
        data: { from: details.previousVersion || '' },
      });
    }
  });
}
