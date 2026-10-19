/**
 * MV3 Service Worker 保活：Chrome 在 30 秒内没有事件、没有扩展接口调用时会把 SW 回收，
 * 正在跑的 JS 一起被杀，没有任何回调。导出打 zip、几百张图逐张内联这类长活中间
 * 没有扩展接口调用，就会撞上这条线（issue #9）。
 *
 * 办法是任务期间每 20 秒调一次无副作用的扩展接口，把空闲计时重置掉
 * （Chrome 110+ 官方说明接口调用会重置计时；getPlatformInfo 轮询是通行做法）。
 * 任务结束立刻清掉定时器，不让 SW 常驻。
 *
 * 注意：这只解决 30 秒空闲线，解决不了单个请求 5 分钟的硬顶。
 */

const PING_INTERVAL_MS = 20_000;

/** 在 run 执行期间保持 SW 活着；run 结束（含抛错）后停止保活 */
export async function withKeepAlive<T>(run: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => {
    // 返回值不关心，调用本身就是目的；SW 正在关闭时可能 reject，吞掉
    void chrome.runtime.getPlatformInfo().catch(() => {});
  }, PING_INTERVAL_MS);
  try {
    return await run();
  } finally {
    clearInterval(timer);
  }
}
