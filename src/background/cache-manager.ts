import type { CachedDoc, DocInfo, Response } from '../shared/types';
import {
  getCacheIndex,
  putCachedDoc,
  deleteCachedDoc,
  getCachedDoc,
} from '../shared/storage';
import { reportProgress } from './progress';

/** 缓存当前文档到本地（支持离线浏览） */
export async function cacheDoc(doc: DocInfo, snapshot: unknown): Promise<Response> {
  await reportProgress('cache', 'running', '正在生成离线快照...', 30);

  if (!doc.isFeishuDoc) {
    await reportProgress('cache', 'error', '当前页面不是飞书文档');
    return { success: false, error: '当前页面不是飞书文档' };
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
  await reportProgress('cache', 'success', `已缓存：${meta.title}`, 100);
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
  if (!snap?.html) return { success: false, error: '该缓存没有可离线浏览的快照' };
  return { success: true, data: { html: snap.html } };
}

/** 删除一篇缓存 */
export async function removeCache(token: string): Promise<Response> {
  await deleteCachedDoc(token);
  return { success: true };
}
