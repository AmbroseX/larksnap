import type { DocInfo, Response } from '../../shared/types';
import { OFFSCREEN_MSG } from '../../shared/constants';
import { reportProgress } from '../progress';
import { resolveObjToken, fetchClientVars } from '../feishu-api';
import { blocksToXhsNodes } from '../xhs/build-nodes';
import type { XhsExportResult, XhsRenderRequest, XhsRenderResult } from '../xhs/types';
import { downloadImageDataUrls } from '../image-map';
import { withOffscreen } from '../offscreen';

/**
 * 生成小红书图文卡片（2026-07-09 方案）：
 * 拉全文 → 建卡片节点 → 下载图片内联 dataURL → offscreen 分页渲染截图。
 *
 * SW 只负责出图，PNG 回传侧边栏**预览**，用户确认后由侧边栏打包 zip 下载
 * （2026-07-09 三次迭代：导出前先预览再确认）。
 * 图片必须在 SW 侧下载成 dataURL 再交给离屏页，否则跨域图会污染 canvas
 * 导致 toDataURL 抛错（§十-2）。
 */
export async function exportXhs(
  doc: DocInfo,
  themeId?: string
): Promise<Response<XhsExportResult>> {
  await reportProgress('xhs', 'running', '正在拉取文档内容...');

  try {
    const resolved = await resolveObjToken(doc);
    const cv = await fetchClientVars(resolved);
    const data = (cv.data ?? {}) as Record<string, unknown>;
    const { nodes, images } = blocksToXhsNodes(data, resolved.objToken);
    if (!nodes.length) throw new Error('文档没有可导出的内容');
    const title = resolved.title || doc.title || doc.token;

    // 下载图片 → dataURL 映射；失败为 null，离屏页画占位灰块
    let imageMap: Record<string, string | null> = {};
    if (images.length) {
      await reportProgress('xhs', 'running', `正在下载 ${images.length} 张图片...`, 5);
      imageMap = await downloadImageDataUrls(doc.host, images, (d, total) =>
        reportProgress(
          'xhs',
          'running',
          `正在下载图片 ${d}/${total}...`,
          5 + Math.round((d / total) * 40)
        )
      );
    }

    await reportProgress('xhs', 'running', '正在生成卡片...', 45);
    const request: XhsRenderRequest = { title, nodes, imageMap, themeId };
    const pngs = await withOffscreen(() => renderInOffscreen(request));

    await reportProgress('xhs', 'success', `已生成 ${pngs.length} 张卡片，请预览确认`, 100);
    return { success: true, data: { title, pngs } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reportProgress('xhs', 'error', `小红书卡片导出失败：${msg}`);
    return { success: false, error: msg };
  }
}

/** 把渲染请求发给 offscreen 页，取回 PNG dataURL 数组 */
async function renderInOffscreen(request: XhsRenderRequest): Promise<string[]> {
  const res = (await chrome.runtime.sendMessage({
    type: OFFSCREEN_MSG.XHS_RENDER,
    data: request,
  })) as Response<XhsRenderResult> | undefined;
  if (!res) throw new Error('离屏渲染页无响应');
  if (!res.success || !res.data) throw new Error(res.error || '离屏渲染失败');
  if (!res.data.pngs.length) throw new Error('没有生成任何卡片');
  return res.data.pngs;
}
