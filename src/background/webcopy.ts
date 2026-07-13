import type {
  Response,
  TabCopyFormat,
  WebCopyMdResult,
  WebCopyNeedsPermission,
  WebCopyState,
} from '../shared/types';
import { CONTENT_MSG } from '../shared/constants';
import { t } from '../shared/i18n';
import { findAdapter, type AdapterExtractResult, type SiteAdapter } from './webcopy-adapters';
import { track } from './analytics';

/** webcopy 动作统计（只报动作枚举，不含页面信息） */
function trackWebcopy(action: 'page' | 'selection' | 'unlock' | 'tabs'): void {
  void track({ name: 'webcopy', url: `/webcopy/${action}`, data: { action } });
}

/**
 * webcopy 的 SW 侧（技术方案 §2 / §6）：
 *   - 右键/快捷键入口的页内转换（手势在页面里，页面侧写剪贴板；入口注册在 context-menus.ts）
 *   - 侧边栏消息的注入调度（辅路径，注入失败回 needsPermission 让 UI 兜底授权）
 *   - 标签页链接复制（SW 只拼串，剪贴板由侧边栏写）
 * 不碰飞书协议栈，不碰剪贴板。
 */

// 判定逻辑已收敛到 shared/page-kind（006）；转发导出，既有引用方不受影响
import { isRestrictedUrl } from '../shared/page-kind';
export { isRestrictedUrl };

// 右键菜单的注册与分发已迁至 context-menus.ts（006 阶段1b），webcopy 只留剪藏管线

// ---------- 右键/快捷键入口（手势在页面里，剪贴板由页面侧写）----------

/** 整页转 MD（页内反馈版）：适配器主世界路径 + 通用管线，content 自己写剪贴板 + toast */
export async function webcopyPageMdInPage(tabId: number, url: string): Promise<Response> {
  trackWebcopy('page');
  // 百度文库等特殊站点：整页转换走适配器（主世界抓正文），并在主世界写剪贴板
  const adapter = findAdapter(url);
  if (adapter) {
    const result = await runAdapter(tabId, adapter);
    if (result?.abort) {
      // 确定性失败（登录墙/风控/不存在）：提示原因，不退通用管线
      await toastInMainWorld(tabId, result.note || t('bg.pageUnfetchable'));
      return { success: false, error: result.note || t('bg.pageUnfetchable') };
    }
    if (result) {
      await copyInMainWorld(tabId, result.markdown);
      return { success: true };
    }
    // 适配器不适用此页：继续走通用管线
  }
  await injectWebcopy(tabId);
  return sendToTab(tabId, CONTENT_MSG.WEBCOPY_PAGE_TO_MD, { writeClipboard: true });
}

/** 选区转 MD（页内反馈版） */
export async function webcopySelectionMdInPage(tabId: number): Promise<Response> {
  trackWebcopy('selection');
  await injectWebcopy(tabId);
  return sendToTab(tabId, CONTENT_MSG.WEBCOPY_SELECTION_TO_MD, { writeClipboard: true });
}

/** 解锁开关切换（页内反馈版，缺省取反） */
export async function webcopyUnlockInPage(tabId: number): Promise<Response> {
  trackWebcopy('unlock');
  await injectWebcopy(tabId);
  return sendToTab(tabId, CONTENT_MSG.WEBCOPY_UNLOCK, {});
}

export async function injectWebcopy(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['webcopy.js'],
  });
}

/** 在页面上弹一条提示（适配器 abort 时告知用户失败原因） */
async function toastInMainWorld(tabId: number, text: string): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (t: string) => {
      const el = document.createElement('div');
      el.textContent = t;
      Object.assign(el.style, {
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        zIndex: '2147483647',
        padding: '8px 14px',
        borderRadius: '8px',
        background: 'rgba(180,40,40,0.92)',
        color: '#fff',
        fontSize: '13px',
        maxWidth: '360px',
      });
      document.documentElement.appendChild(el);
      setTimeout(() => el.remove(), 3500);
    },
    args: [text],
  });
}

/** 在页面主世界写剪贴板（右键菜单手势在页面里，navigator.clipboard 可用）。
 *  主世界函数拿不到 t()，提示文案序列化前算好随参数传入。 */
async function copyInMainWorld(tabId: number, text: string): Promise<void> {
  const doneText = t('toast.copiedAsMd');
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (t: string, tip: string) => {
      const done = () => {
        const el = document.createElement('div');
        el.textContent = tip;
        Object.assign(el.style, {
          position: 'fixed',
          right: '16px',
          bottom: '16px',
          zIndex: '2147483647',
          padding: '8px 14px',
          borderRadius: '8px',
          background: 'rgba(32,32,36,0.92)',
          color: '#fff',
          fontSize: '13px',
        });
        document.documentElement.appendChild(el);
        setTimeout(() => el.remove(), 2000);
      };
      navigator.clipboard.writeText(t).then(done).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = t;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        done();
      });
    },
    args: [text, doneText],
  });
}

export async function sendToTab<T = unknown>(
  tabId: number,
  type: string,
  data?: unknown
): Promise<Response<T>> {
  const res = (await chrome.tabs.sendMessage(tabId, { type, data })) as
    | Response<T>
    | undefined;
  return res ?? { success: false, error: t('bg.contentNoResponse') };
}

/**
 * 侧边栏路径的公共前置：对指定标签页注入（tabId/url 由调用方在触发瞬间捕获——006）。
 * 注入失败（无 activeTab、无 host 权限）→ 回 needsPermission，
 * 由侧边栏在同一手势里 chrome.permissions.request 后重试。
 */
