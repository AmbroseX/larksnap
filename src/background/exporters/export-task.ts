import { t } from '../../shared/i18n';
import { createExportTask, fetchExportResult } from '../feishu-api';
import { downloadMedia } from '../feishu-proxy';
import { exportFileUrls } from '../media-util';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 官方导出整体被禁（如 code 1002 no permission），应回退/提示 */
export class ExportDisabledError extends Error {}
/** 未登录（纯文本 403 csrf token error），应提示登录而非回退 */
export class NotLoggedInError extends Error {}

export interface ExportTaskResult {
  base64: string;
  mimeType: string;
  fileExtension: string;
  fileName?: string;
}

interface Json {
  code?: number;
  msg?: string;
  data?: Record<string, unknown>;
  __raw?: string;
  __status?: number;
}

function isNotLoggedIn(resp: Json): boolean {
  const raw = String(resp.__raw ?? '');
  return resp.__status === 403 || /csrf token error/i.test(raw);
}

/**
 * 通用导出任务流程：create → 轮询 result（上限+超时）→ 取文件 token 下载。
 *
 * `objTokenForDownload` 用于媒体下载接口的 mount_node_token；普通文档传 token 即可。
 * 抛 NotLoggedInError / ExportDisabledError 供上层区分处理（§5.1）。
 */
export async function runExportTask(
  token: string,
  fileExtension: string,
  host: string,
  objTokenForDownload?: string
): Promise<ExportTaskResult> {
  const create = (await createExportTask(token, fileExtension)) as Json;

  if (isNotLoggedIn(create)) {
    throw new NotLoggedInError(t('bg.notLoggedIn'));
  }
  const ticket = create.data?.ticket as string | undefined;
  if (create.code !== 0 || !ticket) {
    throw new ExportDisabledError(
      create.msg || t('bg.officialUnavailable', { code: String(create.code ?? '?') })
    );
  }

  // 轮询结果，最多 ~15 次、间隔 1s
  let result: Record<string, unknown> | undefined;
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const r = (await fetchExportResult(ticket)) as Json;
    const res = r.data?.result as Record<string, unknown> | undefined;
    if (res?.file_token) {
      result = res;
      break;
    }
  }
  if (!result?.file_token) {
    throw new Error(t('bg.exportTimeout'));
  }

  // 下载导出产物（download/all/{file_token}，下载域由 driveStreamHost 推导）
  const media = await downloadMedia(
    exportFileUrls(host, String(result.file_token), objTokenForDownload || token)
  );
  return {
    base64: media.base64,
    mimeType: media.mimeType,
    fileExtension: (result.file_extension as string) || fileExtension,
    fileName: result.file_name as string | undefined,
  };
}
