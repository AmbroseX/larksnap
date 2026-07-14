import type { ActionId } from '../shared/types';
import { ensureI18n, onLanguageChanged, t, type TranslationKey } from '../shared/i18n';
import { detectDocFromUrl } from '../content/feishu-detect';
import { dispatchAction, type ActionPayload } from './actions-dispatch';

/**
 * 右键菜单（006，US2）：全部收敛在一个 LarkSnap 父菜单下。
 *   - 通用组：任何页面可见（对飞书页执行剪藏即走通用管线，不隐藏）
 *   - 飞书组：可见性跟随**当前标签页的文档识别结果**（URL 形态识别，
 *     detectDocFromUrl 对私有化域也认），切标签/页内跳转时动态 update。
 *     不再用 documentUrlPatterns 按域名列表显隐——"已信任域名"里混入普通
 *     网页域名时会把飞书导出项带到非飞书页上（点了必失败），按页识别没有此问题。
 *   - 重建时机：onInstalled / onStartup / 语言切换（removeAll+create 幂等）
 * 菜单 spec 由纯函数生成（buildMenuSpecs），便于单测断言集合。
 */

export const MENU_ROOT_ID = 'larksnap-root';

/** 菜单项 id → 动作 id（feishu-more 与 open-panel 同动作、不同菜单位） */
export const MENU_ACTION: Record<string, ActionId> = {
  'menu-feishu-md': 'feishu-md',
  'menu-feishu-pdf': 'feishu-pdf',
  'menu-feishu-html': 'feishu-html',
  'menu-feishu-more': 'open-panel',
  'menu-page-md': 'page-md',
  'menu-page-md-dl': 'page-md-download',
  'menu-selection-md': 'selection-md',
  'menu-ask-ai-sum': 'ask-ai-selection',
  'menu-ask-ai-translate': 'ask-ai-selection',
  'menu-screenshot': 'screenshot',
  'menu-screenshot-pdf': 'screenshot',
  'menu-summarize': 'summarize',
  'menu-unlock': 'unlock',
  'menu-open-panel': 'open-panel',
};

/** 个别菜单项的附加参数（截图 PDF 版与 PNG 版共用 screenshot 动作，仅格式不同） */
export const MENU_PAYLOAD: Record<string, ActionPayload> = {
  'menu-screenshot-pdf': { format: 'pdf' },
  'menu-ask-ai-sum': { selPrompt: 'summarize' },
  'menu-ask-ai-translate': { selPrompt: 'translate' },
};

/** 飞书专用组（只在飞书文档页可见，可见性由 syncFeishuMenus 动态维护） */
export const FEISHU_MENU_IDS = [
  'menu-feishu-md',
  'menu-feishu-pdf',
  'menu-feishu-html',
  'menu-feishu-more',
] as const;

export interface MenuSpec {
  id: string;
  title: string;
  contexts: chrome.contextMenus.ContextType[];
  parentId?: string;
  /** 创建时的初始可见性（飞书组默认隐藏，等页面识别后再亮） */
  visible?: boolean;
}

/** 纯函数：当前页 URL → 飞书组是否可见（官方域直信，未知域靠路径+token 形态） */
export function feishuMenusVisible(url: string): boolean {
  return detectDocFromUrl(url).isFeishuDoc;
}

