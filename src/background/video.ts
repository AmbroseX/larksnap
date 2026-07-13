// 视频下载（扩展侧）：识别当前标签页站点，把「页面 URL + 必要请求头 + cookie」
// 经桥接反向交给本地 daemon（daemon 跑 yt-dlp 下载落盘），进度转成统一 PROGRESS 推给侧边栏。
//
// 第一层策略（见 docs/plans/2026-07-09-网页视频下载.md）：只传页面 URL，提取全靠 yt-dlp；
// 抖音/TikTok 的 MAIN 世界取址专路属第二迭代，不在此文件。
import type {
  Response,
  VideoProbeResult,
  VideoProxyConfig,
  VideoRoute,
  VideoState,
  VideoTaskInfo,
} from '../shared/types';
import { MSG, STORAGE_KEYS, VIDEO_SITES } from '../shared/constants';
import { getConfig } from '../shared/storage';
import {
  requestVideoDownload,
  requestVideoProbe,
  requestVideoReveal,
  videoBridgeReady,
  type VideoJobRequest,
} from './bridge';
import { reportProgress } from './progress';
import { track } from './analytics';

// ---- 代理线路（按站点记忆）----

/** 读线路记忆表：site → 上次成功的线路 */
async function readRoutes(): Promise<Record<string, VideoRoute>> {
  const got = await chrome.storage.local.get(STORAGE_KEYS.VIDEO_ROUTE);
  return (got[STORAGE_KEYS.VIDEO_ROUTE] ?? {}) as Record<string, VideoRoute>;
}

/** 任务成功后记住该站点这次用的线路，下次同站任务直接先走它 */
async function saveRoute(site: string, route: VideoRoute): Promise<void> {
  const routes = await readRoutes();
  if (routes[site] === route) return;
  routes[site] = route;
  await chrome.storage.local.set({ [STORAGE_KEYS.VIDEO_ROUTE]: routes });
}

/** 配置 → 显式代理地址（host 为空 = 未配置，跟随 daemon 的系统代理） */
function proxyUrlOf(cfg: VideoProxyConfig): string | undefined {
  const host = cfg.host.trim();
  if (!host) return undefined;
  const port = cfg.port.trim();
  return `${cfg.scheme}://${host}${port ? `:${port}` : ''}`;
}

/**
 * 「不代理的地址列表」匹配：每行一个主机，支持 * 通配；
 * 无通配符的行按「等于该主机或它的子域」匹配（如 bilibili.com 也匹配 www.bilibili.com）。
 */
