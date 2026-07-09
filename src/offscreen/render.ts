import type { XhsNode } from '../background/xhs/types';
import type { XhsTheme } from './themes';

/**
 * XhsNode → DOM（§六）。样式全部内联（html2canvas 对内联样式最稳），
 * 布局刻意保持简单：单列纵向流、系统字体栈，降低 html2canvas 翻车面（§十-1）。
 */

/** 卡片逻辑尺寸：540×720（3:4），html2canvas scale=2 出 1080×1440 */
export const CARD_W = 540;
export const CARD_H = 720;
export const SCALE = 2;
/** 内容区四边留白与底部页码区 */
const PAD = 44;
const FOOTER = 56;
/** 内容区可用高度（智能分页的 maxH） */
export const CONTENT_H = CARD_H - PAD - FOOTER;
/** 正文行高（px），分页防寡行时按它估算行数 */
export const BODY_LINE_H = 28;

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', 'Segoe UI', sans-serif";
const MONO_STACK = "Consolas, Monaco, 'Courier New', monospace";

export interface CardShell {
  card: HTMLDivElement;
  /** 节点都塞进这里，固定高 CONTENT_H、overflow hidden */
  content: HTMLDivElement;
}

export function createCard(theme: XhsTheme): CardShell {
  const card = document.createElement('div');
  Object.assign(card.style, {
    width: `${CARD_W}px`,
    height: `${CARD_H}px`,
    position: 'relative',
    boxSizing: 'border-box',
    background: theme.bg,
    fontFamily: FONT_STACK,
    color: theme.text,
  } satisfies Partial<CSSStyleDeclaration>);

  const content = document.createElement('div');
  Object.assign(content.style, {
    position: 'absolute',
    left: `${PAD}px`,
    right: `${PAD}px`,
    top: `${PAD}px`,
    height: `${CONTENT_H}px`,
    overflow: 'hidden',
  } satisfies Partial<CSSStyleDeclaration>);
  card.appendChild(content);
  return { card, content };
}

/** 底部页码角标（分页完成、总数已知后再补） */
export function addPageNumber(card: HTMLDivElement, page: number, total: number, theme: XhsTheme): void {
  const el = document.createElement('div');
  el.textContent = `${page}/${total}`;
  Object.assign(el.style, {
    position: 'absolute',
    bottom: '20px',
    right: `${PAD}px`,
    fontSize: '12px',
    color: theme.muted,
  } satisfies Partial<CSSStyleDeclaration>);
  card.appendChild(el);
}

/** 第一张卡顶部的文档标题 */
export function createTitleEl(title: string, theme: XhsTheme): HTMLElement {
  const el = document.createElement('div');
  el.textContent = title;
  Object.assign(el.style, {
    fontSize: '24px',
    fontWeight: '700',
    lineHeight: '1.4',
    color: theme.heading,
    padding: '0 0 14px',
    marginBottom: '18px',
    borderBottom: `1px solid ${theme.border}`,
  } satisfies Partial<CSSStyleDeclaration>);
  return el;
}

export function renderNode(
  node: XhsNode,
  theme: XhsTheme,
  imageMap: Record<string, string | null>
): HTMLElement {
  switch (node.type) {
    case 'heading':
      return headingEl(node, theme);
    case 'paragraph':
      return paragraphEl(node.html ?? '', theme);
    case 'bullet':
    case 'ordered':
      return listItemEl(node, theme);
    case 'image':
      return imageEl(node, theme, imageMap);
    case 'quote':
      return quoteEl(node, theme);
    case 'code':
      return codeEl(node, theme);
    case 'divider':
      return dividerEl(theme);
    case 'table':
      return tableEl(node, theme);
    default:
      return placeholderEl(node.html ?? '暂不支持的内容', theme);
  }
}

function paragraphEl(html: string, theme: XhsTheme): HTMLElement {
  const p = document.createElement('p');
  p.innerHTML = html;
  Object.assign(p.style, {
    margin: '0 0 14px',
    fontSize: '16px',
    lineHeight: `${BODY_LINE_H}px`,
    color: theme.text,
    wordBreak: 'break-word',
  } satisfies Partial<CSSStyleDeclaration>);
  styleInlineCode(p, theme);
  return p;
}

function headingEl(node: XhsNode, theme: XhsTheme): HTMLElement {
  const sizes: Record<number, string> = { 1: '22px', 2: '19px', 3: '17px' };
  const h = document.createElement('div');
  h.innerHTML = node.html ?? '';
  Object.assign(h.style, {
    margin: '6px 0 12px',
    fontSize: sizes[node.level ?? 1] ?? '22px',
    fontWeight: '700',
    lineHeight: '1.45',
    color: theme.heading,
    wordBreak: 'break-word',
  } satisfies Partial<CSSStyleDeclaration>);
  return h;
}

