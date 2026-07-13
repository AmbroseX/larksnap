import type {
  ExtensionConfig,
  RuntimeState,
  CachedDoc,
  MarkdownCapability,
} from './types';
import { STORAGE_KEYS, DEFAULT_CONFIG } from './constants';

// ==================== 配置 ====================

/** 读取插件配置 */
export async function getConfig(): Promise<ExtensionConfig> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.CONFIG);
  const stored = (result[STORAGE_KEYS.CONFIG] ?? {}) as Partial<ExtensionConfig>;
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    // 嵌套对象单独合并，避免老版本存量配置缺新字段
    webcopy: { ...DEFAULT_CONFIG.webcopy, ...stored.webcopy },
    videoProxy: { ...DEFAULT_CONFIG.videoProxy, ...stored.videoProxy },
  };
}

/** 保存（合并）插件配置 */
export async function saveConfig(config: Partial<ExtensionConfig>): Promise<void> {
  const current = await getConfig();
  await chrome.storage.local.set({
    [STORAGE_KEYS.CONFIG]: { ...current, ...config },
  });
}

// ==================== 运行时状态 ====================

/** 读取运行时状态 */
export async function getRuntimeState(): Promise<RuntimeState> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.RUNTIME_STATE);
  return result[STORAGE_KEYS.RUNTIME_STATE] ?? { lastProgress: null };
}

/** 更新运行时状态 */
export async function setRuntimeState(state: Partial<RuntimeState>): Promise<void> {
  const current = await getRuntimeState();
  await chrome.storage.local.set({
    [STORAGE_KEYS.RUNTIME_STATE]: { ...current, ...state },
  });
}

// ==================== 缓存 ====================

/** 读取缓存文档索引 */
export async function getCacheIndex(): Promise<CachedDoc[]> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.CACHE_INDEX);
  return result[STORAGE_KEYS.CACHE_INDEX] ?? [];
}

/** 写入一篇缓存文档（内容 + 更新索引） */
export async function putCachedDoc(meta: CachedDoc, content: unknown): Promise<void> {
  const index = await getCacheIndex();
  const next = [meta, ...index.filter((d) => d.token !== meta.token)];
  await chrome.storage.local.set({
    [STORAGE_KEYS.CACHE_INDEX]: next,
    [`${STORAGE_KEYS.CACHE_DOC_PREFIX}${meta.token}`]: content,
  });
}

/** 读取一篇缓存文档内容 */
export async function getCachedDoc<T = unknown>(token: string): Promise<T | null> {
  const key = `${STORAGE_KEYS.CACHE_DOC_PREFIX}${token}`;
  const result = await chrome.storage.local.get(key);
  return (result[key] as T) ?? null;
}

/** 删除一篇缓存文档（内容 + 索引项） */
export async function deleteCachedDoc(token: string): Promise<void> {
  const index = await getCacheIndex();
  await chrome.storage.local.set({
    [STORAGE_KEYS.CACHE_INDEX]: index.filter((d) => d.token !== token),
  });
  await chrome.storage.local.remove(`${STORAGE_KEYS.CACHE_DOC_PREFIX}${token}`);
}

// ==================== Markdown 导出能力（按 host 缓存） ====================

async function getCapMap(): Promise<Record<string, MarkdownCapability>> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.MD_CAP);
  return result[STORAGE_KEYS.MD_CAP] ?? {};
}

/** 读取某 host 的 Markdown 导出能力（未探测过返回 null） */
export async function getMarkdownCapability(
  host: string
): Promise<MarkdownCapability | null> {
  const map = await getCapMap();
  return map[host] ?? null;
}

/** 写入某 host 的 Markdown 导出能力 */
export async function setMarkdownCapability(
  cap: MarkdownCapability
): Promise<void> {
  const map = await getCapMap();
  map[cap.host] = cap;
  await chrome.storage.local.set({ [STORAGE_KEYS.MD_CAP]: map });
}

/** 失效某 host 的能力缓存（P-official 运行期失败后重测用） */
export async function clearMarkdownCapability(host: string): Promise<void> {
  const map = await getCapMap();
  delete map[host];
  await chrome.storage.local.set({ [STORAGE_KEYS.MD_CAP]: map });
}

// ==================== 已信任（运行时授权）域名 ====================

/** 读取已信任域名列表 */
export async function getTrustedDomains(): Promise<string[]> {
  const config = await getConfig();
  return config.trustedDomains ?? [];
}

/** 新增一个已信任域名（去重） */
export async function addTrustedDomain(origin: string): Promise<void> {
  const list = await getTrustedDomains();
  if (!list.includes(origin)) {
    await saveConfig({ trustedDomains: [...list, origin] });
  }
}

/** 移除一个已信任域名 */
export async function removeTrustedDomain(origin: string): Promise<void> {
  const list = await getTrustedDomains();
  await saveConfig({ trustedDomains: list.filter((o) => o !== origin) });
}
