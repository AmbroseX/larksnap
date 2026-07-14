import type { Block, MediaAsset } from '../../shared/types';
import type { BlockTree } from './adapter';
import { inlineToWechatHtml, escapeHtml } from './inline-html';
import { plainText } from './apool';

/**
 * Block 树 → 公众号编辑器兼容 HTML（2026-07-09 方案 §二 crx 逆向规则）。
 *
 * 公众号编辑器粘贴时会丢 class、丢外部样式，只认内联 style，所以：
 * - 容器一律 <section>，样式全内联；
 * - 代码块保留 code-snippet 三个 class（编辑器自己认这几个类）；
 * - 图片必须是 dataURL（外链 <img> 会被编辑器整个丢掉），失败画占位；
 * - 不支持的块渲染一行灰字占位，比 crx 的静默跳过诚实。
 * SW 无 DOM，全部字符串拼接。
 */

// 主题定义在 shared/themes.ts（侧边栏悬浮预览也要用），这里转口导出保持原引用不变
import { WECHAT_THEMES, getWechatTheme, type WechatTheme } from '../../shared/themes';
export { WECHAT_THEMES, getWechatTheme };
export type { WechatTheme };

interface Ctx {
  tree: BlockTree;
  imageMap: Record<string, string | null>;
  seen: Set<string>;
  theme: WechatTheme;
}

/** 正文基准样式（crx：15px / 1.5 / 黑 90%） */
const BODY = 'font-size:15px;line-height:1.5;color:rgba(0,0,0,0.9)';
const MONO = 'Consolas,Monaco,monospace';

/** 收集树里全部画板块的 id（导出时注入页面抓 canvas，结果按 blockId 塞进 imageMap） */
export function collectWhiteboardIds(tree: BlockTree): string[] {
  const out: string[] = [];
  for (const block of Object.values(tree.map)) {
    if (block.type === 'whiteboard' || block.type === 'board') out.push(block.id);
  }
  return out;
}

/** 收集树里全部图片块的素材引用（下载去重由 image-map 做） */
export function collectImageAssets(tree: BlockTree): MediaAsset[] {
  const out: MediaAsset[] = [];
  for (const block of Object.values(tree.map)) {
    if (block.type !== 'image') continue;
    const img = (block.extra.image ?? {}) as Record<string, unknown>;
    const token = String(img.token ?? '');
    if (!token) continue;
    out.push({
      token,
      mountToken: block.id, // mount_node_token 是图片块自己的 id
      name: String(img.name ?? token),
      mimeType: String(img.mimeType ?? img.mime_type ?? ''),
      isImage: true,
      width: img.width as number | undefined,
      height: img.height as number | undefined,
    });
  }
  return out;
}

export function renderWechatHtml(
  tree: BlockTree,
  imageMap: Record<string, string | null>,
  theme: WechatTheme = WECHAT_THEMES.classic
): string {
  const ctx: Ctx = { tree, imageMap, seen: new Set(), theme };
  const body = renderIds(tree.order, 0, ctx);
  // 外层容器行高 1.8（crx 规则），各块自带 1.5 的正文行高
  return `<section style="word-wrap:break-word;line-height:1.8;font-size:15px;color:rgba(0,0,0,0.9)">${body}</section>`;
}

/**
 * 渲染一组兄弟块：连续的 bullet/ordered 合并成一个 ul/ol
 * （recordMap/client_vars 里每个列表项都是独立块，crx 的"跨块续号"等价于按连续段编号）。
 */
function renderIds(ids: string[], depth: number, ctx: Ctx): string {
  let html = '';
  let i = 0;
  while (i < ids.length) {
    const block = ctx.tree.map[ids[i]];
    if (!block || ctx.seen.has(ids[i])) {
      i++;
      continue;
    }
    if (block.type === 'bullet' || block.type === 'ordered') {
      const run: string[] = [];
      const listType = block.type;
      while (i < ids.length && ctx.tree.map[ids[i]]?.type === listType) {
        run.push(ids[i]);
        i++;
      }
      html += renderList(run, listType, depth, ctx);
      continue;
    }
    html += renderBlock(ids[i], depth, ctx);
    i++;
  }
  return html;
}

