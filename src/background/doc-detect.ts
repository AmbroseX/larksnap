import type { DocInfo } from '../shared/types';
import { CONTENT_MSG } from '../shared/constants';
import { detectDocFromUrl, stripSiteSuffix } from '../content/feishu-detect';
import { hostOf } from '../shared/feishu-host';
import { hasPermissionForHost } from './permissions';

/** 获取当前活跃 Tab */
export async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

/**
 * 识别当前活跃 Tab 的飞书文档信息。
 *
 * 流程（§4.4 交互）：
 *   1. 先用**纯 URL** 识别（无需注入，故未授权的私有化域名也能判出 isPrivateDeploy）
 *   2. 非飞书页 → 直接返回（isFeishuDoc=false）
 *   3. 私有化且未授权该 origin → 返回 needsAuth=true，由 UI 引导用户手势授权
 *   4. 已授权 → 注入 content 取完整信息（含 DOM 标题）
 */
export async function detectActiveDoc(): Promise<DocInfo | null> {
  const tab = await getActiveTab();
  if (!tab?.id || !tab.url) return null;

  const urlInfo = detectDocFromUrl(tab.url);
  if (!urlInfo.isFeishuDoc) {
    // 普通网页也判一次域名授权：侧边栏据此显示「授权访问该域名」入口
    //（桥接后台抓取无用户手势，权限必须提前在侧边栏授好）
    if (/^https?:/i.test(tab.url) && !(await hasPermissionForHost(hostOf(tab.url)))) {
      return { ...urlInfo, needsAuth: true };
    }
    return urlInfo;
  }

  // 标签页标题兜底：DOM 取不到标题时至少还有网页名，避免文件名退化成 token
  if (tab.title) urlInfo.title = stripSiteSuffix(tab.title);

  const granted = await hasPermissionForHost(hostOf(tab.url));
  if (!granted) {
    return { ...urlInfo, needsAuth: true };
  }

  // 已授权：注入 content 取完整 DocInfo（标题等）
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });
    const full = (await chrome.tabs.sendMessage(tab.id, {
      type: CONTENT_MSG.DETECT_DOC,
    })) as DocInfo | undefined;
    if (full?.isFeishuDoc) {
      if (!full.title) full.title = urlInfo.title;
      return full;
    }
    return urlInfo;
  } catch {
    // 注入失败（如尚未生效的权限）：退回 URL 信息
    return urlInfo;
  }
}
