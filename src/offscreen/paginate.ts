import type { XhsNode } from '../background/xhs/types';
import type { XhsTheme } from './themes';
import {
  createCard,
  createTitleEl,
  renderNode,
  BODY_LINE_H,
  CONTENT_H,
  type CardShell,
} from './render';

/**
 * 智能分页（§五）：逐节点塞进卡片、真实 DOM 量高、溢出回退。
 *
 * 规则：
 * 1. 标题不孤 —— 卡片末尾的标题跟着下一个节点去新卡；
 * 2. 段落防寡行 —— 长段落在剩余空间 >= MIN_LINES 行时段内切分，否则整段挪走；
 * 3. 超大节点（表格/代码块）独占一卡仍放不下 → 逐级缩字号，实在不行裁剪兜底。
 */

/** 段落切分后留在当前卡的最少行数 */
const MIN_LINES = 2;
/** 短于这个字符数的段落不做段内切分，直接整段挪 */
const MIN_SPLIT_CHARS = 40;
/** 卡片数量上限（§十-3：超长文档逐张截图慢且吃内存） */
const MAX_CARDS = 100;

interface QueueItem {
  node: XhsNode;
  el: HTMLElement;
}

export async function paginate(
  nodes: XhsNode[],
  title: string,
  theme: XhsTheme,
  imageMap: Record<string, string | null>,
  stage: HTMLElement
): Promise<HTMLDivElement[]> {
  const shells: CardShell[] = [];
  const newCard = (): CardShell => {
    if (shells.length >= MAX_CARDS) {
      throw new Error(`文档过长，卡片超过 ${MAX_CARDS} 张，请分段导出`);
    }
    const shell = createCard(theme);
    stage.appendChild(shell.card);
    shells.push(shell);
    return shell;
  };

  let shell = newCard();
  if (title.trim()) {
    const titleEl = createTitleEl(title, theme);
    titleEl.dataset.xhsKeep = '1'; // 标题不孤：不让它单独留在卡末
    shell.content.appendChild(titleEl);
  }

  const queue: QueueItem[] = nodes.map((node) => {
    const el = renderNode(node, theme, imageMap);
    if (node.type === 'heading') el.dataset.xhsKeep = '1';
    return { node, el };
  });

  while (queue.length) {
    const item = queue.shift()!;
    shell.content.appendChild(item.el);
    if (item.node.type === 'image') await decodeImages(item.el);
    if (fits(shell.content)) continue;

    // ---- 溢出回退 ----
    item.el.remove();

    // 规则 2：长段落段内切分（剩余空间够 MIN_LINES 行才切，防寡行）
    if (
      item.node.type === 'paragraph' &&
      remainingHeight(shell.content) >= MIN_LINES * BODY_LINE_H
    ) {
      const rest = splitParagraph(item.el, shell.content);
      if (rest) {
        console.log('[larksnap:xhs] 段内切分 → 卡片', shells.length);
        queue.unshift({ node: item.node, el: rest });
        shell = newCard();
        continue;
      }
    }

    const els = Array.from(shell.content.children) as HTMLElement[];
    if (els.length) {
      const last = els[els.length - 1];
      const keepLast = last.dataset.xhsKeep === '1';
      if (keepLast && els.length === 1) {
        // 卡上只有一个标题，节点又超大：同卡缩排，别让标题空守一张卡
        shell.content.appendChild(item.el);
        if (item.node.type === 'image') await decodeImages(item.el);
        if (!fits(shell.content)) shrinkToFit(item.el, shell.content);
        shell = newCard();
        continue;
      }
      let carry: HTMLElement | null = null;
      if (keepLast) {
        // 规则 1：标题不孤，摘下带去新卡
        carry = last;
        last.remove();
      }
      shell = newCard();
      if (carry) shell.content.appendChild(carry);
      queue.unshift(item);
      continue;
    }

    // 空卡上单节点独占仍放不下（超大表格/代码块）：缩字号，兜底裁剪
    shell.content.appendChild(item.el);
    if (item.node.type === 'image') await decodeImages(item.el);
    shrinkToFit(item.el, shell.content);
    shell = newCard();
  }

  // 去掉结尾可能剩下的空卡
  const cards = shells
    .filter((s) => s.content.childElementCount > 0)
    .map((s) => s.card);
  shells.forEach((s) => {
    if (s.content.childElementCount === 0) s.card.remove();
  });
  console.log(`[larksnap:xhs] 分页完成：${nodes.length} 个节点 → ${cards.length} 张卡片`);
  return cards;
}