function listItemEl(node: XhsNode, theme: XhsTheme): HTMLElement {
  const row = document.createElement('div');
  Object.assign(row.style, {
    display: 'flex',
    margin: '0 0 8px',
    paddingLeft: `${(node.depth ?? 0) * 20}px`,
    fontSize: '16px',
    lineHeight: `${BODY_LINE_H}px`,
  } satisfies Partial<CSSStyleDeclaration>);

  const marker = document.createElement('span');
  marker.textContent = node.type === 'ordered' ? `${node.ordinal ?? 1}.` : '•';
  Object.assign(marker.style, {
    flex: 'none',
    marginRight: '8px',
    color: node.type === 'ordered' ? theme.text : theme.accent,
  } satisfies Partial<CSSStyleDeclaration>);

  const body = document.createElement('span');
  body.innerHTML = node.html ?? '';
  Object.assign(body.style, {
    flex: '1',
    minWidth: '0',
    wordBreak: 'break-word',
  } satisfies Partial<CSSStyleDeclaration>);
  styleInlineCode(body, theme);

  row.append(marker, body);
  return row;
}

function imageEl(
  node: XhsNode,
  theme: XhsTheme,
  imageMap: Record<string, string | null>
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.margin = '0 0 14px';
  const url = node.imageToken ? imageMap[node.imageToken] : null;
  if (!url) {
    // 下载失败绝不能塞在线 URL（污染 canvas），画占位灰块（§十-2）
    const ph = placeholderEl('图片加载失败', theme);
    Object.assign(ph.style, {
      height: '120px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      margin: '0',
    } satisfies Partial<CSSStyleDeclaration>);
    wrap.appendChild(ph);
    return wrap;
  }
  const img = document.createElement('img');
  img.src = url;
  Object.assign(img.style, {
    display: 'block',
    maxWidth: '100%',
    // 单图最高不超过内容区（超高图等比缩，允许一图独占一卡）
    maxHeight: `${CONTENT_H - 8}px`,
    margin: '0 auto',
    borderRadius: '8px',
  } satisfies Partial<CSSStyleDeclaration>);
  wrap.appendChild(img);
  return wrap;
}

function quoteEl(node: XhsNode, theme: XhsTheme): HTMLElement {
  const q = document.createElement('div');
  q.innerHTML = node.html ?? '';
  Object.assign(q.style, {
    margin: '0 0 14px',
    padding: '2px 0 2px 12px',
    borderLeft: `3px solid ${theme.accent}`,
    fontSize: '15px',
    lineHeight: '26px',
    color: theme.muted,
    wordBreak: 'break-word',
  } satisfies Partial<CSSStyleDeclaration>);
  styleInlineCode(q, theme);
  return q;
}

function codeEl(node: XhsNode, theme: XhsTheme): HTMLElement {
  const pre = document.createElement('pre');
  pre.innerHTML = node.html ?? '';
  Object.assign(pre.style, {
    margin: '0 0 14px',
    padding: '12px 14px',
    background: theme.codeBg,
    borderRadius: '8px',
    fontSize: '12.5px',
    lineHeight: '1.6',
    fontFamily: MONO_STACK,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    color: theme.text,
  } satisfies Partial<CSSStyleDeclaration>);
  return pre;
}

function dividerEl(theme: XhsTheme): HTMLElement {
  const hr = document.createElement('div');
  Object.assign(hr.style, {
    height: '1px',
    background: theme.border,
    margin: '4px 0 18px',
  } satisfies Partial<CSSStyleDeclaration>);
  return hr;
}

function tableEl(node: XhsNode, theme: XhsTheme): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.margin = '0 0 14px';
  const table = document.createElement('table');
  Object.assign(table.style, {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '12.5px',
    lineHeight: '1.6',
  } satisfies Partial<CSSStyleDeclaration>);
  (node.rows ?? []).forEach((row, r) => {
    const tr = document.createElement('tr');
    for (const cellHtml of row) {
      const td = document.createElement(r === 0 ? 'th' : 'td');
      td.innerHTML = cellHtml;
      Object.assign(td.style, {
        border: `1px solid ${theme.border}`,
        padding: '5px 8px',
        textAlign: 'left',
        wordBreak: 'break-word',
        background: r === 0 ? theme.codeBg : 'transparent',
      } satisfies Partial<CSSStyleDeclaration>);
      tr.appendChild(td);
    }
    table.appendChild(tr);
  });
  wrap.appendChild(table);
  return wrap;
}

function placeholderEl(text: string, theme: XhsTheme): HTMLElement {
  const el = document.createElement('div');
  el.textContent = text;
  Object.assign(el.style, {
    margin: '0 0 14px',
    padding: '8px 12px',
    background: theme.codeBg,
    borderRadius: '6px',
    fontSize: '12px',
    color: theme.muted,
  } satisfies Partial<CSSStyleDeclaration>);
  return el;
}

/** 行内 <code> 统一上色（innerHTML 塞进来的没有样式） */
function styleInlineCode(root: HTMLElement, theme: XhsTheme): void {
  root.querySelectorAll('code').forEach((c) => {
    Object.assign((c as HTMLElement).style, {
      fontFamily: MONO_STACK,
      fontSize: '0.9em',
      background: theme.codeBg,
      borderRadius: '4px',
      padding: '1px 5px',
    } satisfies Partial<CSSStyleDeclaration>);
  });
}