async function withInjectedTab<T>(
  tabId: number,
  url: string,
  run: (tabId: number) => Promise<Response<T>>
): Promise<Response<T | WebCopyNeedsPermission>> {
  if (isRestrictedUrl(url)) {
    return { success: false, error: t('bg.restrictedWebcopy') };
  }
  try {
    await injectWebcopy(tabId);
  } catch {
    const host = new URL(url).hostname;
    return {
      success: false,
      error: t('bg.noPermissionMenu'),
      data: { needsPermission: true, originPattern: `*://${host}/*` },
    };
  }
  return run(tabId);
}

/**
 * 站点适配器路径：在页面主世界执行 extractor（读页面全局变量 + 跨域 fetch）。
 * 命中返回结果（含带 abort 的确定性失败，此时不应退通用管线）；
 * extractor 返回 null（不适用此页）才返回 null 让上层退回通用管线。
 * bridge 后台通道也复用此函数。
 */
export async function runAdapter(
  tabId: number,
  adapter: SiteAdapter
): Promise<AdapterExtractResult | null> {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: adapter.extractor,
  });
  const result = injection?.result as AdapterExtractResult | null;
  return result && (result.markdown || result.abort) ? result : null;
}

/** 整页转 Markdown（结果回传侧边栏，由侧边栏写剪贴板/下载） */
export async function webcopyPageMd(
  tabId: number,
  url: string
): Promise<Response<WebCopyMdResult | WebCopyNeedsPermission>> {
  trackWebcopy('page');
  if (isRestrictedUrl(url)) {
    return { success: false, error: t('bg.restrictedWebcopy') };
  }

  const adapter = findAdapter(url);
  if (adapter) {
    try {
      const result = await runAdapter(tabId, adapter);
      if (result?.abort) {
        // 确定性失败（登录墙/风控/不存在）：回明确错误，不退通用管线
        return { success: false, error: result.note || t('bg.pageUnfetchable') };
      }
      if (result) return { success: true, data: result };
      // 适配器不适用此页：退回通用管线
    } catch {
      const host = new URL(url).hostname;
      return {
        success: false,
        error: t('bg.noPermissionMenu'),
        data: { needsPermission: true, originPattern: `*://${host}/*` },
      };
    }
  }

  return withInjectedTab<WebCopyMdResult>(tabId, url, (id) =>
    sendToTab<WebCopyMdResult>(id, CONTENT_MSG.WEBCOPY_PAGE_TO_MD, {})
  );
}

/** 选区转 Markdown */
export function webcopySelectionMd(tabId: number, url: string) {
  trackWebcopy('selection');
  return withInjectedTab<WebCopyMdResult>(tabId, url, (id) =>
    sendToTab<WebCopyMdResult>(id, CONTENT_MSG.WEBCOPY_SELECTION_TO_MD, {})
  );
}

/** 解锁开关 */
export function webcopyToggleUnlock(tabId: number, url: string, enabled: boolean) {
  trackWebcopy('unlock');
  return withInjectedTab<{ enabled: boolean }>(tabId, url, (id) =>
    sendToTab<{ enabled: boolean }>(id, CONTENT_MSG.WEBCOPY_UNLOCK, {
      enabled,
    })
  );
}

/** 仅确保已注入（侧边栏打开自动复制开关时用） */
export function webcopyEnsure(tabId: number, url: string) {
  return withInjectedTab<WebCopyState>(tabId, url, (id) =>
    sendToTab<WebCopyState>(id, CONTENT_MSG.WEBCOPY_STATE, {})
  );
}

/**
 * 查询挂载状态：只 sendMessage 不注入。
 * 没有 content 接收方（从未激活）→ mounted=false，保持零侵入。
 */
export async function webcopyGetState(tabId: number | null): Promise<Response<WebCopyState>> {
  if (tabId == null) return { success: true, data: { mounted: false, unlocked: false } };
  try {
    const res = await sendToTab<WebCopyState>(tabId, CONTENT_MSG.WEBCOPY_STATE, {});
    if (res.success && res.data) return res;
  } catch {
    // 无接收方：未挂载
  }
  return { success: true, data: { mounted: false, unlocked: false } };
}

/** 标签页链接复制：SW 只拼串，剪贴板由发起方 UI 写 */
export async function copyTabs(
  scope: 'current' | 'all',
  format: TabCopyFormat
): Promise<Response<{ text: string; count: number }>> {
  trackWebcopy('tabs');
  const tabs = await chrome.tabs.query({
    currentWindow: true,
    ...(scope === 'current' ? { active: true } : {}),
  });
  const lines = tabs
    .filter((t) => t.url && !t.url.startsWith('chrome'))
    .map((t) => formatTab(t, format));
  if (lines.length === 0) {
    return { success: false, error: t('bg.noTabsToCopy') };
  }
  return { success: true, data: { text: lines.join('\n'), count: lines.length } };
}

function formatTab(tab: chrome.tabs.Tab, format: TabCopyFormat): string {
  const title = (tab.title || tab.url || '').trim();
  const url = tab.url || '';
  switch (format) {
    case 'markdown':
      return `[${title.replace(/[\[\]]/g, ' ')}](${url})`;
    case 'title-url':
      return `${title} - ${url}`;
    case 'title':
      return title;
    case 'url':
      return url;
  }
}
