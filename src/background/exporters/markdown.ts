import type { DocInfo, ExtensionConfig, MediaAsset, Response } from '../../shared/types';
import { t } from '../../shared/i18n';
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
import { extractEmbeddedSheets, sheetToMdTable } from './sheet';
import { extractWhiteboards } from './whiteboard';
import { createZipDataUrl, type ZipFile } from '../zip';
import { downloadBase64, downloadDataUrl, safeName } from '../download';
import { downloadCloudFile } from './file';
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
  if (doc.docType === 'file') return downloadCloudFile(doc);
  const config = await getConfig();
  const cap = await getCapability(doc.host);

  // 已知支持：先官方，运行期失败再失效回退
  if (cap?.mdExportSupported) {
    try {
      return await runOfficialMd(doc);
    } catch (err) {
      // 未登录/CSRF：官方导出要登录，但公开分享的文档解码（client_vars）匿名也能读，
      // 故先试解码，读得到就出稿；真读不到（私有文档）再提示登录，而非硬失败。
      if (err instanceof NotLoggedInError) return runDecodeMd(doc, config, false, err.message);
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
    // 同上：未登录先试解码（公开文档匿名可读），读不到再提示登录
    if (err instanceof NotLoggedInError) return runDecodeMd(doc, config, false, err.message);
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
  await reportProgress('markdown', 'running', t('progress.markdown.officialTask'), 20);
  const resolved = await resolveObjToken(doc);
  const result = await runExportTask(
    resolved.objToken,
    'md',
    doc.host,
    resolved.objToken
  );
  const title = resolved.title || doc.title || doc.token;
  await reportProgress('markdown', 'running', t('progress.markdown.downloading'), 85);
  await downloadBase64(
    result.base64,
    result.mimeType || 'text/markdown',
    `${safeName(title)}.md`
  );
  await reportProgress('markdown', 'success', t('progress.markdown.doneOfficial'), 100);
  return { success: true };
}

// ==================== P-decode ====================

async function runDecodeMd(
  doc: DocInfo,
  config: ExtensionConfig,
  bypassNotice: boolean,
  /** 官方导出未登录回退时传入：解码也读不到内容（私有文档）时用它提示登录，而非静默出空文件 */
  loginHint?: string
): Promise<Response> {
  try {
    if (bypassNotice) {
      await reportProgress(
        'markdown',
        'running',
        t('progress.markdown.officialClosed')
      );
    }
    const resolved = await resolveObjToken(doc);
    await reportProgress('markdown', 'running', t('progress.markdown.fetchingBlocks'));
    const cv = await fetchClientVars(resolved);
    const data = (cv.data ?? {}) as Record<string, unknown>;

    await reportProgress('markdown', 'running', t('progress.markdown.converting'));
    const { markdown, images, sheetBlocks, whiteboards } = blocksToMarkdown(
      data,
      resolved.objToken
    );

    // 官方导出未登录回退到这里：若解码同样一无所获（私有文档匿名读不到），
    // 明确提示登录，别下载一个空 .md 让人以为成功了。
    if (
      loginHint &&
      !markdown.trim() &&
      images.length === 0 &&
      sheetBlocks.length === 0 &&
      whiteboards.length === 0
    ) {
      return fail('markdown', loginHint);
    }

    const title = resolved.title || doc.title || doc.token;
    let finalMd = markdown;

    // 内嵌 sheet 块：注入页面读单元格，替换占位符。
    // 必须在图片分支（imageMode 分叉）之前做，否则纯 .md / zip 两支会有一支漏替换。
    if (sheetBlocks.length > 0) {
      await reportProgress(
        'markdown',
        'running',
        t('progress.markdown.readingSheets', { n: sheetBlocks.length })
      );
      let grids: Record<string, string[][] | null> = {};
      try {
        grids = await extractEmbeddedSheets(sheetBlocks);
      } catch (e) {
        // 整体失败（如标签页没了）：全部走兜底链接，不让整篇导出失败
        console.warn('[larksnap] 内嵌表格读取失败，降级为链接:', e);
      }
      for (const ref of sheetBlocks) {
        const rows = grids[ref.blockId];
        const repl = rows
          ? sheetToMdTable(rows)
          : `[${t('progress.markdown.viewEmbeddedSheet')}](https://${doc.host}/sheets/${ref.shtToken}?sheet=${ref.subId})` +
            '\n<!-- ' + t('progress.markdown.sheetFallback') + ' -->';
        finalMd = replaceAll(finalMd, `feishu-sheet-block://${ref.blockId}`, repl);
      }
    }

    // 画板块：注入页面抓 canvas 转 PNG dataURL，替换占位符。
    // 同 sheet 一样必须在 imageMode 分叉之前做，两支才都替换得到。
    let wbMap: Record<string, string | null> = {};
    if (whiteboards.length > 0) {
      await reportProgress(
        'markdown',
        'running',
        t('progress.markdown.readingWhiteboards', { n: whiteboards.length })
      );
      try {
        wbMap = await extractWhiteboards(whiteboards);
      } catch (e) {
        // 整体失败（标签页没了等）：全部走占位，不让整篇导出失败
        console.warn('[larksnap] 画板抓取失败，降级为占位:', e);
      }
    }

    const files: ZipFile[] = [];

    if (
      config.imageMode === 'link' ||
      (images.length === 0 && whiteboards.length === 0)
    ) {
      // link 模式 / 无任何素材：占位替换为在线 URL，产出纯 .md
      finalMd = replaceWithOnline(finalMd, images, doc);
      // 画板没有在线 URL，只能把 PNG 以 data URI 内联进 .md（抓不到则写占位说明）
      for (const ref of whiteboards) {
        const dataUrl = wbMap[ref.blockId];
        const repl = dataUrl
          ? `![${t('progress.markdown.whiteboardAlt')}](${dataUrl})`
          : `<!-- ${t('progress.markdown.whiteboardFallback')} -->`;
        finalMd = replaceAll(finalMd, `feishu-whiteboard-block://${ref.blockId}`, repl);
      }
      await downloadDataUrl(
        'data:text/markdown;charset=utf-8,' + encodeURIComponent(finalMd),
        `${safeName(title)}.md`
      );
    } else {
      // download 模式：并发下载图片（≤3 + 退避），替换为相对路径，打包 zip
      if (images.length > 0) {
        await reportProgress('markdown', 'running', t('progress.common.downloadingImages', { n: images.length }));
      }
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
            t('progress.common.downloadingImage', { done: d, total }),
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
      // 画板 PNG 落盘到 images/，占位符换成相对路径（抓不到则写占位说明）
      for (const ref of whiteboards) {
        const dataUrl = wbMap[ref.blockId];
        const bytes = dataUrl ? dataUrlToBytes(dataUrl) : null;
        if (bytes) {
          const path = `images/whiteboard-${ref.blockId}.png`;
          files.push({ path, content: bytes });
          finalMd = replaceAll(
            finalMd,
            `feishu-whiteboard-block://${ref.blockId}`,
            `![${t('progress.markdown.whiteboardAlt')}](${path})`
          );
        } else {
          finalMd = replaceAll(
            finalMd,
            `feishu-whiteboard-block://${ref.blockId}`,
            `<!-- ${t('progress.markdown.whiteboardFallback')} -->`
          );
        }
      }
      files.unshift({ path: `${safeName(title)}.md`, content: finalMd });
      await reportProgress('markdown', 'running', t('progress.common.packingZip'), 97);
      const zipUrl = await createZipDataUrl(files);
      await downloadDataUrl(zipUrl, `${safeName(title)}.zip`);

      if (ok < images.length) {
        const msg =
          ok === 0
            ? t('progress.markdown.allImagesFailed', { n: images.length })
            : t('progress.markdown.doneWithPartialImages', { ok, total: images.length });
        await reportProgress('markdown', ok === 0 ? 'error' : 'success', msg, 100);
        return { success: ok > 0, error: ok === 0 ? msg : undefined };
      }
      await reportProgress(
        'markdown',
        'success',
        t('progress.markdown.doneWithImages', { ok }),
        100
      );
      return { success: true };
    }

    await reportProgress('markdown', 'success', t('progress.markdown.done'), 100);
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

/** `data:image/png;base64,XXXX` → 字节数组；不是 base64 dataURL 则返回 null */
function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(',');
  if (comma < 0 || !/;base64/i.test(dataUrl.slice(0, comma))) return null;
  try {
    return base64ToBytes(dataUrl.slice(comma + 1));
  } catch {
    return null;
  }
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
