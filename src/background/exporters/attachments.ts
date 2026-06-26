import type { DocInfo, MediaAsset, Response } from '../../shared/types';
import { reportProgress } from '../progress';
import { resolveObjToken, fetchClientVars } from '../feishu-api';
import { downloadMedia } from '../feishu-proxy';
import { createZipDataUrl, type ZipFile } from '../zip';
import { downloadDataUrl, safeName } from '../download';
import {
  base64ToBytes,
  extFromMime,
  mediaDownloadUrls,
  mapWithConcurrency,
} from '../media-util';

/**
 * 导出附件 —— 复用 client_vars 块里的 image/file token，统一走媒体下载接口，
 * 打包 zip（§5.4）。与 Markdown 图片下载共用 downloadMedia / media-util。
 */
export async function exportAttachments(doc: DocInfo): Promise<Response> {
  await reportProgress('attachments', 'running', '正在收集附件列表...');

  try {
    const resolved = await resolveObjToken(doc);
    const cv = await fetchClientVars(resolved);
    const data = (cv.data ?? {}) as Record<string, unknown>;
    const assets = collectAssets(data);

    if (assets.length === 0) {
      await reportProgress('attachments', 'success', '该文档没有可导出的附件', 100);
      return { success: true, data: { count: 0 } };
    }

    await reportProgress(
      'attachments',
      'running',
      `正在下载 ${assets.length} 个附件...`
    );
    const results = await mapWithConcurrency(
      assets,
      3,
      async (a) => {
        const blob = await downloadMedia(
          mediaDownloadUrls(doc.host, a.token, a.mountToken, {
            isImage: a.isImage,
            width: a.width,
            height: a.height,
          })
        );
        return { a, blob };
      },
      (d, total) =>
        reportProgress(
          'attachments',
          'running',
          `正在下载附件 ${d}/${total}...`,
          Math.round((d / total) * 95)
        )
    );

    const files: ZipFile[] = [];
    const used = new Set<string>();
    let ok = 0;
    for (const r of results) {
      if (!r) continue;
      ok++;
      const ext = extFromMime(r.blob.mimeType || r.a.mimeType, r.a.name);
      const baseName = (safeName(r.a.name) || r.a.token).replace(
        new RegExp(`\\.${ext}$`, 'i'),
        ''
      );
      let name = `${baseName}.${ext}`;
      // 文件名冲突加 token 短哈希
      if (used.has(name)) name = `${baseName}-${r.a.token.slice(-6)}.${ext}`;
      used.add(name);
      files.push({ path: name, content: base64ToBytes(r.blob.base64) });
    }

    if (files.length === 0) {
      const msg = '所有附件下载失败，请重试';
      await reportProgress('attachments', 'error', msg);
      return { success: false, error: msg };
    }

    await reportProgress('attachments', 'running', '正在打包 zip...', 97);
    const title = resolved.title || doc.title || doc.token;
    const zipUrl = await createZipDataUrl(files);
    await downloadDataUrl(zipUrl, `${safeName(title)}-附件.zip`);

    await reportProgress(
      'attachments',
      'success',
      `附件导出完成（${ok}/${assets.length}）`,
      100
    );
    return { success: true, data: { count: ok } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reportProgress('attachments', 'error', `附件导出失败：${msg}`);
    return { success: false, error: msg };
  }
}

/** 扫描 block_map 收集 image/file 素材 token（去重）。mount_node_token 用**块 id** */
function collectAssets(data: Record<string, unknown>): MediaAsset[] {
  const blockMap = (data.block_map ?? {}) as Record<
    string,
    { id?: string; data?: Record<string, unknown> }
  >;
  const seen = new Set<string>();
  const out: MediaAsset[] = [];
  for (const [blockId, entry] of Object.entries(blockMap)) {
    const d = entry.data ?? {};
    for (const key of ['image', 'file'] as const) {
      const m = d[key] as Record<string, unknown> | undefined;
      const token = m?.token ? String(m.token) : '';
      if (token && !seen.has(token)) {
        seen.add(token);
        out.push({
          token,
          mountToken: blockId,
          name: String(m?.name ?? token),
          mimeType: String(m?.mimeType ?? m?.mime_type ?? ''),
          isImage: key === 'image',
          width: m?.width as number | undefined,
          height: m?.height as number | undefined,
        });
      }
    }
  }
  return out;
}