/** 有序/无序列表：原生 ol/ul，按嵌套深度轮换 type（crx 规则） */
function renderList(
  ids: string[],
  listType: 'bullet' | 'ordered',
  depth: number,
  ctx: Ctx
): string {
  const tag = listType === 'ordered' ? 'ol' : 'ul';
  const typeAttr =
    listType === 'ordered'
      ? ['1', 'a', 'i'][depth % 3]
      : ['disc', 'circle', 'square'][depth % 3];
  const items = ids
    .map((id) => {
      const block = ctx.tree.map[id];
      if (!block) return '';
      ctx.seen.add(id);
      const children = renderIds(block.children, depth + 1, ctx);
      return `<li${mark(listType, block.id)} data-larksnap-content="" style="${BODY};margin:4px 0">${inlineToWechatHtml(block.text)}${children}</li>`;
    })
    .join('');
  return `<${tag} type="${typeAttr}" style="margin:10px 0;padding-left:24px">${items}</${tag}>`;
}

function renderBlock(id: string, depth: number, ctx: Ctx): string {
  if (ctx.seen.has(id)) return '';
  ctx.seen.add(id);
  const block = ctx.tree.map[id];
  if (!block) return '';
  const type = block.type;

  switch (true) {
    case type === 'page':
      return renderIds(block.children, depth, ctx);

    case type === 'text': {
      const inline = inlineToWechatHtml(block.text);
      if (!inline.trim()) return '';
      return `<section${mark('text', block.id)} data-larksnap-content="" style="${BODY};margin:10px 0">${inline}</section>`;
    }

    case type.startsWith('heading'): {
      const level = Math.min(Math.max(Number(block.extra.level) || 1, 1), 6);
      const sizes = [28, 25, 22, 20, 18, 16];
      // 带色条的主题：h1/h2 左侧加 4px 色条
      const bar =
        ctx.theme.accentBar && level <= 2
          ? `border-left:4px solid ${ctx.theme.accentBar};padding-left:10px;`
          : '';
      return (
        `<h${level}${mark(type, block.id)} data-larksnap-content="" style="font-size:${sizes[level - 1]}px;font-weight:bold;` +
        `line-height:1.4;color:${ctx.theme.headingColor};${bar}margin:15px 0">` +
        `${inlineToWechatHtml(block.text)}</h${level}>`
      );
    }

    case type === 'todo': {
      const box = block.extra.done ? '☑' : '☐';
      return `<section${mark('todo', block.id)} data-larksnap-content="" style="${BODY};margin:10px 0">${box} ${inlineToWechatHtml(block.text)}</section>`;
    }

    case type === 'quote' || type === 'quote_container':
      return renderQuote(block, depth, ctx);

    case type === 'code':
      return renderCode(block);

    case type === 'equation':
      return renderCode(block, 'latex');

    case type === 'divider':
      return `<hr${mark('divider', block.id)} style="border:none;border-top:1px solid #e5e5e5;margin:20px 0">`;

    case type === 'image':
      return renderImage(block, ctx);

    case type === 'callout':
      return renderCallout(block, depth, ctx);

    case type === 'grid':
      return renderGrid(block, depth, ctx);

    case type === 'table':
      return renderTable(block, depth, ctx);

    case type === 'sheet':
      return placeholder('内嵌表格：请到原文档查看');

    case type.includes('whiteboard') || type === 'board':
      return renderWhiteboard(block, ctx);

    default: {
      // 未知块：保留自身文本与后代，实在没内容才占位
      const inline = inlineToWechatHtml(block.text);
      const children = renderIds(block.children, depth, ctx);
      if (!inline.trim() && !children.trim()) {
        return placeholder(`暂不支持的块类型：${escapeHtml(type)}`);
      }
      const self = inline.trim()
        ? `<section style="${BODY};margin:10px 0">${inline}</section>`
        : '';
      return self + children;
    }
  }
}

// ==================== 具体块渲染 ====================

/**
 * 块级三属性（FR-010，壹伴 data-mpa-md-* 同构）：key=块类型、action-id=块唯一 id。
 * 正文容器另打 data-larksnap-content。粘贴路线编辑器留不留这些属性都不影响样式；
 * JSAPI 灌入后可回查 DOM，为后续"换肤重排已灌入内容"留口。
 */
function mark(type: string, blockId: string): string {
  return ` data-larksnap-key="${escapeHtml(type)}" data-larksnap-action-id="${escapeHtml(blockId)}"`;
}

function placeholder(text: string): string {
  return (
    '<section style="margin:10px 0;padding:6px 10px;background:#f2f3f5;' +
    `border-radius:4px;color:#8a919f;font-size:13px">${text}</section>`
  );
}

/** 引用：左侧 4px 灰条 + 浅灰底（crx 规则） */
function renderQuote(block: Block, depth: number, ctx: Ctx): string {
  const self = inlineToWechatHtml(block.text);
  const children = renderIds(block.children, depth, ctx);
  const inner = self.trim()
    ? `<section style="${BODY};margin:6px 0">${self}</section>` + children
    : children;
  return (
    `<blockquote${mark('quote', block.id)} data-larksnap-content="" style="margin:10px 0;padding:6px 12px;border-left:4px solid ${ctx.theme.quoteBorder};` +
    `background:#f9f9f9;color:rgba(0,0,0,0.6)">${inner}</blockquote>`
  );
}

