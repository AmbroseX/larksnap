import type { DocInfo } from '../shared/types';
import { feishuGet, feishuPost } from './feishu-proxy';

/**
 * 飞书内部接口路径封装（集中管理，§8 风险:接口变更只需改这里）。
 *
 * ⚠️ 这些函数运行在 SW，但实际 fetch 经 feishu-proxy → content 同源代发（宪法原则 I）。
 * 路径用相对 path，content 侧用 `location.origin` 拼接，天然适配私有化（宪法原则 II）。
 */

/** 解析后的目标文档定位 */
export interface ResolvedDoc {
  /** 真实文档 obj_token（docx 直用 token；wiki 解析得到） */
  objToken: string;
  /** wiki 容器参数（直链 docx 为 undefined） */
  wikiToken?: string;
  spaceId?: string;
  /** 文档标题（尽力） */
  title?: string;
}

interface Json {
  code?: number;
  data?: Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * 解析真实 obj_token（§7 token 解析链）：
 * - 直链 docx/docs/file：token 即 obj_token；
 * - wiki：tree/get_info 取 space_id → tree/get_node 取 obj_token。
 */
export async function resolveObjToken(doc: DocInfo): Promise<ResolvedDoc> {
  if (doc.docType !== 'wiki') {
    return { objToken: doc.token, title: doc.title };
  }

  const wikiToken = doc.token;
  // 1) tree/get_info 找本节点 space_id
  const info = (await feishuGet(
    `/space/api/wiki/v2/tree/get_info/?wiki_token=${wikiToken}`
  )) as Json;
  const spaceId = findSpaceId(info, wikiToken);

  // 2) tree/get_node 取 obj_token / title
  const nodeQuery = spaceId
    ? `?wiki_token=${wikiToken}&space_id=${spaceId}`
    : `?wiki_token=${wikiToken}`;
  const node = (await feishuGet(
    `/space/api/wiki/v2/tree/get_node/${nodeQuery}`
  )) as Json;
  const n = (node.data?.node ?? node.data) as Record<string, unknown> | undefined;

  return {
    objToken: String(n?.obj_token ?? wikiToken),
    wikiToken,
    spaceId,
    title: (n?.title as string) ?? doc.title,
  };
}

/** 从 tree/get_info 响应里尽力找 space_id */
function findSpaceId(info: Json, wikiToken: string): string | undefined {
  const data = info.data ?? {};
  const nodes = (data.nodes ?? data) as Record<string, unknown>;
  if (nodes && typeof nodes === 'object') {
    const self = (nodes as Record<string, { space_id?: string | number }>)[wikiToken];
    if (self?.space_id != null) return String(self.space_id);
    for (const v of Object.values(nodes)) {
      const sid = (v as { space_id?: string | number })?.space_id;
      if (sid != null) return String(sid);
    }
  }
  if (data.space_id != null) return String(data.space_id);
  return undefined;
}

/** 直链 docx 元数据（公有云）：标题/owner/时间 */
export async function fetchMeta(token: string): Promise<Json> {
  return (await feishuGet(`/space/api/meta/?token=${token}&type=22`)) as Json;
}

/**
 * 拉取完整 client_vars 块内容（含 mode=4 翻页直到 has_more=false）。
 * 首屏会把表格等大块的子树列进 skip_blocks 跳过不发，需要再按块补拉，
 * 否则表格单元格（table_cell）永远不在 block_map 里。
 * 返回合并后的 { block_map, block_sequence, meta_map, ...原始首屏字段 }。
 */
export async function fetchClientVars(doc: ResolvedDoc): Promise<Json> {
  const wikiPart = doc.wikiToken
    ? `&wiki_space_id=${doc.spaceId ?? ''}&container_type=wiki2.0&container_id=${doc.wikiToken}`
    : '';
  const first = (await feishuGet(
    `/space/api/docx/pages/client_vars?id=${doc.objToken}&mode=1&limit=239${wikiPart}`
  )) as Json;

  const data = (first.data ?? {}) as Record<string, unknown>;
  const blockMap = (data.block_map ?? {}) as Record<string, unknown>;
  const skipped = new Set<string>(
    Array.isArray(data.skip_blocks) ? (data.skip_blocks as string[]) : []
  );

  // 翻页：mode=4 + cursor，合并附加块
  let cursor = (data.cursor as string) ?? '';
  let hasMore = Boolean(data.has_more);
  let guard = 0;
  while (hasMore && guard < 50) {
    guard++;
    const page = (await feishuGet(
      `/space/api/docx/pages/client_vars?id=${doc.objToken}&mode=4&cursor=${encodeURIComponent(
        cursor
      )}${wikiPart}`
    )) as Json;
    const pd = (page.data ?? {}) as Record<string, unknown>;
    Object.assign(blockMap, (pd.block_map ?? {}) as Record<string, unknown>);
    for (const s of (pd.skip_blocks as string[]) ?? []) skipped.add(String(s));
    hasMore = Boolean(pd.has_more);
    cursor = (pd.cursor as string) ?? '';
    if (!cursor) break;
  }

  // 补拉被跳过的子树：mode=4 + block_id（表格单元格及其正文块从这里来）
  const pending = [...skipped];
  const done = new Set<string>();
  while (pending.length && done.size < 50) {
    const bid = pending.shift()!;
    if (done.has(bid)) continue;
    done.add(bid);
    let subCursor = '';
    let subMore = true;
    let subGuard = 0;
    while (subMore && subGuard < 50) {
      subGuard++;
      const page = (await feishuGet(
        `/space/api/docx/pages/client_vars?id=${doc.objToken}&mode=4&block_id=${bid}&cursor=${encodeURIComponent(
          subCursor
        )}&limit=239${wikiPart}`
      )) as Json;
      const pd = (page.data ?? {}) as Record<string, unknown>;
      Object.assign(blockMap, (pd.block_map ?? {}) as Record<string, unknown>);
      // 子树里可能还有下一层被跳过的块，入队继续补
      for (const s of (pd.skip_blocks as string[]) ?? []) {
        if (!done.has(String(s))) pending.push(String(s));
      }
      subMore = Boolean(pd.has_more);
      subCursor = (pd.cursor as string) ?? '';
      if (!subCursor) break;
    }
  }

  data.block_map = blockMap;
  first.data = data;
  return first;
}

// ==================== 导出任务（PDF / Word / 官方 md） ====================

/** 创建导出任务，返回原始响应（含 code / data.ticket，或 1002 no permission） */
export async function createExportTask(
  token: string,
  fileExtension: string
): Promise<Json> {
  return (await feishuPost(`/space/api/export/create/`, {
    token,
    type: fileExtension,
    file_extension: fileExtension,
    event_source: 1,
    need_comment: false,
  })) as Json;
}

/** 查询导出结果 */
export async function fetchExportResult(ticket: string): Promise<Json> {
  return (await feishuGet(`/space/api/export/result/${ticket}`)) as Json;
}
