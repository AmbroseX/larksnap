import type { Block, MarkdownResult, MediaAsset } from '../../shared/types';
import { renderInline, plainText } from './apool';
import { buildBlockTree, type BlockTree } from './adapter';

/**
 * Block 树 → Markdown（GFM）。仅负责"块类型 → Markdown 结构"，文本抽取由 apool 完成。
 *
 * 图片不直接拼远程 URL，先写占位 `![name](feishu-asset://{token})` 并收集到 images[]，
 * 由 exporters/markdown.ts 决定下载替换或转在线 URL（§5.1 图片小节）。
 * 不支持的块降级占位，但尽量保留其后代文本，避免内容丢失（宪法原则 III）。
 */

interface Ctx {
  tree: BlockTree;
  images: MediaAsset[];
  seen: Set<string>;
}

export function blocksToMarkdown(
  clientVarsData: Record<string, unknown>,
  objToken: string
): MarkdownResult {
  const tree = buildBlockTree(clientVarsData, objToken);
  const ctx: Ctx = { tree, images: [], seen: new Set() };
  const parts: string[] = [];
  for (const id of tree.order) {
    const md = renderBlock(id, 0, ctx);
    if (md.trim()) parts.push(md);
  }
  const markdown =
    parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  return { markdown, images: ctx.images };
}

function renderBlock(id: string, depth: number, ctx: Ctx): string {
  if (ctx.seen.has(id)) return '';
  ctx.seen.add(id);
  const block = ctx.tree.map[id];
  if (!block) return '';

  const type = block.type;

  // 列表类：自身一行 + 子块缩进
  if (type === 'bullet' || type === 'ordered' || type === 'todo') {
    return renderListItem(block, depth, ctx);
  }

  switch (true) {
    case type === 'page':
      return renderChildren(block, depth, ctx);

    case type === 'text':
      return renderInline(block.text);

    case type.startsWith('heading'): {
      const level = Math.min(Number(block.extra.level) || 1, 6);
      return `${'#'.repeat(level)} ${renderInline(block.text)}`;
    }

    case type === 'quote' || type === 'quote_container': {
      const inner =
        type === 'quote'
          ? renderInline(block.text)
          : renderChildren(block, depth, ctx);
      return inner
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
    }

    case type === 'code': {
      const lang = String(block.extra.language || '');
      return '```' + lang + '\n' + plainText(block.text) + '\n```';
    }

    case type === 'equation':
      return `$$\n${plainText(block.text)}\n$$`;

    case type === 'divider':
      return '---';

    case type === 'image':
      return renderImage(block, ctx);

    case type === 'callout':
      return renderCallout(block, depth, ctx);

    case type === 'grid' || type === 'grid_column':
      return renderChildren(block, depth, ctx);

    case type === 'table':
      return renderTable(block, depth, ctx);

    default: {
      // 未知块：保留后代文本，否则占位
      const children = renderChildren(block, depth, ctx);
      const self = renderInline(block.text);
      const body = [self, children].filter((s) => s.trim()).join('\n\n');
      return body || `<!-- 暂不支持的块类型: ${type} -->`;
    }
  }
}

function renderChildren(block: Block, depth: number, ctx: Ctx): string {
  const parts: string[] = [];
  for (const cid of block.children) {
    const md = renderBlock(cid, depth, ctx);
    if (md.trim()) parts.push(md);
  }
  return parts.join('\n\n');
}

function renderListItem(block: Block, depth: number, ctx: Ctx): string {
  const indent = '  '.repeat(depth);
  let marker: string;
  if (block.type === 'ordered') marker = '1.';
  else if (block.type === 'todo') marker = block.extra.done ? '- [x]' : '- [ ]';
  else marker = '-';
  const lines = [`${indent}${marker} ${renderInline(block.text)}`];
  for (const cid of block.children) {
    const child = ctx.tree.map[cid];
    if (!child) continue;
    if (
      child.type === 'bullet' ||
      child.type === 'ordered' ||
      child.type === 'todo'
    ) {
      lines.push(renderListItem(child, depth + 1, ctx));
      ctx.seen.add(cid);
    } else {
      const md = renderBlock(cid, depth + 1, ctx);
      if (md.trim())
        lines.push(
          md
            .split('\n')
            .map((l) => `${'  '.repeat(depth + 1)}${l}`)
            .join('\n')
        );
    }
  }
  return lines.join('\n');
}

