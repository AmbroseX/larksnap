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
 * 表格渲染：client_vars 表格结构在公私两端待进一步抓样确认，这里做降级——
 * 尽力保留单元格文本，避免内容丢失；合并单元格不还原（占位说明）。
 */
function renderTable(block: Block, depth: number, ctx: Ctx): string {
  const children = renderChildren(block, depth, ctx);
  const note = '<!-- 表格：合并单元格等复杂结构已降级为顺序文本 -->';
  return children.trim() ? `${note}\n\n${children}` : note;
}
