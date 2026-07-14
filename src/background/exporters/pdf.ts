import type { DocInfo, DocToPdfRequest, DocToPdfResult, Response } from '../../shared/types';
import { t } from '../../shared/i18n';
import { marked } from 'marked';
import { OFFSCREEN_MSG } from '../../shared/constants';
import { reportProgress } from '../progress';
import { resolveObjToken, fetchClientVars } from '../feishu-api';
import {
  runExportTask,
  ExportDisabledError,
  NotLoggedInError,
} from './export-task';
import { blocksToMarkdown } from '../convert/markdown';
import { downloadImageDataUrls } from '../image-map';
import { extractWhiteboards } from './whiteboard';
import { withOffscreen } from '../offscreen';
import { downloadBase64, downloadDataUrl, safeName } from '../download';

/** A4 内容区渲染宽度（px，约 A4 @96dpi 去掉页边距），offscreen 按它排版再切页 */
const A4_CONTENT_WIDTH = 794;

/** 1×1 透明 PNG dataURL：图片下载失败时占位，避免渲染出裂图图标 */
const TRANSPARENT_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/**
 * 导出为 PDF —— 先走飞书官方导出任务（服务端渲染，质量最稳，§5.2）；
 * 官方关闭 / 未登录（公开文档匿名）时**回退 md→pdf**：解码正文自渲染，离屏截图切成多页 PDF。
 */
export async function exportPdf(doc: DocInfo): Promise<Response> {
  await reportProgress('pdf', 'running', t('progress.pdf.creating'), 15);

  try {
    const resolved = await resolveObjToken(doc);
    await reportProgress('pdf', 'running', t('progress.pdf.waiting'), 50);

    const result = await runExportTask(
      resolved.objToken,
      'pdf',
      doc.host,
      resolved.objToken
    );
    await reportProgress('pdf', 'running', t('progress.pdf.downloading'), 85);

    const title = resolved.title || doc.title || doc.token;
    await downloadBase64(
      result.base64,
      result.mimeType || 'application/pdf',
      `${safeName(title)}.pdf`
    );

    await reportProgress('pdf', 'success', t('progress.pdf.done'), 100);
    return { success: true };
  } catch (err) {
    // 官方关闭 / 未登录：回退 md→pdf（解码正文自渲染）。未登录时带 hint，解码也读不到才提示登录。
    if (err instanceof ExportDisabledError) {
      return exportPdfViaDecode(doc);
    }
    if (err instanceof NotLoggedInError) {
      return exportPdfViaDecode(doc, err.message);
    }
    const msg = err instanceof Error ? err.message : String(err);
    await reportProgress('pdf', 'error', t('progress.pdf.failed', { msg }));
    return { success: false, error: msg };
  }
}

/**
 * md→pdf 回退：解码 client_vars → Markdown → HTML，图片/画板内联，
 * 交离屏页渲染截图切成多页 PDF。与 Markdown/HTML 导出同源（自渲染，不依赖官方导出）。
 */
