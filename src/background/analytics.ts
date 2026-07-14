import type { TrackEvent, TrackEventName } from '../shared/types';
import { UMAMI_HOST, UMAMI_WEBSITE_ID, STORAGE_KEYS } from '../shared/constants';
import { getConfig } from '../shared/storage';

/**
 * 匿名使用统计（Umami）。
 * MV3 禁止加载远程 script.js，直接调 Umami 的上报接口 /api/send。
 * 隐私约定：只上报白名单内的事件名 + 版本号 + 枚举值，不采集任何文档内容 / URL。
 *
 * 设备去重：首装生成一个随机匿名 ID（did，纯随机 UUID，不含任何身份信息），
 * 只挂在「日活心跳」事件上，用来在 Umami 里按设备算日活/留存——比 Umami 默认的
 * IP+UA 去重准（换网络不会重复计数，公司 NAT 也不会互相吞）。
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
  // 每日心跳：本地按天去重后上报，did 用于算留存
  'active',
]);

/** 每日心跳的 alarm 名 */
const DAILY_ALARM = 'larksnap:daily-active';

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

/** 读取匿名设备 ID，没有就生成一个随机 UUID 存下来（纯随机，不关联任何身份）。 */
async function getDeviceId(): Promise<string> {
  const got = await chrome.storage.local.get(STORAGE_KEYS.DEVICE_ID);
  const existing = got[STORAGE_KEYS.DEVICE_ID] as string | undefined;
  if (existing) return existing;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [STORAGE_KEYS.DEVICE_ID]: id });
  return id;
}

/** 本地日期（按浏览器所在时区取 YYYY-MM-DD），作为「今天报过没」的判据。 */
function localDay(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * 日活心跳：同一台设备一天只上报一次。
 * 因为本地按天去重了，某天的 active 事件总数就≈当天活跃设备数（不用依赖服务端去重）；
 * did 让 Umami 还能进一步算「同一设备跨天回访」的留存。
 */
async function pingDailyActive(): Promise<void> {
  try {
    const config = await getConfig();
    if (!config.analyticsEnabled) return;

    const today = localDay();
    const got = await chrome.storage.local.get(STORAGE_KEYS.LAST_ACTIVE);
    if (got[STORAGE_KEYS.LAST_ACTIVE] === today) return; // 今天已报过

    await chrome.storage.local.set({ [STORAGE_KEYS.LAST_ACTIVE]: today });
    const did = await getDeviceId();
    void track({ name: 'active', url: '/lifecycle/active', data: { did } });
  } catch {
    // 静默
  }
}

/** SW 启动时调用一次：注册安装/更新事件上报 + 每日心跳 */
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

  // SW 每次被唤醒（用户一有操作就会）都探一次日活，本地按天去重挡住重复上报；
  // alarm 再兜底：浏览器长开跨过零点、SW 一直没重启的情况下也能补报当天。
  void pingDailyActive();
  chrome.alarms.create(DAILY_ALARM, { periodInMinutes: 60 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === DAILY_ALARM) void pingDailyActive();
  });
}
