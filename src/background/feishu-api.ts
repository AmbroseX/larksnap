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
    // 飞书个人版(my.feishu.cn)的 tree/get_info 常报 PermFail，拿不到 space_id；
    // 但 get_node 的响应里带 space_id，用它兜底，client_vars 翻页更稳。
    spaceId: spaceId ?? (n?.space_id != null ? String(n.space_id) : undefined),
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

// ==================== 新建文档 ====================

/** 新建文档结果：只建空文档，正文需另走编辑粘贴 */
export interface CreatedDoc {
  /** 文档本体 obj_token（喂 client_vars / edit 用这个） */
  objToken: string;
  /** explorer 节点 token（列目录/移动/删除用） */
  nodeToken: string;
  /** 新文档绝对地址 /docx/{objToken} */
  url: string;
}

/**
 * 新建一篇空 docx 文档（公有云 + 私有化通用，实测同接口同结构）。
 *
 * ⚠️ 只创建空文档：飞书正文改动走协同 WebSocket 不走 HTTP，
 * 要写内容请拿 objToken 拼 /docx/{token} 后复用编辑（append）粘贴。
 * ⚠️ body 必须表单编码（form:true）：发 JSON 会被判 code:2 Parameter Error。
 *
 * @param opts.name 文档标题（空 = 未命名）
 * @param opts.parentToken 目标文件夹节点 token（空 = 我的空间根目录）
 */
