/** 标签页工具 —— bridge（抓取任务）与 editor（编辑任务）共用。 */

/** 等标签页加载完成（飞书为 SPA，complete 后再宽限一会儿让页面上下文就绪）。 */
export function waitForTabComplete(tabId: number, timeoutMs = 30000): Promise<void> {
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
        reject(new Error('标签页已关闭'));
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error('打开文档超时'));
        return;
      }
      setTimeout(tick, 300);
    };
    void tick();
  });
}
