import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import type { WebCopyMdResult } from '../../shared/types';

/**
 * HTML → Markdown 转换管线（技术方案 §3）：
 *   整页：Readability 提取正文（失败降级全 body）→ Turndown
 *   选区：cloneContents 序列化 → Turndown
 * 链接/图片统一补全为绝对 URL；图片保留外链不下载（P0）。
 */

let turndown: TurndownService | null = null;

function getTurndown(): TurndownService {
  if (turndown) return turndown;
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  gfm(td);

  // 交互元素直接丢弃
  td.remove(['script', 'style', 'noscript']);
  td.addRule('drop-interactive', {
    filter: ['iframe', 'form', 'button', 'input', 'select', 'textarea'],
    replacement: () => '',
  });

  // 图片：优先 data-src（微信公众号等懒加载），补全绝对 URL
  td.addRule('image-absolute', {
    filter: 'img',
    replacement: (_content, node) => {
      const img = node as HTMLElement;
      const src =
        img.getAttribute('data-src') ||
        img.getAttribute('data-original') ||
        img.getAttribute('src') ||
        '';
      if (!src || src.startsWith('data:')) return '';
      const alt = (img.getAttribute('alt') || '').replace(/[\[\]\n]/g, ' ');
      return `![${alt}](${toAbsolute(src)})`;
    },
  });

  // 链接补全绝对 URL；无有效 href 的退化为纯文本
  td.addRule('link-absolute', {
    filter: (node) =>
      node.nodeName === 'A' && !!(node as HTMLElement).getAttribute('href'),
    replacement: (content, node) => {
      const href = (node as HTMLElement).getAttribute('href') || '';
      if (!content.trim()) return '';
      if (href.startsWith('#') || href.startsWith('javascript:')) return content;
      return `[${content}](${toAbsolute(href)})`;
    },
  });

  // <pre> 统一提纯为 fenced 代码块：兼容 CSDN/掘金那类
  // 高亮行号表格嵌套结构，直接取代码文本，不让表格规则搅进来
  td.addRule('pre-purify', {
    filter: 'pre',
    replacement: (_content, node) => {
      const pre = node as HTMLElement;
      const code = pre.querySelector('code');
      const text = (code ?? pre).textContent ?? '';
      const lang = detectLang(pre, code);
      const trimmed = text.replace(/\n+$/, '');
      return `\n\n\`\`\`${lang}\n${trimmed}\n\`\`\`\n\n`;
    },
  });

  turndown = td;
  return td;
}

/** 从 class（language-xxx / lang-xxx）里猜代码语言 */
function detectLang(pre: HTMLElement, code: HTMLElement | null): string {
  const cls = `${pre.className} ${code?.className ?? ''}`;
  const m = cls.match(/(?:language|lang)-([\w+#-]+)/i);
  return m ? m[1].toLowerCase() : '';
}

function toAbsolute(url: string): string {
  try {
    return new URL(url, location.href).href;
  } catch {
    return url;
  }
}

/** 整页转 Markdown：Readability 提正文，失败降级全 body */
export function pageToMarkdown(): WebCopyMdResult {
  // Readability 会改 DOM，必须克隆
  const clone = document.cloneNode(true) as Document;
  let html = '';
  let title = document.title;
  try {
    const article = new Readability(clone).parse();
    if (article?.content) {
      html = article.content;
      title = article.title || title;
    }
  } catch {
    // SPA / 结构怪异页：走降级
  }
  if (!html) {
    const body = document.body.cloneNode(true) as HTMLElement;
    body
      .querySelectorAll('script,style,noscript,iframe')
      .forEach((el) => el.remove());
    html = body.innerHTML;
  }

  const md = getTurndown().turndown(html);
  const header = `# ${title}\n\n> 来源：${location.href}　·　抓取时间：${new Date().toISOString()}\n\n`;
  return { markdown: header + md, title };
}

/** 选区转 Markdown：支持多段选区，无选区时报错 */
export function selectionToMarkdown(): WebCopyMdResult {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    throw new Error('当前没有选中内容');
  }
  const holder = document.createElement('div');
  for (let i = 0; i < sel.rangeCount; i++) {
    holder.appendChild(sel.getRangeAt(i).cloneContents());
  }
  const markdown = getTurndown().turndown(holder.innerHTML);
  return { markdown, title: document.title };
}

/** 选区纯文本（自动复制的 text 格式用） */
export function selectionText(): string {
  return window.getSelection()?.toString() ?? '';
}