export async function createDocx(opts?: {
  name?: string;
  parentToken?: string;
}): Promise<CreatedDoc> {
  const res = (await feishuPost(
    `/space/api/explorer/v2/create/object/`,
    {
      parent_token: opts?.parentToken ?? '',
      type: 22, // 22 = docx 新版文档
      name: opts?.name ?? '',
      time_zone: 'Asia/Shanghai',
      source: 0,
      ua_type: 'Web',
      scene: 'space_create',
    },
    { form: true }
  )) as Json;

  if (res.code !== 0) {
    // 未登录/CSRF 时 feishuPost 返回 { __raw, __status }（非标准 JSON），
    // 把原始文案透出来，好让上层 isLoginError 认出"需登录"（含 csrf / 40x）
    const raw = (res as Record<string, unknown>).__raw;
    throw new Error(
      `新建文档失败: code=${String(res.code)} ${String(res.msg ?? raw ?? '')}`
    );
  }
  const data = (res.data ?? {}) as Record<string, unknown>;
  const nodeToken = Array.isArray(data.node_list)
    ? String((data.node_list as unknown[])[0] ?? '')
    : '';
  const nodes = ((data.entities as Record<string, unknown> | undefined)?.nodes ??
    {}) as Record<string, Record<string, unknown>>;
  const node = nodes[nodeToken];
  const objToken = String(node?.obj_token ?? '');
  if (!objToken) throw new Error('新建文档成功但未取到 obj_token');
  return { objToken, nodeToken, url: String(node?.url ?? '') };
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
  // 跨页合并 block_sequence（顶层顺序的兜底来源）
  const sequence: string[] = Array.isArray(data.block_sequence)
    ? (data.block_sequence as unknown[]).map(String)
    : [];
  const seqSeen = new Set(sequence);
  const mergeSeq = (pd: Record<string, unknown>) => {
    if (!Array.isArray(pd.block_sequence)) return;
    for (const s of pd.block_sequence as unknown[]) {
      const id = String(s);
      if (!seqSeen.has(id)) {
        seqSeen.add(id);
        sequence.push(id);
      }
    }
  };
  // 翻页，合并附加块（块条目重复出现时 children 取并集，
  // 不能整条覆盖——根块的 children 就是顶层顺序，覆盖会丢前页的列表）
  let cursor = (data.cursor as string) ?? '';
  let nextCursors = data.next_cursors;
  let hasMore = Boolean(data.has_more);
  let guard = 0;
  // 根块（page 块）ID：翻页要作为 pagingRootID 传给服务端（缺了报 4000091）
  const rootBlockId =
    Object.entries(blockMap).find(([, e]) => {
      const entry = e as Record<string, unknown>;
      const t = (entry.data as Record<string, unknown> | undefined)?.type ?? entry.type;
      return t === 'page';
    })?.[0] ?? doc.objToken;
  // 续页参数没有公开文档，按实测有效顺序穷举（iflytek 私有化实测 mode=1+cursor+limit 有效；
  // mode=4 不带 block_id 报 4000091，带了则不报错但永远返回第一屏）。
  // 成功判据必须是"返回了新块 ID"，用"有块"判会被第一屏骗成死循环。
  let winner = '';
  while (hasMore && guard < 50) {
    guard++;
    const next = firstCursorOf(nextCursors);
    const variants: Array<{ tag: string; q: string }> = [];
    const push = (tag: string, q: string, c: string) => {
      if (c) variants.push({ tag, q: `${q}&cursor=${encodeURIComponent(c)}&limit=239` });
    };
    push('m1', 'mode=1', cursor);
    push('m1n', 'mode=1', next);
    push('prid', `mode=4&paging_root_id=${rootBlockId}`, cursor);
    push('bidn', `mode=4&block_id=${rootBlockId}`, next);
    push('bid', `mode=4&block_id=${rootBlockId}`, cursor);
    const tryOrder = winner
      ? [
          ...variants.filter((v) => v.tag === winner),
          ...variants.filter((v) => v.tag !== winner),
        ]
      : variants;
    let pd: Record<string, unknown> | null = null;
    for (const v of tryOrder) {
      const page = (await feishuGet(
        `/space/api/docx/pages/client_vars?id=${doc.objToken}&${v.q}${wikiPart}`
      )) as Json;
      const cand = (page.data ?? {}) as Record<string, unknown>;
      const fresh = Object.keys((cand.block_map as object) ?? {}).filter(
        (id) => !(id in blockMap)
      ).length;
      if (fresh > 0) {
        pd = cand;
        winner = v.tag;
        break;
      }
    }
    if (!pd) break; // 没有任何组合能拿到新块：停止翻页，导出已合并部分
    mergeBlockMap(blockMap, (pd.block_map ?? {}) as Record<string, unknown>);
    mergeSeq(pd);
    for (const s of (pd.skip_blocks as string[]) ?? []) skipped.add(String(s));
    hasMore = Boolean(pd.has_more);
    cursor = (pd.cursor as string) ?? '';
    nextCursors = pd.next_cursors;
    if (!cursor && !firstCursorOf(nextCursors)) break;
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
      mergeBlockMap(blockMap, (pd.block_map ?? {}) as Record<string, unknown>);
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
  data.block_sequence = sequence;
  first.data = data;
  return first;
}

/** next_cursors 可能是字符串 / 字符串数组 / 对象，取第一个非空字符串 */
function firstCursorOf(nc: unknown): string {
  if (typeof nc === 'string') return nc;
  if (Array.isArray(nc)) {
    for (const v of nc) if (typeof v === 'string' && v) return v;
    return '';
  }
  if (nc && typeof nc === 'object') {
    for (const v of Object.values(nc as Record<string, unknown>)) {
      if (typeof v === 'string' && v) return v;
    }
  }
  return '';
}

/** 合并翻页返回的 block_map：已有条目的 children 取并集（保持先见顺序），其余字段用新条目 */
function mergeBlockMap(
  into: Record<string, unknown>,
  add: Record<string, unknown>
): void {
  for (const [id, entry] of Object.entries(add)) {
    const prev = into[id] as Record<string, unknown> | undefined;
    if (!prev) {
      into[id] = entry;
      continue;
    }
    const kids = [...readChildren(prev)];
    const seen = new Set(kids);
    for (const c of readChildren(entry as Record<string, unknown>)) {
      if (!seen.has(c)) {
        seen.add(c);
        kids.push(c);
      }
    }
    into[id] = { ...prev, ...(entry as Record<string, unknown>), children: kids };
  }
}

/** 读原始条目的 children（可能在 entry.children 或 entry.data.children，数组或 {default:[...]}） */
function readChildren(entry: Record<string, unknown>): string[] {
  const raw =
    entry.children ?? (entry.data as Record<string, unknown> | undefined)?.children;
  if (Array.isArray(raw)) return raw.map(String);
  if (raw && typeof raw === 'object') {
    const out: string[] = [];
    for (const v of Object.values(raw as Record<string, unknown>)) {
      if (Array.isArray(v)) out.push(...v.map(String));
    }
    return out;
  }
  return [];
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