/** 纯函数：给定翻译函数，产出全部菜单描述（创建顺序即展示顺序） */
export function buildMenuSpecs(tf: (key: TranslationKey) => string): MenuSpec[] {
  const root = MENU_ROOT_ID;
  return [
    { id: root, title: tf('menu.root'), contexts: ['page', 'selection'] },
    // 飞书组在前：飞书页上导出动作置顶（非飞书页整组隐藏）
    { id: 'menu-feishu-md', title: tf('menu.feishuMd'), contexts: ['page'], parentId: root, visible: false },
    { id: 'menu-feishu-pdf', title: tf('menu.feishuPdf'), contexts: ['page'], parentId: root, visible: false },
    { id: 'menu-feishu-html', title: tf('menu.feishuHtml'), contexts: ['page'], parentId: root, visible: false },
    { id: 'menu-feishu-more', title: tf('menu.feishuMore'), contexts: ['page'], parentId: root, visible: false },
    // 通用组：任何页面常驻
    { id: 'menu-page-md', title: tf('menu.pageMd'), contexts: ['page'], parentId: root },
    { id: 'menu-page-md-dl', title: tf('menu.pageMdDl'), contexts: ['page'], parentId: root },
    { id: 'menu-selection-md', title: tf('menu.selectionMd'), contexts: ['selection'], parentId: root },
    // 问 AI（008）：只在有选区时出现，走对话页纯聊天通路，零授权
    { id: 'menu-ask-ai-sum', title: tf('menu.askAiSum'), contexts: ['selection'], parentId: root },
    { id: 'menu-ask-ai-translate', title: tf('menu.askAiTranslate'), contexts: ['selection'], parentId: root },
    { id: 'menu-screenshot', title: tf('menu.screenshot'), contexts: ['page'], parentId: root },
    { id: 'menu-screenshot-pdf', title: tf('menu.screenshotPdf'), contexts: ['page'], parentId: root },
    { id: 'menu-summarize', title: tf('menu.summarize'), contexts: ['page'], parentId: root },
    { id: 'menu-unlock', title: tf('menu.unlock'), contexts: ['page', 'selection'], parentId: root },
    { id: 'menu-open-panel', title: tf('menu.openPanel'), contexts: ['page', 'selection'], parentId: root },
  ];
}

/** 把飞书组可见性同步为给定 URL 的识别结果（update 失败忽略：菜单可能正在重建） */
async function syncFeishuMenus(url: string): Promise<void> {
  const visible = feishuMenusVisible(url);
  await Promise.all(
    FEISHU_MENU_IDS.map(
      (id) =>
        new Promise<void>((resolve) => {
          chrome.contextMenus.update(id, { visible }, () => {
            void chrome.runtime.lastError;
            resolve();
          });
        })
    )
  );
}

/** 取当前聚焦窗口的活动页并同步飞书组可见性（SW 冷启动 / 窗口切换时兜底） */
async function syncFeishuMenusFromActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs
    .query({ active: true, lastFocusedWindow: true })
    .catch(() => [] as chrome.tabs.Tab[]);
  await syncFeishuMenus(tab?.url || '');
}

/** removeAll + create 幂等重建（标题取当前语言），重建后按当前活动页同步飞书组 */
export async function registerMenus(): Promise<void> {
  await ensureI18n();
  const specs = buildMenuSpecs(t);
  chrome.contextMenus.removeAll(() => {
    for (const spec of specs) {
      chrome.contextMenus.create({ ...spec });
    }
    void syncFeishuMenusFromActiveTab();
  });
}

/** SW 启动时调用一次（MV3 监听器必须在模块顶层同步注册） */
export function setupContextMenus(): void {
  chrome.runtime.onInstalled.addListener(() => void registerMenus());
  chrome.runtime.onStartup.addListener(() => void registerMenus());
  // 设置页切换语言 → 用新语言重建
  onLanguageChanged(() => void registerMenus());

  // 飞书组可见性跟随当前页：切标签 / 页内跳转（SPA）/ 切窗口都要同步
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    chrome.tabs
      .get(tabId)
      .then((tab) => syncFeishuMenus(tab.url || ''))
      .catch(() => {});
  });
  chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
    if (tab.active && (info.url || info.status === 'complete')) {
      void syncFeishuMenus(tab.url || '');
    }
  });
  chrome.windows?.onFocusChanged?.addListener((windowId) => {
    if (windowId !== chrome.windows.WINDOW_ID_NONE) void syncFeishuMenusFromActiveTab();
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    const action = MENU_ACTION[String(info.menuItemId)];
    if (!action || !tab?.id) return;
    const tabId = tab.id;
    const url = info.pageUrl || tab.url || '';
    // sidePanel.open 必须留在手势的同步调用栈内（await 之后调用会被浏览器拒绝）
    if (action === 'open-panel' || action === 'summarize' || action === 'ask-ai-selection') {
      chrome.sidePanel.open({ tabId }).catch(() => {});
      if (action === 'open-panel') return;
    }
    // 受限页不预先拦截：让动作自然失败并落角标+任务记录（可感知，不静默）
    let payload = MENU_PAYLOAD[String(info.menuItemId)];
    // 问 AI：选中文字只在点击瞬间可取，动态注入 payload
    if (action === 'ask-ai-selection') {
      payload = { ...payload, selectionText: info.selectionText || '' };
    }
    void ensureI18n().then(() =>
      dispatchAction(action, { tabId, url, source: 'menu' }, payload)
    );
  });
}