/**
 * 代码块：pre 挂 code-snippet 三个 class（公众号编辑器自己认的类，
 * 粘贴后保留代码块外观），每行一个 display:block 的 code（crx 规则）。
 * 微信新版编辑器 schema（plan §5.6）：外层包 <section class="code-snippet__js">，
 * 每行内容再包 <span leaf="">——没有叶节点标记，set_content 后代码块会退化成普通段落。
 */
function renderCode(block: Block, langOverride?: string): string {
  const lang = langOverride ?? String(block.extra.language || '');
  const lines = plainText(block.text)
    .split('\n')
    .map((line) => {
      const t = escapeHtml(line);
      return (
        `<code style="display:block;font-family:${MONO};white-space:pre-wrap;word-break:break-all">` +
        `<span leaf="">${t || '<br>'}</span></code>`
      );
    })
    .join('');
  return (
    `<section class="code-snippet__js"${mark(langOverride ? 'equation' : 'code', block.id)} style="margin:10px 0">` +
    `<pre class="code-snippet__js code-snippet code-snippet_nowrap" data-lang="${escapeHtml(lang)}" data-larksnap-content="" ` +
    'style="margin:0;padding:12px 14px;background:#f5f6f7;border-radius:6px;' +
    `font-size:13px;line-height:1.6;overflow-x:auto">${lines}</pre></section>`
  );
}

/**
 * 图片：外层 section 控对齐与上下边距，img 本体 dataURL（公众号粘贴时自动转存图床）。
 * 下载失败画占位——外链 <img> 会被公众号编辑器整个丢掉，塞了也白塞。
 */
function renderImage(block: Block, ctx: Ctx): string {
  const img = (block.extra.image ?? {}) as Record<string, unknown>;
  const token = String(img.token ?? '');
  const url = token ? ctx.imageMap[token] : null;
  if (!url) return placeholder('图片下载失败，请在飞书另存后手动插入');
  const align = Number(img.align) === 1 ? 'left' : Number(img.align) === 3 ? 'right' : 'center';
  return (
    `<section${mark('image', block.id)} style="text-align:${align};margin:20px 0">` +
    `<img src="${url}" data-larksnap-content="" style="max-width:100%;border-radius:8px" data-width="100%">` +
    '</section>'
  );
}

/**
 * 画板块：内容是页面 canvas 抓来的 PNG dataURL（导出时按 blockId 存进 imageMap）。
 * 和图片一样必须内联 dataURL——外链会被公众号编辑器丢掉；抓不到画占位。
 */
function renderWhiteboard(block: Block, ctx: Ctx): string {
  const url = ctx.imageMap[block.id];
  if (!url) return placeholder('画板未能抓取，请把画板滚动到可见区域后重试，或在飞书里另存为图片手动插入');
  return (
    `<section${mark('whiteboard', block.id)} style="text-align:center;margin:20px 0">` +
    `<img src="${url}" data-larksnap-content="" style="max-width:100%;border-radius:8px" data-width="100%">` +
    '</section>'
  );
}

/** 高亮块（callout）：flex 外框，emoji 在左；颜色枚举映射飞书浅色盘，认不出用浅灰 */
function renderCallout(block: Block, depth: number, ctx: Ctx): string {
  const data = (block.extra.callout ?? {}) as Record<string, unknown>;
  const bg = calloutColor(data.background_color) ?? '#f2f3f5';
  const emoji = calloutEmoji(data.emoji_id);
  const inner =
    renderIds(block.children, depth, ctx) ||
    `<section style="${BODY}">${inlineToWechatHtml(block.text)}</section>`;
  const emojiPart = emoji
    ? `<section style="flex:none;margin-right:8px;font-size:16px;line-height:1.8">${emoji}</section>`
    : '';
  return (
    `<section${mark('callout', block.id)} style="display:flex;background:${bg};border:1px solid rgba(0,0,0,0.06);` +
    'border-radius:8px;padding:10px 14px;margin:10px 0">' +
    emojiPart +
    `<section data-larksnap-content="" style="flex:1;min-width:0">${inner}</section></section>`
  );
}

