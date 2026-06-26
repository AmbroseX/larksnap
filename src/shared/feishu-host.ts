import { FEISHU_HOSTS } from './constants';

/**
 * 推导"基础域"——媒体/导出下载域的拼接基准。
 *
 * - 公有云：命中已知后缀，基础域 = 该后缀（如 `my.feishu.cn` → `feishu.cn`）。
 * - 私有化：去掉最左侧的租户子域（如 `example-tenant.corp.example.com` → `corp.example.com`）。
 *
 * ⚠️ 宪法原则 II：绝不硬编码具体飞书域名作为唯一目标，统一由当前页面 host 推导。
 */
export function baseDomain(host: string): string {
  const known = FEISHU_HOSTS.find((h) => host === h || host.endsWith(`.${h}`));
  if (known) return known;

  // 私有化：≥3 段时去掉最左侧租户子域，否则原样返回
  const labels = host.split('.');
  if (labels.length >= 3) return labels.slice(1).join('.');
  return host;
}

/**
 * 媒体/导出文件的下载流域名：`internal-api-drive-stream.{基础域}`。
 * 实测：example-corp 私有化 → `internal-api-drive-stream.corp.example.com`；
 *       公有云 → `internal-api-drive-stream.feishu.cn`。
 */
export function driveStreamHost(host: string): string {
  return `internal-api-drive-stream.${baseDomain(host)}`;
}

/** 从完整 URL 取 origin（含协议），用于权限申请与同源判断 */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** 从完整 URL 取 host */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * 私有化授权用的 host 权限 match pattern —— **按基础域通配**，一次性覆盖
 * 页面域与图片/导出下载域(`internal-api-drive-stream.{基础域}`)。
 * 例：`example-tenant.corp.example.com` → `*://*.corp.example.com/*`。
 *
 * ⚠️ 图片在 drive-stream 子域(跨子域),只授页面 origin 会被 CORS 拦,必须授基础域通配。
 */
export function permissionPattern(host: string): string {
  return `*://*.${baseDomain(host)}/*`;
}
