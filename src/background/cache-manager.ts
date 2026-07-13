import type { CachedDoc, DocInfo, Response } from '../shared/types';
import {
  getCacheIndex,
  putCachedDoc,
  deleteCachedDoc,
  getCachedDoc,
} from '../shared/storage';
import { reportProgress } from './progress';
import { t } from '../shared/i18n';

/** 缓存当前文档到本地（支持离线浏览） */
export async function cacheDoc(doc: DocInfo, snapshot: unknown): Promise<Response> {
  await reportProgress('cache', 'running', t('progress.cache.snapshotting'), 30);

  if (!doc.isFeishuDoc) {
    await reportProgress('cache', 'error', t('progress.cache.notFeishu'));
    return { success: false, error: t('progress.cache.notFeishu') };
  }

  const meta: CachedDoc = {
    token: doc.token,
    docType: doc.docType,
    title: doc.title || doc.token,
    url: doc.url,
    cachedAt: Date.now(),
    size: JSON.stringify(snapshot ?? {}).length,
  };

  await putCachedDoc(meta, snapshot);
  await reportProgress('cache', 'success', t('progress.cache.done', { title: meta.title }), 100);
  return { success: true, data: meta };
}

/** 列出已缓存文档 */
export async function listCache(): Promise<Response<CachedDoc[]>> {
  const index = await getCacheIndex();
  return { success: true, data: index };
}

/** 读取一篇缓存的快照内容（供离线打开） */
export async function getCache(token: string): Promise<Response<{ html: string }>> {
  const snap = await getCachedDoc<{ html?: string }>(token);
  if (!snap?.html) return { success: false, error: t('progress.cache.noSnapshot') };
  return { success: true, data: { html: snap.html } };
}

/** 删除一篇缓存 */
export async function removeCache(token: string): Promise<Response> {
  await deleteCachedDoc(token);
  return { success: true };
}
