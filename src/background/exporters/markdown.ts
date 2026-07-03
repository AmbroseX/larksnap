import type { DocInfo, ExtensionConfig, MediaAsset, Response } from '../../shared/types';
import { getConfig } from '../../shared/storage';
import { reportProgress } from '../progress';
import { resolveObjToken, fetchClientVars } from '../feishu-api';
import { downloadMedia } from '../feishu-proxy';
import {
  runExportTask,
  ExportDisabledError,
  NotLoggedInError,
} from './export-task';
import {
  getCapability,
  recordSupported,
  recordUnsupported,
  invalidate,
} from '../capability';
import { blocksToMarkdown } from '../convert/markdown';
import { createZipDataUrl, type ZipFile } from '../zip';
import { downloadBase64, downloadDataUrl, safeName } from '../download';
import {
  base64ToBytes,
  extFromMime,
  onlineMediaUrl,
  mediaDownloadUrls,
  mapWithConcurrency,
} from '../media-util';

/**
 * 导出为 Markdown —— 运行时按 host 选路（§5.1）：
 *   P-official：官方 export/create(md)（质量最高）
 *   P-decode： client_vars + apool 解码 + 自研转换（关闭官方导出的租户唯一可行）
 * 用户始终单一入口，内部自动选路 + 失败回退。
 */
export async function exportMarkdown(doc: DocInfo): Promise<Response> {
  const config = await getConfig();
  const cap = await getCapability(doc.host);

  // 已知支持：先官方，运行期失败再失效回退
  if (cap?.mdExportSupported) {
    try {
      return await runOfficialMd(doc);
    } catch (err) {
      if (err instanceof NotLoggedInError) return fail('markdown', err.message);
      if (err instanceof ExportDisabledError) await invalidate(doc.host);
      else return fail('markdown', errMsg(err));
    }
    return runDecodeMd(doc, config, true);
  }

  // 已知不支持：直接 P-decode
  if (cap && cap.mdExportSupported === false) {
    return runDecodeMd(doc, config, true);
  }

  // 未知：乐观尝试官方，按结果缓存
  try {
    const r = await runOfficialMd(doc);
    await recordSupported(doc.host);
    return r;
  } catch (err) {
    if (err instanceof NotLoggedInError) return fail('markdown', err.message);
    if (err instanceof ExportDisabledError) {
      await recordUnsupported(doc.host);
      return runDecodeMd(doc, config, true);
    }
    // 其他错误（如网络/接口异常）：也尝试 P-decode 兜底
    return runDecodeMd(doc, config, false);
  }
}

// ==================== P-official ====================

async function runOfficialMd(doc: DocInfo): Promise<Response> {
  await reportProgress('markdown', 'running', '正在创建官方 Markdown 导出任务...', 20);
  const resolved = await resolveObjToken(doc);
  const result = await runExportTask(
    resolved.objToken,
    'md',
    doc.host,
    resolved.objToken
  );
  const title = resolved.title || doc.title || doc.token;
  await reportProgress('markdown', 'running', '正在下载 Markdown...', 85);
  await downloadBase64(
    result.base64,
    result.mimeType || 'text/markdown',
    `${safeName(title)}.md`
  );
  await reportProgress('markdown', 'success', 'Markdown 导出完成（官方）', 100);
  return { success: true };
}

// ==================== P-decode ====================

async function runDecodeMd(
  doc: DocInfo,
  config: ExtensionConfig,
  bypassNotice: boolean
): Promise<Response> {
  try {
    if (bypassNotice) {
      await reportProgress(
        'markdown',
        'running',
        '该文档官方导出已关闭，将通过页面数据导出（请确保你已获授权）'
      );
    }
    const resolved = await resolveObjToken(doc);
    await reportProgress('markdown', 'running', '正在拉取文档块内容...');
    const cv = await fetchClientVars(resolved);
    const data = (cv.data ?? {}) as Record<string, unknown>;

    await reportProgress('markdown', 'running', '正在转换为 Markdown...');
    const { markdown, images } = blocksToMarkdown(data, resolved.objToken);

    const title = resolved.title || doc.title || doc.token;
    let finalMd = markdown;
    const files: ZipFile[] = [];

    if (config.imageMode === 'link' || images.length === 0) {
      // link 模式 / 无图：占位替换为在线 URL，产出纯 .md
      finalMd = replaceWithOnline(finalMd, images, doc);
      await downloadDataUrl(
        'data:text/markdown;charset=utf-8,' + encodeURIComponent(finalMd),
        `${safeName(title)}.md`
      );
    } else {
      // download 模式：并发下载图片（≤3 + 退避），替换为相对路径，打包 zip
      await reportProgress('markdown', 'running', `正在下载 ${images.length} 张图片...`);
      const assets = await mapWithConcurrency(
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
            'markdown',
            'running',
            `正在下载图片 ${d}/${total}...`,
            Math.round((d / total) * 95)
          )
      );
      let ok = 0;
      for (let i = 0; i < images.length; i++) {
        const a = assets[i];
        const img = images[i];
        if (a) {
          ok++;
          const ext = extFromMime(a.blob.mimeType || img.mimeType, img.name);
          const path = `images/${img.token}.${ext}`;
          files.push({ path, content: base64ToBytes(a.blob.base64) });
          finalMd = replaceAll(finalMd, `feishu-asset://${img.token}`, path);
        } else {
          // 单图失败：降级为在线 URL，不拖垮整篇（宪法原则 III）
          console.warn('[larksnap] 图片下载失败，降级为在线链接:', img.token);
          finalMd = replaceAll(
            finalMd,
            `feishu-asset://${img.token}`,
            onlineMediaUrl(doc.host, img.token, img.mountToken, img.width, img.height)
          );
        }
      }
      files.unshift({ path: `${safeName(title)}.md`, content: finalMd });
      await reportProgress('markdown', 'running', '正在打包 zip...', 97);
      const zipUrl = await createZipDataUrl(files);
      await downloadDataUrl(zipUrl, `${safeName(title)}.zip`);

      if (ok < images.length) {
        const msg =
          ok === 0
            ? `已导出，但 ${images.length} 张图片全部下载失败（多为未授权该域名/图片域，请重新授权后重试），已降级为在线链接`
            : `Markdown 导出完成（图片 ${ok}/${images.length}，部分失败已降级为在线链接）`;
        await reportProgress('markdown', ok === 0 ? 'error' : 'success', msg, 100);
        return { success: ok > 0, error: ok === 0 ? msg : undefined };
      }
      await reportProgress(
        'markdown',
        'success',
        `Markdown 导出完成（含 ${ok} 张图片）`,
        100
      );
      return { success: true };
    }

    await reportProgress('markdown', 'success', 'Markdown 导出完成', 100);
    return { success: true };
  } catch (err) {
    return fail('markdown', errMsg(err));
  }
}

// ==================== helpers ====================

function replaceWithOnline(
  md: string,
  images: MediaAsset[],
  doc: DocInfo
): string {
  let out = md;
  for (const img of images) {
    out = replaceAll(
      out,
      `feishu-asset://${img.token}`,
      onlineMediaUrl(doc.host, img.token, img.mountToken, img.width, img.height)
    );
  }
  return out;
}

function replaceAll(s: string, find: string, repl: string): string {
  return s.split(find).join(repl);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function fail(
  action: 'markdown',
  message: string
): Promise<Response> {
  await reportProgress(action, 'error', message);
  return { success: false, error: message };
}
