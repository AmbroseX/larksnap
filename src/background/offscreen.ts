/**
 * offscreen document 管理器（§十-4）：Chrome 同一时刻只允许一个 offscreen 页，
 * 所有要用离屏 DOM 的功能都经这里串行调度，用完即关、不常驻。
 */

let queue: Promise<unknown> = Promise.resolve();

/** 在独占的 offscreen document 里执行 task，前后自动创建/关闭，多任务排队 */
export function withOffscreen<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    await createOffscreen();
    try {
      return await task();
    } finally {
      await chrome.offscreen.closeDocument().catch(() => {});
    }
  });
  // 队列吞掉错误往下走，调用方仍拿到自己的 reject
  queue = run.catch(() => {});
  return run;
}

async function createOffscreen(): Promise<void> {
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.DOM_PARSER],
      justification: '在隐藏页面渲染导出内容并截图（Service Worker 无 DOM）',
    });
  } catch (err) {
    // 上一次异常退出可能残留实例：关掉重建，保证拿到干净页面
    if (/single offscreen/i.test(String(err))) {
      await chrome.offscreen.closeDocument().catch(() => {});
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.DOM_PARSER],
        justification: '在隐藏页面渲染导出内容并截图（Service Worker 无 DOM）',
      });
      return;
    }
    throw err;
  }
}
