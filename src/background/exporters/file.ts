import type { DocInfo, Response } from '../../shared/types';
import { t } from '../../shared/i18n';
import { reportProgress } from '../progress';
import { downloadMedia } from '../feishu-proxy';
import { downloadBase64, safeName } from '../download';
import { extFromMime, fileDownloadUrls } from '../media-util';

/** 下载云盘文件；原始下载被策略拒绝时，使用预览流作为兼容兜底。 */
export async function downloadCloudFile(doc: DocInfo): Promise<Response> {
  await reportProgress('markdown', 'running', t('progress.markdown.downloading'));
  try {
    const media = await downloadMedia(fileDownloadUrls(doc.host, doc.token));
    const title = safeName(doc.title || doc.token);
    const ext = extFromMime(media.mimeType, title);
    const filename = /\.[A-Za-z0-9]{1,8}$/.test(title) ? title : `${title}.${ext}`;
    await downloadBase64(media.base64, media.mimeType, filename);
    await reportProgress('markdown', 'success', t('progress.markdown.done'), 100);
    return { success: true, data: { filename } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reportProgress('markdown', 'error', msg);
    return { success: false, error: msg };
  }
}