function bypassMatch(bypass: string, host: string): boolean {
  for (const raw of bypass.split('\n')) {
    const line = raw.trim().toLowerCase();
    if (!line || line.startsWith('#')) continue;
    if (line.includes('*')) {
      const re = new RegExp(`^${line.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
      if (re.test(host)) return true;
    } else if (host === line || host.endsWith(`.${line}`)) {
      return true;
    }
  }
  return false;
}
import { t } from '../shared/i18n';

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
      url: site != null ? tab?.url : undefined,
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

/** 侧边栏线路选择：auto=名单/记忆自动决定；direct/proxy=本次强制（优先级最高） */
export type RouteChoice = 'auto' | VideoRoute;

/**
 * 组一次视频任务请求（下载与探测共用）：站点校验 + 桥接校验 + headers/cookies + 代理线路。
 * 线路优先级：侧边栏手选（direct/proxy）→ 不代理列表 → 仅代理列表 → 站点线路记忆。
 */
async function buildRequest(
  quality?: string,
  choice: RouteChoice = 'auto'
): Promise<{ req: VideoJobRequest; site: string; routeLocked: boolean } | { error: string }> {
  const tab = await activeTab();
  const url = tab?.url;
  if (!url) return { error: t('bg.videoNoUrl') };
  const site = matchSite(url);
  if (!site) return { error: t('bg.videoUnsupportedSite') };
  const ready = videoBridgeReady();
  if (!ready.ok) return { error: ready.reason || t('bg.bridgeNotReady') };

  const cfg = await getConfig();
  const host = new URL(url).hostname.toLowerCase();
  // 手选线路是最新鲜的用户意图，直接压过两张名单；auto 才走名单与记忆
  const forceDirect = choice === 'direct' || (choice === 'auto' && bypassMatch(cfg.videoProxy.bypass, host));
  const forceProxy =
    !forceDirect &&
    (choice === 'proxy' || (choice === 'auto' && bypassMatch(cfg.videoProxy.proxyOnly, host)));
  const locked = forceDirect || forceProxy;
  const routes = await readRoutes();
  return {
    site,
    routeLocked: locked,
    req: {
      url,
      quality,
      headers: {
        referer: new URL(url).origin + '/',
        'user-agent': navigator.userAgent,
      },
      cookies: await collectCookies(url),
      proxy: proxyUrlOf(cfg.videoProxy),
      route: forceDirect ? 'direct' : forceProxy ? 'proxy' : routes[site],
      routeLocked: locked || undefined,
    },
  };
}

/** 侧边栏查询：探测当前视频的可用清晰度档位（yt-dlp -J，带登录 cookie 时档位如实反映权益） */
export async function probeVideo(): Promise<Response<VideoProbeResult>> {
  const built = await buildRequest();
  if ('error' in built) return { success: false, error: built.error };
  try {
    const data = await requestVideoProbe(built.req);
    // 探测和下载走同一条网络路径，成功线路一并记住
    if (data.route && !built.routeLocked) void saveRoute(built.site, data.route);
    return { success: true, data };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---- 下载任务表（SW 内存；daemon 侧最多 2 个 yt-dlp 并发，扩展侧同步排队）----

const MAX_PARALLEL = 2; // 与 daemon 的 MAX_CONCURRENT 保持一致
let taskSeq = 0;
const tasks = new Map<string, VideoTaskInfo>();
/** 排队任务的请求参数（任务表只放展示字段，避免 cookie 等敏感数据被推给 UI） */
const taskReqs = new Map<string, { req: VideoJobRequest; routeLocked: boolean }>();

function runningTaskCount(): number {
  return [...tasks.values()].filter((x) => x.status === 'running').length;
}

/** 任务列表变化 → 推送全量给侧边栏（未打开时 reject，忽略） */
function broadcastTasks(): void {
  chrome.runtime
    .sendMessage({ type: MSG.VIDEO_TASKS, data: listVideoTasks() })
    .catch(() => {});
}

/** UI 拉取：按创建时间倒序 */
export function listVideoTasks(): VideoTaskInfo[] {
  return [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** 清除已结束（成功/失败）的任务 */
export function clearVideoTasks(): Response<{ removed: number }> {
  let removed = 0;
  for (const [id, task] of tasks) {
    if (task.status === 'success' || task.status === 'error') {
      tasks.delete(id);
      taskReqs.delete(id);
      removed++;
    }
  }
  broadcastTasks();
  return { success: true, data: { removed } };
}

/** 在系统文件管理器里显示任务产物；不传 taskId（或文件已移走）就打开下载根目录 */
export function revealVideoTask(taskId?: string): Response<null> {
  try {
    requestVideoReveal(taskId ? tasks.get(taskId)?.file : undefined);
    return { success: true, data: null };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 有空位就把排队任务派给 daemon */
function pumpQueue(): void {
  let slots = MAX_PARALLEL - runningTaskCount();
  for (const task of [...tasks.values()].sort((a, b) => a.createdAt - b.createdAt)) {
    if (slots <= 0) break;
    if (task.status !== 'queued') continue;
    dispatchTask(task);
    slots--;
  }
}

function dispatchTask(task: VideoTaskInfo): void {
  const stored = taskReqs.get(task.id);
  if (!stored) {
    task.status = 'error';
    task.message = t('progress.video.failed');
    return;
  }
  task.status = 'running';
  task.message = t('progress.video.handoff');

  const settle = () => {
    taskReqs.delete(task.id);
    broadcastTasks();
    pumpQueue();
  };

  try {
    requestVideoDownload(stored.req, (ev) => {
      if (ev.type === 'video-progress') {
        task.percent = ev.percent ?? task.percent;
        task.message = ev.message || task.message;
        broadcastTasks();
        void reportProgress('video', 'running', `${task.title}：${task.message ?? ''}`, ev.percent);
        return;
      }
      const ok = ev.type === 'video-result';
      void track({ name: 'video', url: '/video/download', data: { site: task.site, ok } });
      if (ok) {
        if (ev.route && !stored.routeLocked) void saveRoute(task.site, ev.route);
        task.status = 'success';
        task.percent = 100;
        task.file = ev.file;
        task.message = t('progress.video.saved', { file: ev.file || t('progress.video.defaultDir') });
        void reportProgress('video', 'success', task.message, 100);
      } else {
        task.status = 'error';
        task.message = ev.message || t('progress.video.failed');
        void reportProgress('video', 'error', `${task.title}：${task.message}`);
      }
      settle();
    });
  } catch (e) {
    task.status = 'error';
    task.message = e instanceof Error ? e.message : String(e);
    void reportProgress('video', 'error', task.message);
    settle();
  }
}

/**
 * 侧边栏点「下载视频」：入队即返回任务 id（不再等下载结束），
 * 进度看任务列表（VIDEO_TASKS 推送）与底部状态栏。同一视频在跑时防重复入队。
 */
export async function downloadVideo(
  quality?: string,
  route: RouteChoice = 'auto'
): Promise<Response<{ taskId: string }>> {
  const built = await buildRequest(quality, route);
  if ('error' in built) return { success: false, error: built.error };
  const { req, site, routeLocked } = built;

  const dup = [...tasks.values()].find(
    (x) => x.url === req.url && (x.status === 'queued' || x.status === 'running')
  );
  if (dup) return { success: false, error: t('progress.video.duplicate') };

  const tab = await activeTab();
  const task: VideoTaskInfo = {
    id: `vt${++taskSeq}-${Date.now().toString(36)}`,
    url: req.url,
    site,
    title: (tab?.title || '').trim() || req.url,
    status: 'queued',
    createdAt: Date.now(),
  };
  tasks.set(task.id, task);
  taskReqs.set(task.id, { req, routeLocked });
  pumpQueue();
  broadcastTasks();
  return { success: true, data: { taskId: task.id } };
}