function renderImage(block: Block, ctx: Ctx): string {
  const img = (block.extra.image ?? {}) as Record<string, unknown>;
  const token = String(img.token ?? '');
  const name = String(img.name ?? token ?? 'image');
  if (!token) return '';
  ctx.images.push({
    token,
    // 媒体下载的 mount_node_token 是**图片块自己的 id**(dox…)，不是文档 token
    mountToken: block.id,
    name,
    mimeType: String(img.mimeType ?? img.mime_type ?? ''),
    isImage: true,
    width: img.width as number | undefined,
    height: img.height as number | undefined,
  });
  return `![${name}](feishu-asset://${token})`;
}

function renderCallout(block: Block, depth: number, ctx: Ctx): string {
  const inner = renderChildren(block, depth, ctx) || renderInline(block.text);
  return inner
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}

/**
 * 表格渲染（2026-07 抓样确认的 client_vars 结构）：
 * - data.rows_id / data.columns_id 定行列顺序；
 * - data.cell_set 以 `行id+列id` 为键 → { block_id, merge_info: { row_span, col_span } }；
 * - 被合并覆盖的格子在 cell_set 里仍有自己的（空）单元格块；
 * - 单元格内容是 table_cell 块的子块，靠 fetchClientVars 补拉 skip_blocks 才在 map 里。
 * 统一输出 GFM 管道表格；合并单元格把起点内容复制到每个被覆盖的格子
 * （与飞书官方 md 导出行为一致），保证任何查看器下表格都不缺格。
 * 结构缺失时退回顺序文本，保内容不保形（宪法原则 III）。
 */
function renderTable(block: Block, depth: number, ctx: Ctx): string {
  const t = (block.extra.table ?? {}) as Record<string, unknown>;
  const rowIds = Array.isArray(t.rows_id) ? (t.rows_id as unknown[]).map(String) : [];
  const colIds = Array.isArray(t.columns_id) ? (t.columns_id as unknown[]).map(String) : [];
  const cellSet = (t.cell_set ?? {}) as Record<
    string,
    { block_id?: string; merge_info?: { row_span?: number; col_span?: number } }
  >;

  if (!rowIds.length || !colIds.length) {
    // 结构对不上（旧版本/私有化差异）：退回顺序文本
    const children = renderChildren(block, depth, ctx);
    const note = '<!-- 表格：结构无法识别，已降级为顺序文本 -->';
    return children.trim() ? `${note}\n\n${children}` : note;
  }

  const rows = rowIds.length;
  const cols = colIds.length;
  // grid[r][c] = 该格最终文本；被合并覆盖的格子复制起点格内容
  const grid: (string | undefined)[][] = Array.from({ length: rows }, () =>
    new Array<string | undefined>(cols).fill(undefined)
  );

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const entry = cellSet[rowIds[r] + colIds[c]];
      const cellId = String(entry?.block_id ?? '');
      if (grid[r][c] !== undefined) {
        // 被合并覆盖：内容已从起点格复制过来，这里只把空 cell 块标记为已消费
        if (cellId) markSubtreeSeen(cellId, ctx);
        continue;
      }
      const text = renderCellContent(cellId, depth, ctx);
      const rowSpan = Math.max(1, Number(entry?.merge_info?.row_span) || 1);
      const colSpan = Math.max(1, Number(entry?.merge_info?.col_span) || 1);
      for (let dr = 0; dr < rowSpan && r + dr < rows; dr++) {
        for (let dc = 0; dc < colSpan && c + dc < cols; dc++) {
          grid[r + dr][c + dc] = text;
        }
      }
    }
  }

  return renderPipeTable(grid);
}

/** 单元格正文：子块 Markdown 合成一行（换行转 <br>） */
function renderCellContent(cellId: string, depth: number, ctx: Ctx): string {
  const cell = ctx.tree.map[cellId];
  if (!cell) return '';
  ctx.seen.add(cellId);
  return renderChildren(cell, depth, ctx).replace(/\n+/g, '<br>').trim();
}

/** 把整棵子树标记为已渲染，防止后续被当孤儿块重复输出 */
function markSubtreeSeen(id: string, ctx: Ctx): void {
  if (ctx.seen.has(id)) return;
  ctx.seen.add(id);
  const block = ctx.tree.map[id];
  if (block) for (const cid of block.children) markSubtreeSeen(cid, ctx);
}

function renderPipeTable(grid: (string | undefined)[][]): string {
  const lines: string[] = [];
  for (let r = 0; r < grid.length; r++) {
    const cells = grid[r].map((text) => escapePipeCell(text ?? ''));
    lines.push(`| ${cells.join(' | ')} |`);
    // GFM 必须有表头分隔行；飞书首行即表头（header_row 缺省也按此处理）
    if (r === 0) lines.push(`| ${grid[r].map(() => '---').join(' | ')} |`);
  }
  return lines.join('\n');
}

function escapePipeCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}