/** 飞书 callout 背景色枚举 → 浅色盘（CSS 色值则直接透传） */
function calloutColor(v: unknown): string | null {
  if (typeof v === 'string' && /^(#|rgb|hsl)/i.test(v)) return v;
  const palette: Record<number, string> = {
    1: '#fde2e2', // 红
    2: '#feead2', // 橙
    3: '#fbf4cb', // 黄
    4: '#d9f5d6', // 绿
    5: '#d9f3fd', // 蓝
    6: '#ece2fe', // 紫
    7: '#f2f3f5', // 灰
  };
  const n = Number(v);
  return palette[n] ?? null;
}

/** emoji_id 常见形态是 unicode 码点（如 "1f4a1"），转不出就不放 */
function calloutEmoji(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!/^[0-9a-f]{4,6}(-[0-9a-f]{4,6})*$/i.test(s)) return '';
  try {
    return s
      .split('-')
      .map((cp) => String.fromCodePoint(parseInt(cp, 16)))
      .join('');
  } catch {
    return '';
  }
}

/** 分栏：flex 布局，列宽按 width_ratio 比例分（crx：flex = ratio × 100） */
function renderGrid(block: Block, depth: number, ctx: Ctx): string {
  const cols = block.children
    .map((cid) => {
      const col = ctx.tree.map[cid];
      if (!col) return '';
      ctx.seen.add(cid);
      const ratio = Number(col.extra.widthRatio) || 0;
      const flex = ratio > 0 ? `${Math.round(ratio * 100)} ${Math.round(ratio * 100)} 0%` : '1 1 0%';
      return `<section style="flex:${flex};min-width:0">${renderIds(col.children, depth, ctx)}</section>`;
    })
    .join('');
  return `<section${mark('grid', block.id)} style="display:flex;gap:12px;margin:10px 0">${cols}</section>`;
}

/**
 * 表格：结构解析与 markdown 渲染器同源（rows_id/columns_id/cell_set），
 * 但公众号能用真 rowspan/colspan，被合并覆盖的格子直接跳过不输出。
 * 首行表头灰底加粗；结构对不上降级为顺序文本。
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
    return placeholder('表格：结构无法识别，已降级为顺序文本') + renderIds(block.children, depth, ctx);
  }

  const rows = rowIds.length;
  const cols = colIds.length;
  // covered[r][c] = 被上方/左方合并单元格覆盖，输出时跳过
  const covered: boolean[][] = Array.from({ length: rows }, () =>
    new Array<boolean>(cols).fill(false)
  );

  const cellStyle =
    'border:1px solid #ddd;padding:6px 10px;font-size:14px;line-height:1.5;' +
    'color:rgba(0,0,0,0.9);text-align:left';
  const trs: string[] = [];
  for (let r = 0; r < rows; r++) {
    const tds: string[] = [];
    for (let c = 0; c < cols; c++) {
      const entry = cellSet[rowIds[r] + colIds[c]];
      const cellId = String(entry?.block_id ?? '');
      if (covered[r][c]) {
        // 被合并覆盖：空 cell 块标记已消费，不输出
        if (cellId) markSubtreeSeen(cellId, ctx);
        continue;
      }
      const rowSpan = Math.max(1, Number(entry?.merge_info?.row_span) || 1);
      const colSpan = Math.max(1, Number(entry?.merge_info?.col_span) || 1);
      for (let dr = 0; dr < rowSpan && r + dr < rows; dr++) {
        for (let dc = 0; dc < colSpan && c + dc < cols; dc++) {
          if (dr || dc) covered[r + dr][c + dc] = true;
        }
      }
      const cell = ctx.tree.map[cellId];
      let inner = '';
      if (cell) {
        ctx.seen.add(cellId);
        inner = renderIds(cell.children, depth, ctx);
      }
      const tag = r === 0 ? 'th' : 'td';
      const headStyle = r === 0 ? ';background:#f2f3f5;font-weight:bold' : '';
      const span =
        (rowSpan > 1 ? ` rowspan="${rowSpan}"` : '') +
        (colSpan > 1 ? ` colspan="${colSpan}"` : '');
      tds.push(`<${tag}${span} style="${cellStyle}${headStyle}">${inner}</${tag}>`);
    }
    trs.push(`<tr>${tds.join('')}</tr>`);
  }

  return (
    `<section${mark('table', block.id)} style="margin:10px 0;overflow-x:auto">` +
    '<table data-larksnap-content="" style="border-collapse:collapse;width:100%">' +
    `<tbody>${trs.join('')}</tbody></table></section>`
  );
}

/** 整棵子树标记已消费，防止后续被当孤儿块重复输出 */
function markSubtreeSeen(id: string, ctx: Ctx): void {
  if (ctx.seen.has(id)) return;
  ctx.seen.add(id);
  const block = ctx.tree.map[id];
  if (block) for (const cid of block.children) markSubtreeSeen(cid, ctx);
}
