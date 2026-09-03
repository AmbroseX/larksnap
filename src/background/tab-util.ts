import { t } from '../shared/i18n';
/** 标签页工具 —— bridge（抓取任务）与 editor（编辑任务）共用。 */

/**
 * 等标签页加载完成（飞书为 SPA，complete 后再宽限一会儿让页面上下文就绪）。
 *
 * 超时给 60 秒：大文档 + 重型 policy-sdk 的页面在**后台标签页**里加载本来就慢
 * （浏览器给不可见标签页降优先级），原来的 30 秒不够，会把「页面还在加载」
 * 误报成失败。见 docs/plans/2026-09-03-大表格文档抓取超时修复.md。
 */
export function waitForTabComplete(tabId: number, timeoutMs = 60000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete') {
          setTimeout(resolve, 1500); // SPA 渲染/cookie 就绪宽限
          return;
        }
      } catch {
        reject(new Error(t('bg.tabClosed')));
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(t('bg.openDocTimeout')));
        return;
      }
      setTimeout(tick, 300);
    };
    void tick();
  });
}
