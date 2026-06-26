import {
  addTrustedDomain,
  removeTrustedDomain,
  getTrustedDomains,
} from '../shared/storage';
import { permissionPattern } from '../shared/feishu-host';

/**
 * 私有化域名的 host 权限管理（配合 `optional_host_permissions`，§4.4）。
 *
 * ⚠️ `chrome.permissions.request` 必须由**用户手势**触发，故真正的 request()
 * 在侧边栏 UI 的点击处理里调用；SW 这里只负责查询(contains)、撤销(remove)
 * 与"已信任域名"列表的持久化。
 *
 * 授权粒度按**基础域通配**(`*://*.{基础域}/*`)，一次性覆盖页面域 + 图片/导出
 * 下载子域(`internal-api-drive-stream.*`)，避免跨子域图片下载被 CORS 拦。
 */

/** 当前文档 host 对应的基础域是否已授权 */
export async function hasPermissionForHost(host: string): Promise<boolean> {
  if (!host) return false;
  try {
    return await chrome.permissions.contains({
      origins: [permissionPattern(host)],
    });
  } catch {
    return false;
  }
}

/** UI 授权成功后调用：持久化授权的 match pattern 到"已信任域名" */
export async function recordTrusted(pattern: string): Promise<void> {
  if (pattern) await addTrustedDomain(pattern);
}

/** 撤销某 match pattern 的授权（设置页用） */
export async function revokePermission(pattern: string): Promise<boolean> {
  try {
    await chrome.permissions.remove({ origins: [pattern] });
  } catch {
    /* 公有云静态权限无法 remove，忽略 */
  }
  await removeTrustedDomain(pattern);
  return true;
}

/** 列出已信任的授权 pattern */
export async function listTrusted(): Promise<string[]> {
  return getTrustedDomains();
}