/** 末尾元素底边是否在内容区内（不用 scrollHeight，避免 margin 计入差异） */
function fits(content: HTMLElement): boolean {
  const last = content.lastElementChild as HTMLElement | null;
  if (!last) return true;
  return (
    last.getBoundingClientRect().bottom <=
    content.getBoundingClientRect().bottom + 0.5
  );
}

/** 内容区剩余可用高度（px） */
function remainingHeight(content: HTMLElement): number {
  const last = content.lastElementChild as HTMLElement | null;
  if (!last) return CONTENT_H;
  return content.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom;
}

/**
 * 段内切分：二分找当前卡还能放下的最大字符数，前半留下、返回后半元素。
 * 切不动（首行都放不下 / 留下的不足 MIN_LINES 行 / 段落太短）返回 null，调用方整段挪。
 */
function splitParagraph(el: HTMLElement, content: HTMLElement): HTMLElement | null {
  const orig = el.cloneNode(true) as HTMLElement;
  const total = textLength(orig);
  if (total < MIN_SPLIT_CHARS) return null;

  content.appendChild(el);
  let lo = 0;
  let hi = total - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    setTruncated(el, orig, mid);
    if (fits(content)) lo = mid;
    else hi = mid - 1;
  }
  if (lo === 0) {
    el.remove();
    return null;
  }
  setTruncated(el, orig, lo);
  const lines = Math.round(el.getBoundingClientRect().height / BODY_LINE_H);
  if (lines < MIN_LINES || !fits(content)) {
    el.remove();
    return null;
  }
  const rest = orig.cloneNode(true) as HTMLElement;
  dropChars(rest, lo);
  return rest;
}

/** 把 el 内容重置为 orig 的前 n 个字符 */
function setTruncated(el: HTMLElement, orig: HTMLElement, n: number): void {
  const clone = orig.cloneNode(true) as HTMLElement;
  truncateChars(clone, n);
  el.innerHTML = clone.innerHTML;
}

function textLength(root: Node): number {
  return root.textContent?.length ?? 0;
}

/** 只保留前 n 个字符（按文本节点顺序） */
function truncateChars(root: Node, n: number): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let used = 0;
  let t: Text | null;
  while ((t = walker.nextNode() as Text | null)) {
    const len = t.data.length;
    if (used >= n) t.data = '';
    else if (used + len > n) t.data = t.data.slice(0, n - used);
    used += len;
  }
}

/** 去掉前 n 个字符（按文本节点顺序） */
function dropChars(root: Node, n: number): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let toDrop = n;
  let t: Text | null;
  while ((t = walker.nextNode() as Text | null)) {
    if (toDrop <= 0) break;
    const len = t.data.length;
    if (len <= toDrop) {
      t.data = '';
      toDrop -= len;
    } else {
      t.data = t.data.slice(toDrop);
      toDrop = 0;
    }
  }
}

/** 超大节点缩字号自救；到底仍溢出就交给 overflow:hidden 裁剪 */
function shrinkToFit(el: HTMLElement, content: HTMLElement): void {
  for (const size of [12, 11, 10, 9]) {
    el.style.fontSize = `${size}px`;
    el.querySelectorAll<HTMLElement>('*').forEach((c) => {
      if (c.style.fontSize) c.style.fontSize = `${size}px`;
    });
    if (fits(content)) return;
  }
  console.warn('[larksnap:xhs] 节点独占一卡仍放不下，已裁剪显示');
}

async function decodeImages(el: HTMLElement): Promise<void> {
  await Promise.all(
    Array.from(el.querySelectorAll('img')).map((img) => img.decode().catch(() => {}))
  );
}
