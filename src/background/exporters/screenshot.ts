/**
 * 整页截图编排（SW 侧入口）：取当前标签页 → 逐屏抓取 → offscreen 拼接 → 落盘。
 * 与飞书导出通道完全解耦：对任意 http/https 页面生效，不碰飞书取数逻辑（SC-006）。
 */

import type {
  Response,
  ScreenshotFormat,
  ShotStitchRequest,
  ShotStitchResult,
} from '../../shared/types';
import { OFFSCREEN_MSG } from '../../shared/constants';
import { t } from '../../shared/i18n';
import { reportProgress } from '../progress';
import { withOffscreen } from '../offscreen';
import { downloadDataUrl, safeName } from '../download';
import { captureFullPage } from '../screenshot/capture';

/** tabId 由调用方在触发瞬间捕获并显式传入（006：禁止在此重查活动页） */
export async function exportScreenshot(format: ScreenshotFormat, tabId: number): Promise<Response> {
  await reportProgress('screenshot', 'running', t('progress.screenshot.preparing'));
  // 缺主机权限时回给侧边栏做手势内授权重试用（catch 里要用，故提前拿）
  let originPattern = '';
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.id) throw new Error(t('progress.screenshot.noTab'));
    const url = tab.url || '';
    // chrome:// / 扩展商店等不可注入页直接友好报错，不静默失败（FR-001）
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(t('progress.screenshot.unsupportedPage'));
    }
    originPattern = `*://${new URL(url).hostname}/*`;

    // 逐屏抓取（capture 内部 finally 已保证页面现场恢复）
    const cap = await captureFullPage(tab, (n) =>
      reportProgress('screenshot', 'running', t('progress.screenshot.capturing', { n }))
    );
    if (!cap.shots.length) throw new Error(t('progress.screenshot.nothingCaptured'));

    await reportProgress('screenshot', 'running', t('progress.screenshot.stitching'), 90);
    const request: ShotStitchRequest = {
      shots: cap.shots,
      format,
      viewportCssWidth: cap.viewportCssWidth,
      totalHeightCss: cap.totalHeightCss,
    };
    const result = await withOffscreen(() => stitchInOffscreen(request));

    const base = safeName(tab.title || t('progress.screenshot.defaultName'));
    const ext = format === 'pdf' ? 'pdf' : 'png';
    await downloadDataUrl(result.dataUrl, `${base}.${ext}`);

    const msg = result.truncated
      ? t('progress.screenshot.savedTruncated', { n: cap.shots.length })
      : t('progress.screenshot.saved');
    await reportProgress('screenshot', 'success', msg, 100);
    return { success: true, data: { truncated: !!result.truncated } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // captureVisibleTab 缺 activeTab/主机权限：侧边栏点按钮的手势不给网页页授 activeTab，
    // 走 needsPermission 让侧边栏在同一手势里 permissions.request 后重试（同 webcopy 辅路径）。
    if (originPattern && /all_urls|activeTab/i.test(msg)) {
      await reportProgress('screenshot', 'error', t('progress.screenshot.needAuth'));
      return {
        success: false,
        error: t('progress.screenshot.needAuth'),
        data: { needsPermission: true, originPattern },
      };
    }
    await reportProgress('screenshot', 'error', t('progress.screenshot.failed', { msg }));
    return { success: false, error: msg };
  }
}

/** 把拼接请求发给 offscreen 页，取回长图/PDF 的 dataURL */
async function stitchInOffscreen(request: ShotStitchRequest): Promise<ShotStitchResult> {
  const res = (await chrome.runtime.sendMessage({
    type: OFFSCREEN_MSG.SHOT_STITCH,
    data: request,
  })) as Response<ShotStitchResult> | undefined;
  if (!res) throw new Error(t('progress.screenshot.offscreenNoResponse'));
  if (!res.success || !res.data) throw new Error(res.error || t('progress.screenshot.offscreenFailed'));
  return res.data;
}
