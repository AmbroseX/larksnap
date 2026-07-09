import type { Block, MediaAsset } from '../../shared/types';
import { buildBlockTree, type BlockTree } from '../convert/adapter';
import { inlineToHtml, escapeHtml } from '../convert/inline-html';
import { plainText } from '../convert/apool';
import type { XhsNode } from './types';

/**
 * Block 树 → XhsNode[]（§四）。列表被拍平成带 depth 的独立节点，
 * 这样分页可以在任意列表项之间切卡，长列表不至于整块挪页。
 * 不支持的块降级为 placeholder 一行灰字，不中断（宪法原则 III）。
 */

interface Ctx {
  tree: BlockTree;
  images: MediaAsset[];
  seen: Set<string>;
  out: XhsNode[];
}

export function blocksToXhsNodes(
  clientVarsData: Record<string, unknown>,
  objToken: string
): { nodes: XhsNode[]; images: MediaAsset[] } {
  const tree = buildBlockTree(clientVarsData, objToken);
  const ctx: Ctx = { tree, images: [], seen: new Set(), out: [] };
  walkList(tree.order, 0, ctx);
  return { nodes: ctx.out, images: ctx.images };
}

/** 按顺序走一组兄弟块；ordered 序号在同层连续、被其他类型打断即重置 */
function walkList(ids: string[], depth: number, ctx: Ctx): void {
  let ordinal = 0;
  for (const id of ids) {
    const block = ctx.tree.map[id];
    ordinal = block?.type === 'ordered' ? ordinal + 1 : 0;
    walkBlock(id, depth, ordinal, ctx);
  }
}

function walkBlock(id: string, depth: number, ordinal: number, ctx: Ctx): void {
  if (ctx.seen.has(id)) return;
  ctx.seen.add(id);
  const block = ctx.tree.map[id];
  if (!block) return;
  const type = block.type;

  // 列表项：自身一个节点 + 子块加深一层
  if (type === 'bullet' || type === 'ordered' || type === 'todo') {
    const html =
      type === 'todo'
        ? `${block.extra.done ? '☑' : '☐'} ${inlineToHtml(block.text)}`
        : inlineToHtml(block.text);
    ctx.out.push({
      type: type === 'ordered' ? 'ordered' : 'bullet',
      html,
      depth,
      ordinal: type === 'ordered' ? ordinal : undefined,
    });
    walkList(block.children, depth + 1, ctx);
    return;
  }

  switch (true) {
    case type === 'page' || type === 'grid' || type === 'grid_column':
      walkList(block.children, depth, ctx);
      return;

    case type === 'text': {
      const html = inlineToHtml(block.text);
      if (html.trim()) ctx.out.push({ type: 'paragraph', html });
      return;
    }

    case type.startsWith('heading'): {
      // 卡片版式只有 3 级标题，更深的压到 3
      const level = Math.min(Number(block.extra.level) || 1, 3);
      ctx.out.push({ type: 'heading', level, html: inlineToHtml(block.text) });
      return;
    }

    case type === 'quote' || type === 'quote_container' || type === 'callout':
      emitQuote(block, depth, ctx);
      return;

    case type === 'code':
      ctx.out.push({
        type: 'code',
        html: escapeHtml(plainText(block.text)),
        language: String(block.extra.language || ''),
      });
      return;

    case type === 'equation':
      // 卡片渲染不了 LaTeX，以代码块保留源码
      ctx.out.push({ type: 'code', html: escapeHtml(plainText(block.text)), language: 'latex' });
      return;

    case type === 'divider':
      ctx.out.push({ type: 'divider' });
      return;

    case type === 'image':
      emitImage(block, ctx);
      return;

    case type === 'table':
      emitTable(block, depth, ctx);
      return;

    case type === 'sheet':
      ctx.out.push({ type: 'placeholder', html: '内嵌表格：请到原文档查看' });
      return;

    default: {
      // 未知块：保留自身文本与后代，实在没有内容才占位
      const html = inlineToHtml(block.text);
      if (html.trim()) ctx.out.push({ type: 'paragraph', html });
      const before = ctx.out.length;
      walkList(block.children, depth, ctx);
      if (!html.trim() && ctx.out.length === before) {
        ctx.out.push({ type: 'placeholder', html: `暂不支持的块类型：${escapeHtml(type)}` });
      }
      return;
    }
  }
}

