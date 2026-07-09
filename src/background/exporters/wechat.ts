import type { DocInfo, Response } from '../../shared/types';
import { reportProgress } from '../progress';
import { resolveObjToken, fetchClientVars } from '../feishu-api';
import { buildBlockTree } from '../convert/adapter';
import { collectImageAssets, renderWechatHtml, getWechatTheme } from '../convert/wechat-html';
import { downloadImageDataUrls } from '../image-map';

/** 公众号导出的产物：HTML 字符串回传侧边栏，由侧边栏写剪贴板（手势在那边） */
export interface WechatResult {
  html: string;
  title: string;
}

/**
 * 复制为公众号格式（2026-07-09 方案 §四）：
 * 拉全文 → 建块树 → 下图内联 dataURL → 渲染内联样式 HTML → 回传侧边栏写剪贴板。
 *
 * 图片必须内联：公众号编辑器会把外链 <img> 整个丢掉；dataURL 粘贴时
 * 会被微信自动转存到图床。下载失败的图渲染占位灰字。
 */
export async function exportWechat(
  doc: DocInfo,
  themeId?: string
): Promise<Response<WechatResult>> {
  await reportProgress('wechat', 'running', '正在拉取文档内容...');

  try {
    const resolved = await resolveObjToken(doc);
    const cv = await fetchClientVars(resolved);
    const data = (cv.data ?? {}) as Record<string, unknown>;
    const tree = buildBlockTree(data, resolved.objToken);
    const title = resolved.title || doc.title || doc.token;

    const images = collectImageAssets(tree);
    let imageMap: Record<string, string | null> = {};
    if (images.length) {
      await reportProgress('wechat', 'running', `正在下载 ${images.length} 张图片...`, 10);
      imageMap = await downloadImageDataUrls(doc.host, images, (d, total) =>
        reportProgress(
          'wechat',
          'running',
          `正在下载图片 ${d}/${total}...`,
          10 + Math.round((d / total) * 80)
        )
      );
    }

    await reportProgress('wechat', 'running', '正在生成公众号格式...', 95);
    const html = renderWechatHtml(tree, imageMap, getWechatTheme(themeId));
    if (!html.trim()) throw new Error('文档没有可转换的内容');

    // 最终"已复制"提示由侧边栏在写完剪贴板后给出
    await reportProgress('wechat', 'success', '公众号格式已生成', 100);
    return { success: true, data: { html, title } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reportProgress('wechat', 'error', `公众号格式生成失败：${msg}`);
    return { success: false, error: msg };
  }
}
