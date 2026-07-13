import type { ActionId } from '../shared/types';
import { FEISHU_HOSTS } from '../shared/constants';
import { ensureI18n, onLanguageChanged, t, type TranslationKey } from '../shared/i18n';
import { getConfig } from '../shared/storage';
import { dispatchAction } from './actions-dispatch';

/**
 * 右键菜单（006，US2）：全部收敛在一个 LarkSnap 父菜单下。
 *   - 通用组：任何页面可见（对飞书页执行剪藏即走通用管线，不隐藏）
 *   - 飞书组：documentUrlPatterns = 官方三域 + 已授权私有化域，仅飞书页可见
 *   - 重建时机：onInstalled / onStartup / 语言切换 / 授权增删（removeAll+create 幂等）
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
  'menu-selection-md': 'selection-md',
  'menu-screenshot': 'screenshot',
  'menu-summarize': 'summarize',
  'menu-unlock': 'unlock',
  'menu-open-panel': 'open-panel',
};

export interface MenuSpec {
  id: string;
  title: string;
  contexts: chrome.contextMenus.ContextType[];
  parentId?: string;
  documentUrlPatterns?: string[];
}

/** 飞书组的 URL 匹配：官方三域（公有云回退分支，宪法 II）+ 运行时授权的私有化域 pattern */
export function feishuUrlPatterns(trustedDomains: string[]): string[] {
  return [...FEISHU_HOSTS.map((h) => `*://*.${h}/*`), ...trustedDomains];
}

/** 纯函数：给定翻译函数与已授权域，产出全部菜单描述（创建顺序即展示顺序） */
export function buildMenuSpecs(
  tf: (key: TranslationKey) => string,
  trustedDomains: string[]
): MenuSpec[] {
  const feishuPatterns = feishuUrlPatterns(trustedDomains);
  const root = MENU_ROOT_ID;
  return [
    { id: root, title: tf('menu.root'), contexts: ['page', 'selection'] },
    // 飞书组在前：飞书页上导出动作置顶（非飞书页整组隐藏）
    { id: 'menu-feishu-md', title: tf('menu.feishuMd'), contexts: ['page'], parentId: root, documentUrlPatterns: feishuPatterns },
    { id: 'menu-feishu-pdf', title: tf('menu.feishuPdf'), contexts: ['page'], parentId: root, documentUrlPatterns: feishuPatterns },
    { id: 'menu-feishu-html', title: tf('menu.feishuHtml'), contexts: ['page'], parentId: root, documentUrlPatterns: feishuPatterns },
    { id: 'menu-feishu-more', title: tf('menu.feishuMore'), contexts: ['page'], parentId: root, documentUrlPatterns: feishuPatterns },
    // 通用组：任何页面常驻
    { id: 'menu-page-md', title: tf('menu.pageMd'), contexts: ['page'], parentId: root },
    { id: 'menu-selection-md', title: tf('menu.selectionMd'), contexts: ['selection'], parentId: root },
    { id: 'menu-screenshot', title: tf('menu.screenshot'), contexts: ['page'], parentId: root },
    { id: 'menu-summarize', title: tf('menu.summarize'), contexts: ['page'], parentId: root },
    { id: 'menu-unlock', title: tf('menu.unlock'), contexts: ['page', 'selection'], parentId: root },
    { id: 'menu-open-panel', title: tf('menu.openPanel'), contexts: ['page', 'selection'], parentId: root },
  ];
}

/** removeAll + create 幂等重建（标题取当前语言，域 pattern 取当前授权） */
export async function registerMenus(): Promise<void> {
  await ensureI18n();
  const config = await getConfig();
  const specs = buildMenuSpecs(t, config.trustedDomains ?? []);
  chrome.contextMenus.removeAll(() => {
    for (const spec of specs) {
      chrome.contextMenus.create({ ...spec });
    }
  });
}

/** SW 启动时调用一次（MV3 监听器必须在模块顶层同步注册） */
export function setupContextMenus(): void {
  chrome.runtime.onInstalled.addListener(() => void registerMenus());
  chrome.runtime.onStartup.addListener(() => void registerMenus());
  // 设置页切换语言 → 用新语言重建
  onLanguageChanged(() => void registerMenus());
  // 私有化域授权增删 → 更新飞书组 documentUrlPatterns
  //（同时覆盖侧边栏授权与用户在浏览器设置页手动改权限两条路径）
  chrome.permissions.onAdded?.addListener(() => void registerMenus());
  chrome.permissions.onRemoved?.addListener(() => void registerMenus());

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    const action = MENU_ACTION[String(info.menuItemId)];
    if (!action || !tab?.id) return;
    const tabId = tab.id;
    const url = info.pageUrl || tab.url || '';
    // sidePanel.open 必须留在手势的同步调用栈内（await 之后调用会被浏览器拒绝）
    if (action === 'open-panel' || action === 'summarize') {
      chrome.sidePanel.open({ tabId }).catch(() => {});
      if (action === 'open-panel') return;
    }
    // 受限页不预先拦截：让动作自然失败并落角标+任务记录（可感知，不静默）
    void ensureI18n().then(() => dispatchAction(action, { tabId, url, source: 'menu' }));
  });
}