function emitImage(block: Block, ctx: Ctx): void {
  const img = (block.extra.image ?? {}) as Record<string, unknown>;
  const token = String(img.token ?? '');
  if (!token) return;
  ctx.images.push({
    token,
    // 媒体下载的 mount_node_token 是图片块自己的 id，不是文档 token
    mountToken: block.id,
    name: String(img.name ?? token),
    mimeType: String(img.mimeType ?? img.mime_type ?? ''),
    isImage: true,
    width: img.width as number | undefined,
    height: img.height as number | undefined,
  });
  ctx.out.push({ type: 'image', imageToken: token });
}

/**
 * 引用/高亮块：文本类子块合成一个 quote 节点（换行分隔）；
 * 图片等非文本子块紧随其后按普通节点输出，内容不丢。
 */
function emitQuote(block: Block, depth: number, ctx: Ctx): void {
  const parts: string[] = [];
  const rest: string[] = [];
  const selfHtml = inlineToHtml(block.text);
  if (selfHtml.trim()) parts.push(selfHtml);
  collectQuoteText(block.children, parts, rest, ctx);
  if (parts.length) ctx.out.push({ type: 'quote', html: parts.join('<br>') });
  walkList(rest, depth, ctx);
}

function collectQuoteText(ids: string[], parts: string[], rest: string[], ctx: Ctx): void {
  for (const id of ids) {
    const child = ctx.tree.map[id];
    if (!child) continue;
    if (child.text.length) {
      ctx.seen.add(id);
      const html = inlineToHtml(child.text);
      if (html.trim()) parts.push(html);
      collectQuoteText(child.children, parts, rest, ctx);
    } else {
      rest.push(id);
    }
  }
}

/**
 * 表格 → rows 二维数组（结构解析与 markdown 渲染器同源：rows_id/columns_id/cell_set，
 * 合并单元格把起点内容复制到覆盖格）。结构对不上则降级为顺序文本。
 */
function emitTable(block: Block, depth: number, ctx: Ctx): void {
  const t = (block.extra.table ?? {}) as Record<string, unknown>;
  const rowIds = Array.isArray(t.rows_id) ? (t.rows_id as unknown[]).map(String) : [];
  const colIds = Array.isArray(t.columns_id) ? (t.columns_id as unknown[]).map(String) : [];
  const cellSet = (t.cell_set ?? {}) as Record<
    string,
    { block_id?: string; merge_info?: { row_span?: number; col_span?: number } }
  >;

  if (!rowIds.length || !colIds.length) {
    ctx.out.push({ type: 'placeholder', html: '表格：结构无法识别，已降级为顺序文本' });
    walkList(block.children, depth, ctx);
    return;
  }

  const rows = rowIds.length;
  const cols = colIds.length;
  const grid: (string | undefined)[][] = Array.from({ length: rows }, () =>
    new Array<string | undefined>(cols).fill(undefined)
  );

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const entry = cellSet[rowIds[r] + colIds[c]];
      const cellId = String(entry?.block_id ?? '');
      if (grid[r][c] !== undefined) {
        if (cellId) markSubtreeSeen(cellId, ctx);
        continue;
      }
      const html = cellHtml(cellId, ctx);
      const rowSpan = Math.max(1, Number(entry?.merge_info?.row_span) || 1);
      const colSpan = Math.max(1, Number(entry?.merge_info?.col_span) || 1);
      for (let dr = 0; dr < rowSpan && r + dr < rows; dr++) {
        for (let dc = 0; dc < colSpan && c + dc < cols; dc++) {
          grid[r + dr][c + dc] = html;
        }
      }
    }
  }

  ctx.out.push({ type: 'table', rows: grid.map((row) => row.map((c) => c ?? '')) });
}

/** 单元格正文：文本类子块 HTML 换行拼接；图片等以「[图]」占位 */
function cellHtml(cellId: string, ctx: Ctx): string {
  const cell = ctx.tree.map[cellId];
  if (!cell) return '';
  ctx.seen.add(cellId);
  const parts: string[] = [];
  const walk = (ids: string[]) => {
    for (const id of ids) {
      const b = ctx.tree.map[id];
      if (!b) continue;
      ctx.seen.add(id);
      if (b.type === 'image') parts.push('[图]');
      else {
        const html = inlineToHtml(b.text);
        if (html.trim()) parts.push(html);
      }
      walk(b.children);
    }
  };
  walk(cell.children);
  return parts.join('<br>');
}

/** 整棵子树标记已消费，防止后续被当孤儿块重复输出 */
function markSubtreeSeen(id: string, ctx: Ctx): void {
  if (ctx.seen.has(id)) return;
  ctx.seen.add(id);
  const block = ctx.tree.map[id];
  if (block) for (const cid of block.children) markSubtreeSeen(cid, ctx);
}
