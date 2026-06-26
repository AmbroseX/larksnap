import type { DocInfo, Response } from '../../shared/types';
import { marked } from 'marked';
import { reportProgress } from '../progress';
import { resolveObjToken, fetchClientVars } from '../feishu-api';
import { downloadMedia } from '../feishu-proxy';
import { blocksToMarkdown } from '../convert/markdown';
import { downloadDataUrl, safeName } from '../download';
import { mediaDownloadUrls, onlineMediaUrl, mapWithConcurrency } from '../media-util';

/**
 * 导出为 HTML —— **从 client_vars 自渲染**（与 Markdown 同源），而非 DOM 快照。
 *
 * 为什么不抓 DOM：飞书 docx 是重度虚拟滚动，屏幕外的块会被卸载，DOM 克隆天生残缺、
 * 缺图。自渲染拿到的是完整全文 + 全部图片，与页面是否滚动/渲染无关。
 * 图片下载后内联为 data URL，产出**单文件 HTML**，离线可读、可直接打印成 PDF。
 */
export async function exportHtml(doc: DocInfo): Promise<Response> {
  await reportProgress('html', 'running', '正在拉取文档内容...');

  try {
    const resolved = await resolveObjToken(doc);
    const cv = await fetchClientVars(resolved);
    const data = (cv.data ?? {}) as Record<string, unknown>;
    const { markdown, images } = blocksToMarkdown(data, resolved.objToken);
    const title = resolved.title || doc.title || doc.token;

    // 下载图片 → token→URL 映射（成功内联 dataURL，失败降级在线 URL）
    const urlMap: Record<string, string> = {};
    if (images.length) {
      await reportProgress('html', 'running', `正在下载 ${images.length} 张图片...`);
      const results = await mapWithConcurrency(
        images,
        3,
        async (img) => {
          const blob = await downloadMedia(
            mediaDownloadUrls(doc.host, img.token, img.mountToken, {
              isImage: true,
              width: img.width,
              height: img.height,
            })
          );
          return { img, blob };
        },
        (d, total) =>
          reportProgress(
            'html',
            'running',
            `正在下载图片 ${d}/${total}...`,
            Math.round((d / total) * 95)
          )
      );
      for (let i = 0; i < images.length; i++) {
        const r = results[i];
        const img = images[i];
        urlMap[img.token] = r
          ? `data:${r.blob.mimeType || img.mimeType || 'image/png'};base64,${r.blob.base64}`
          : onlineMediaUrl(doc.host, img.token, img.mountToken, img.width, img.height);
      }
    }

    await reportProgress('html', 'running', '正在生成单文件 HTML...', 97);
    let body = await marked.parse(markdown);
    for (const [token, url] of Object.entries(urlMap)) {
      body = body.split(`feishu-asset://${token}`).join(url);
    }

    const full = htmlDocument(title, body);
    await downloadDataUrl(
      'data:text/html;charset=utf-8,' + encodeURIComponent(full),
      `${safeName(title)}.html`
    );
    await reportProgress('html', 'success', 'HTML 导出完成', 100);
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reportProgress('html', 'error', `HTML 导出失败：${msg}`);
    return { success: false, error: msg };
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 套一层带打印样式的完整 HTML 文档 */
function htmlDocument(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', 'Segoe UI', sans-serif;
    max-width: 820px; margin: 40px auto; padding: 0 24px; color: #1f2329; line-height: 1.7; }
  h1,h2,h3,h4 { line-height: 1.3; margin: 1.4em 0 .6em; }
  img { max-width: 100%; height: auto; }
  pre { background: #f6f8fa; padding: 12px 16px; border-radius: 6px; overflow: auto; }
  code { font-family: Consolas, Monaco, monospace; font-size: .92em; }
  pre code { background: none; padding: 0; }
  blockquote { margin: 1em 0; padding: .4em 1em; border-left: 4px solid #d0d7de; color: #57606a; }
  table { border-collapse: collapse; } td,th { border: 1px solid #d0d7de; padding: 6px 12px; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 2em 0; }
  @media print { body { margin: 0; max-width: none; } }
</style>
</head>
<body>
${body}
</body>
</html>`;
}