async function exportPdfViaDecode(doc: DocInfo, loginHint?: string): Promise<Response> {
  try {
    await reportProgress('pdf', 'running', t('progress.pdf.viaMarkdown'), 20);
    const resolved = await resolveObjToken(doc);
    const cv = await fetchClientVars(resolved);
    const data = (cv.data ?? {}) as Record<string, unknown>;
    const { markdown, images, sheetBlocks, whiteboards } = blocksToMarkdown(
      data,
      resolved.objToken
    );

    // 解码也一无所获（多半是私有文档 + 未登录读不到）：官方那条来的就提示登录，别出空 PDF
    if (
      !markdown.trim() &&
      images.length === 0 &&
      sheetBlocks.length === 0 &&
      whiteboards.length === 0
    ) {
      const msg = loginHint || t('progress.pdf.emptyDoc');
      await reportProgress('pdf', 'error', msg);
      return { success: false, error: msg };
    }

    let md = markdown;
    const title = resolved.title || doc.title || doc.token;

    // 内嵌 sheet 占位 → 源表链接（PDF 路径不取单元格，同 HTML 导出）
    for (const ref of sheetBlocks) {
      md = md
        .split(`feishu-sheet-block://${ref.blockId}`)
        .join(
          `[${t('progress.markdown.viewEmbeddedSheet')}](https://${doc.host}/sheets/${ref.shtToken}?sheet=${ref.subId})`
        );
    }

    // 图片下载为 dataURL —— 关键：**先不塞进 md**。把几百 KB 的 base64 塞进 markdown 再
    // 喂 marked，会让内联词法器爆栈（Maximum call stack）。故照 HTML 导出的做法：md 里保留短
    // 占位符过 marked，解析成 HTML 后再把占位符换成 dataURL（长串只在最终 HTML 里出现一次）。
    let imgDataUrls: Record<string, string | null> = {};
    if (images.length) {
      await reportProgress(
        'pdf',
        'running',
        t('progress.common.downloadingImages', { n: images.length }),
        35
      );
      imgDataUrls = await downloadImageDataUrls(doc.host, images, (d, total) =>
        reportProgress(
          'pdf',
          'running',
          t('progress.common.downloadingImage', { done: d, total }),
          35 + Math.round((d / total) * 35)
        )
      );
    }

    // 画板：注入页面抓 canvas 转 PNG。同样 dataURL 不进 md——把裸占位改成带短占位 src 的
    // 图片语法（抓到才转，抓不到移除），dataURL 留到解析后替换。
    let wbMap: Record<string, string | null> = {};
    if (whiteboards.length) {
      await reportProgress(
        'pdf',
        'running',
        t('progress.markdown.readingWhiteboards', { n: whiteboards.length }),
        72
      );
      try {
        wbMap = await extractWhiteboards(whiteboards);
      } catch (e) {
        console.warn('[larksnap] 画板抓取失败，PDF 里略过:', e);
      }
      for (const ref of whiteboards) {
        const placeholder = `feishu-whiteboard-block://${ref.blockId}`;
        md = md
          .split(placeholder)
          .join(wbMap[ref.blockId] ? `![${t('progress.markdown.whiteboardAlt')}](${placeholder})` : '');
      }
    }

    await reportProgress('pdf', 'running', t('progress.pdf.rendering'), 90);
    // 短占位符过 marked，再把占位符换成 dataURL（失败图用透明占位，别裂图）
    let body = await marked.parse(md);
    for (const img of images) {
      body = body
        .split(`feishu-asset://${img.token}`)
        .join(imgDataUrls[img.token] ?? TRANSPARENT_PNG);
    }
    for (const ref of whiteboards) {
      const url = wbMap[ref.blockId];
      if (url) body = body.split(`feishu-whiteboard-block://${ref.blockId}`).join(url);
    }
    const html = buildPrintHtml(title, body);

    const { dataUrl, truncated } = await withOffscreen(() =>
      renderPdfInOffscreen({ html, cssWidth: A4_CONTENT_WIDTH })
    );
    await downloadDataUrl(dataUrl, `${safeName(title)}.pdf`);

    await reportProgress(
      'pdf',
      'success',
      truncated ? t('progress.pdf.doneTruncated') : t('progress.pdf.done'),
      100
    );
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reportProgress('pdf', 'error', t('progress.pdf.failed', { msg }));
    return { success: false, error: msg };
  }
}

/** 把 md→pdf 请求发给离屏页，取回多页 PDF 的 dataURL */
async function renderPdfInOffscreen(req: DocToPdfRequest): Promise<DocToPdfResult> {
  const res = (await chrome.runtime.sendMessage({
    type: OFFSCREEN_MSG.DOC_TO_PDF,
    data: req,
  })) as Response<DocToPdfResult> | undefined;
  if (!res) throw new Error(t('progress.pdf.offscreenNoResponse'));
  if (!res.success || !res.data) throw new Error(res.error || t('progress.pdf.renderFailed'));
  return res.data;
}

/** 打印友好的正文 HTML（内联样式，html2canvas 按计算样式截图；宽度由离屏容器控制） */
function buildPrintHtml(title: string, body: string): string {
  const safeTitle = title.replace(/[<>&]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'
  );
  return `<style>
  .doc { box-sizing: border-box; padding: 32px 36px; font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', 'Segoe UI', sans-serif; font-size: 15px; line-height: 1.75; color: #1f2329; background: #fff; word-break: break-word; }
  .doc h1 { font-size: 26px; }
  .doc h1, .doc h2, .doc h3, .doc h4 { line-height: 1.35; margin: 1.2em 0 0.6em; font-weight: 700; }
  .doc h2 { font-size: 21px; } .doc h3 { font-size: 18px; } .doc h4 { font-size: 16px; }
  .doc p { margin: 0.6em 0; }
  .doc ul, .doc ol { padding-left: 1.6em; margin: 0.6em 0; }
  .doc li { margin: 0.25em 0; }
  .doc img { max-width: 100%; height: auto; display: block; margin: 0.6em 0; }
  .doc pre { background: #f5f6f7; border-radius: 6px; padding: 12px 14px; overflow-x: auto; font-size: 13px; line-height: 1.6; font-family: Consolas, Monaco, 'Courier New', monospace; white-space: pre-wrap; word-break: break-all; }
  .doc code { background: #f5f6f7; border-radius: 4px; padding: 1px 5px; font-size: 0.9em; font-family: Consolas, Monaco, 'Courier New', monospace; }
  .doc pre code { background: none; padding: 0; }
  .doc blockquote { margin: 0.6em 0; padding: 2px 0 2px 14px; border-left: 3px solid #d0d3d6; color: #646a73; }
  .doc table { border-collapse: collapse; width: 100%; margin: 0.8em 0; font-size: 13.5px; }
  .doc th, .doc td { border: 1px solid #d0d3d6; padding: 6px 10px; text-align: left; }
  .doc th { background: #f5f6f7; }
  .doc a { color: #245bdb; text-decoration: none; }
  .doc hr { border: none; border-top: 1px solid #e5e6eb; margin: 1.2em 0; }
  .doc .doc-title { font-size: 28px; font-weight: 700; margin: 0 0 0.4em; }
</style>
<div class="doc"><div class="doc-title">${safeTitle}</div>${body}</div>`;
}
