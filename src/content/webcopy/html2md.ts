import TurndownService from 'turndown';
import {
  highlightedCodeBlock,
  strikethrough,
  taskListItems,
} from 'turndown-plugin-gfm';
import type { WebCopyMdResult } from '../../shared/types';
import { extractArticle } from './extract';
import { buildFrontmatter } from './frontmatter';
import { addTableRule } from './rules/table';
import { addCodeRule } from './rules/code';
import { addMathRule } from './rules/math';
import { addImageRule, type PageImageMode } from './rules/image';

/**
 * HTML → Markdown 转换管线（002.1 升级版）：
 *   整页：Defuddle 提取正文（兜底选择器链 / 非 HTML 短路）→ Turndown 精配置
 *   选区：cloneContents 序列化 → Turndown
 * 表格/代码/公式/图片走 rules/ 四条自定义规则；链接统一补全绝对 URL。
 */

export interface PageMdOptions {
  /** 开头输出 YAML frontmatter；关闭则用简单标题头 */
  frontmatter?: boolean;
  /** 图片模式：外链（默认）/ base64 内联 */
  imageMode?: PageImageMode;
}

/** Turndown 精配置（MarkDownload / Obsidian Clipper / MarkSnip 共同验证过的组合） */
function createService(imageMode: PageImageMode, mini: boolean): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
    preformattedCode: true,
  });
  td.use([highlightedCodeBlock, strikethrough, taskListItems]);
  // 结构性内嵌标签原样保留（iframe 嵌入、上下标等 MD 表达不了的）
  td.keep(['iframe', 'sub', 'sup', 'u', 'ins', 'small', 'big'] as unknown as (keyof HTMLElementTagNameMap)[]);
  // 关掉过度转义：默认会把正文里的 snake_case 转成 snake\_case，得不偿失
  (td as unknown as { escape: (s: string) => string }).escape = (s) => s;

  // 删除线统一双波浪线（gfm 插件默认单波浪线，部分渲染器不认）
  td.addRule('strikethrough-double', {
    filter: ['del', 's'],
    replacement: (content) => `~~${content}~~`,
  });

  // 交互元素直接丢弃（iframe 走 keep 保留嵌入源）；
  // 例外：列表项里的 checkbox 留给 taskListItems 插件转 [x]/[ ]
  td.remove(['script', 'style', 'noscript']);
  td.addRule('drop-interactive', {
    filter: (node) => {
      const name = node.nodeName;
      if (name === 'FORM' || name === 'BUTTON' || name === 'SELECT' || name === 'TEXTAREA') return true;
      if (name !== 'INPUT') return false;
      const input = node as HTMLInputElement;
      return !(input.type === 'checkbox' && node.parentNode?.nodeName === 'LI');
    },
    replacement: () => '',
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

  addCodeRule(td);
  addMathRule(td);
  addImageRule(td, imageMode);
  // mini 实例给表格单元格递归用，自己不再挂表格规则（嵌套表格按普通内容展开）
  if (!mini) {
    addTableRule(td, () => getService(imageMode, true));
  }
  return td;
}

const services = new Map<string, TurndownService>();

function getService(imageMode: PageImageMode, mini = false): TurndownService {
  const key = `${imageMode}:${mini}`;
  let td = services.get(key);
  if (!td) {
    td = createService(imageMode, mini);
    services.set(key, td);
  }
  return td;
}

function toAbsolute(url: string): string {
  try {
    return new URL(url, document.baseURI).href;
  } catch {
    return url;
  }
}

/** 整页转 Markdown：Defuddle 提正文（含兜底），可选 frontmatter */
export function pageToMarkdown(opts: PageMdOptions = {}): WebCopyMdResult {
  const { frontmatter = true, imageMode = 'link' } = opts;
  const article = extractArticle();
  const title = article.meta.title || document.title;

  const body =
    article.source === 'raw-text' || article.source === 'pre'
      ? (article.text ?? '')
      : getService(imageMode).turndown(article.contentHtml);

  const head = frontmatter
    ? `${buildFrontmatter(article.meta, location.href)}# ${title}\n\n`
    : `# ${title}\n\n> 来源：${location.href}　·　抓取时间：${new Date().toISOString()}\n\n`;

  return {
    markdown: head + body,
    title,
    source: article.source,
    degraded: article.degraded,
  };
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
  const markdown = getService('link').turndown(holder.innerHTML);
  return { markdown, title: document.title };
}

/** 选区纯文本（自动复制的 text 格式用） */
export function selectionText(): string {
  return window.getSelection()?.toString() ?? '';
}
