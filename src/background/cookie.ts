/**
 * 读取 Cookie —— 唯一允许在 Service Worker 触碰飞书登录态的入口。
 * content script 无法读 HttpOnly 的 `_csrf_token`，故由它发 GET_COOKIE 消息，
 * SW 用 `chrome.cookies.get`（基于发起 tab 的 url）代读。
 *
 * ⚠️ 宪法原则 I：SW 仅读 Cookie，绝不直接 fetch 飞书内部接口。
 */
export async function getCookie(
  name: string,
  url: string
): Promise<string | null> {
  if (!url) return null;
  try {
    const c = await chrome.cookies.get({ name, url });
    return c?.value ?? null;
  } catch {
    return null;
  }
}
