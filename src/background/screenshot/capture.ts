/**
 * 逐屏抓取（SW 侧编排）：滚动页面 + 逐屏 chrome.tabs.captureVisibleTab。
 * 明确不用浏览器调试器协议（attach 会弹「正在调试此浏览器」黄条）。
 * 抓完的每屏 dataURL + CSS 偏移交给 offscreen 拼接。
 */

import type { CaptureShot } from '../../shared/types';
import { t } from '../../shared/i18n';
import { preparePage, frameStep, scrollDown, restorePage } from './page';

/** captureVisibleTab 撞到每秒配额错误后的重试参数（GoFullPage 用 50ms 轮询，比死等 1 秒快） */
const CAPTURE_RETRY_LIMIT = 20;
const CAPTURE_RETRY_MS = 50;
/** 注入禁动画后等页面稳定的时间 */
const STABILIZE_MS = 800;
/** 每屏滚动后等重绘稳定的时间 */
const FRAME_SETTLE_MS = 300;
/** 屏数硬上限，防无限滚动页把循环卡死 */
const MAX_FRAMES = 200;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 逐屏抓取结果 */
export interface CaptureResult {
  shots: CaptureShot[];
  /** 视口 CSS 宽度（offscreen 反推缩放系数用） */
  viewportCssWidth: number;
  /** 整页 CSS 高度 */
  totalHeightCss: number;
}

/** 在目标页注入并执行一个页面端纯函数，返回其结果 */
async function runFunc<Args extends unknown[], R>(
  tabId: number,
  func: (...args: Args) => R,
  ...args: Args
): Promise<R> {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  return res.result as R;
}

/**
 * 抓一屏。撞到 MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND 配额错误时 sleep 后重试；
 * 其他错误（多为 activeTab 权限失效）直接抛给上层给出明确提示，不静默失败。
 */
export async function safeCaptureVisibleTab(windowId: number): Promise<string> {
  for (let i = 0; i < CAPTURE_RETRY_LIMIT; i++) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/MAX_CAPTURE/i.test(msg)) {
        await sleep(CAPTURE_RETRY_MS);
        continue;
      }
      throw new Error(t('progress.screenshot.captureFailed', { msg }));
    }
  }
  throw new Error(t('progress.screenshot.rateLimited'));
}

/**
 * 整页逐屏抓取主循环：
 * 准备页面 → 等稳定 → 逐屏(测量 + 抓屏 + 下滚) → 直到最后一屏 → finally 恢复现场。
 * 恢复放 finally，任何异常路径都保证页面滚动位置与悬浮元素还原（SC-004）。
 */
export async function captureFullPage(
  tab: chrome.tabs.Tab,
  onFrame: (frameNo: number) => void
): Promise<CaptureResult> {
  const tabId = tab.id!;
  const windowId = tab.windowId;

  const prep = await runFunc(tabId, preparePage);
  const origScrollY = prep.origScrollY;
  await sleep(STABILIZE_MS);

  const shots: CaptureShot[] = [];
  let viewportCssWidth = prep.innerWidth;
  let totalHeightCss = prep.scrollHeight;

  try {
    let frameIndex = 0;
    let done = false;
    while (!done) {
      const info = await runFunc(tabId, frameStep, frameIndex);
      done = info.isLast;
      viewportCssWidth = info.innerWidth;
      totalHeightCss = info.docHeight;

      await sleep(FRAME_SETTLE_MS);
      onFrame(frameIndex + 1);
      const dataUrl = await safeCaptureVisibleTab(windowId);
      shots.push({ dataUrl, yPos: info.yPos });

      if (!done) {
        await runFunc(tabId, scrollDown);
        frameIndex++;
        if (frameIndex >= MAX_FRAMES) break;
      }
    }
  } finally {
    await runFunc(tabId, restorePage, origScrollY).catch(() => {});
  }

  return { shots, viewportCssWidth, totalHeightCss };
}
