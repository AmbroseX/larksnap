import type { Block, InlineNode } from '../../shared/types';
import { decodeText } from './apool';

/**
 * 把 `client_vars` 的 `block_map` 归一为 Block 树（§5.1）。
 *
 * 字段在公私两端一致但形态与 OpenAPI 不同：`data.type` 是字符串、树靠
 * `parent_id`/`children` + `block_sequence`。本 adapter 做防御式读取，
 * 任何缺字段都降级为空，避免单块异常拖垮整篇（宪法原则 III）。
 */

interface RawEntry {
  type?: string;
  parent_id?: string;
  children?: unknown;
  data?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface BlockTree {
  map: Record<string, Block>;
  /** 顶层块按文档顺序的 id 列表 */
  order: string[];
}

/** children 可能是数组 / {default:[...]} / 缺失 */
function normalizeChildren(entry: RawEntry): string[] {
  const raw = entry.children ?? (entry.data?.children as unknown);
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

function readType(entry: RawEntry): string {
  return String(entry.data?.type ?? entry.type ?? 'unknown');
}

function readParent(entry: RawEntry): string | null {
  const p = entry.parent_id ?? (entry.data?.parent_id as string | undefined);
  return p ? String(p) : null;
}

/** 抽取块特有数据（image/code/table 等），尽力而为 */
function readExtra(entry: RawEntry, type: string): Record<string, unknown> {
  const data = entry.data ?? {};
  const extra: Record<string, unknown> = {};
  if (type === 'image' || data.image) extra.image = data.image;
  if (type === 'file' || data.file) extra.file = data.file;
  if (type.startsWith('code') || data.language) {
    extra.language = (data.language as string) ?? (data.code as Record<string, unknown>)?.language ?? '';
  }
  if (type === 'table' || data.table) extra.table = data.table ?? data;
  // 内嵌 sheet 块：token 挂 data.token 直下（实测确认，无 data.sheet 一层）
  if (type === 'sheet' && typeof data.token === 'string') extra.sheetToken = data.token;
  if (type === 'callout' || data.callout) extra.callout = data.callout ?? data;
  if (type.startsWith('heading')) {
    const m = type.match(/heading(\d)/);
    extra.level = m ? Number(m[1]) : 1;
  }
  if (type === 'todo' || data.done != null) extra.done = Boolean(data.done);
  // 分栏列宽比例（grid_column），公众号渲染按比例分 flex 宽
  if (type === 'grid_column' && data.width_ratio != null) {
    extra.widthRatio = Number(data.width_ratio) || 0;
  }
  return extra;
}

/** 文本类块的正文（apool 解码） */
function readText(entry: RawEntry): InlineNode[] {
  const data = entry.data ?? {};
  const textData = data.text ?? data;
  return decodeText(textData);
}

/** 从 block_map + block_sequence 构建 Block 树 */
export function buildBlockTree(
  clientVarsData: Record<string, unknown>,
  objToken: string
): BlockTree {
  const blockMap = (clientVarsData.block_map ?? {}) as Record<string, RawEntry>;
  const sequence = (clientVarsData.block_sequence as string[]) ?? [];

  const map: Record<string, Block> = {};
  for (const [id, entry] of Object.entries(blockMap)) {
    const type = readType(entry);
    map[id] = {
      id,
      type,
      parentId: readParent(entry),
      children: normalizeChildren(entry),
      text: isTextual(type) ? readText(entry) : [],
      extra: readExtra(entry, type),
    };
  }

  // 定位根：page 块 / id===objToken / 无父块
  const rootId =
    Object.keys(map).find((id) => map[id].type === 'page') ||
    (map[objToken] ? objToken : undefined) ||
    Object.keys(map).find((id) => !map[id].parentId);

  let order: string[] = [];
  if (rootId && map[rootId].children.length) {
    order = map[rootId].children.filter((id) => map[id]);
    // 保险：长文档翻页时根块 children 可能不全，把父块是根块、
    // 却没进 order 的顶层块按 sequence 顺序补到末尾（渲染有 seen 去重，补错不重复输出）
    const inOrder = new Set(order);
    const candidates = sequence.length ? sequence : Object.keys(map);
    for (const id of candidates) {
      if (!inOrder.has(id) && map[id] && map[id].parentId === rootId) {
        inOrder.add(id);
        order.push(id);
      }
    }
  } else if (sequence.length) {
    // 兜底：用 block_sequence 顶层（排除根自身）
    order = sequence.filter((id) => map[id] && id !== rootId);
  } else {
    order = Object.keys(map).filter((id) => id !== rootId);
  }

  return { map, order };
}

function isTextual(type: string): boolean {
  return (
    type === 'text' ||
    type.startsWith('heading') ||
    type === 'bullet' ||
    type === 'ordered' ||
    type === 'todo' ||
    type === 'quote' ||
    type === 'code' ||
    type === 'equation'
  );
}
