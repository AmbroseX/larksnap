import type { DocInfo, Response } from '../../shared/types';
import { t } from '../../shared/i18n';
import { reportProgress } from '../progress';
import { resolveObjToken } from '../feishu-api';
import {
  runExportTask,
  ExportDisabledError,
  NotLoggedInError,
} from './export-task';
import { downloadBase64, safeName } from '../download';

/**
 * 导出为 PDF —— 走飞书官方导出任务（服务端渲染，质量最稳，§5.2）。
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
    if (err instanceof NotLoggedInError) {
      await reportProgress('pdf', 'error', err.message);
      return { success: false, error: err.message };
    }
    if (err instanceof ExportDisabledError) {
      const msg = t('progress.pdf.closed');
      await reportProgress('pdf', 'error', msg);
      return { success: false, error: msg };
    }
    const msg = err instanceof Error ? err.message : String(err);
    await reportProgress('pdf', 'error', t('progress.pdf.failed', { msg }));
    return { success: false, error: msg };
  }
}
