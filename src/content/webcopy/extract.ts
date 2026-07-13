import Defuddle from 'defuddle';

/**
 * 正文提取（002 升级：Defuddle 引擎 + 兜底选择器链 + 边界短路）。
 * 提取器实现藏在 extractArticle() 后面，调用方只关心结果结构。
 */

export interface ArticleMeta {
  title?: string;
  author?: string;
  published?: string;
  description?: string;
  site?: string;
}

export interface ArticleExtractResult {
  /** 正文 HTML（raw-text / pre 短路时为空，用 text 字段） */
  contentHtml: string;
  /** 非 HTML 页面的原始文本（source 为 raw-text / pre 时有值） */
  text?: string;
  meta: ArticleMeta;
  source: 'defuddle' | 'fallback' | 'raw-text' | 'pre';
  /** 走了兜底链，正文识别可能不全 */
  degraded: boolean;
}

/** 兜底选择器链：按序取首个正文文本 > 80 字的根节点 */
const FALLBACK_SELECTORS = [
  'main',
  '[role="main"]',
  '#main-content',
  '#main',
  'article',
  'body',
];

export function extractArticle(): ArticleExtractResult {
  const baseMeta: ArticleMeta = { title: document.title };

  // 边界短路①：非 HTML 文档（txt/json/xml 被浏览器包成 DOM），直接取原始文本
  if (document.contentType && document.contentType !== 'text/html') {
    return {
      contentHtml: '',
      text: document.body?.textContent ?? '',
      meta: baseMeta,
      source: 'raw-text',
      degraded: false,
    };
  }

  // 边界短路②：body 是单个 <pre>（浏览器渲染 .txt/.md 原文页）
  const bodyKids = Array.from(document.body?.children ?? []);
  if (bodyKids.length === 1 && bodyKids[0].tagName === 'PRE') {
    return {
      contentHtml: '',
      text: bodyKids[0].textContent ?? '',
      meta: baseMeta,
      source: 'pre',
      degraded: false,
    };
  }

  // Defuddle 会改传入的 document（剥 script 等），必须喂克隆
  try {
    const clone = document.cloneNode(true) as Document;
    const result = new Defuddle(clone, {
      url: location.href,
      // 隐私红线（宪法 V）：禁止提取失败时请求第三方 API 兜底
      useAsync: false,
      // 实测这个"样板模式清理"会误删正文里的短要点列表（丢内容比留噪音严重），
      // 页眉页脚等噪音仍由选择器清理 + 低分内容清理兜住
      removeContentPatterns: false,
    }).parse();
    if (result.content && result.content.trim().length > 0) {
      return {
        contentHtml: result.content,
        meta: {
          title: result.title || document.title,
          author: result.author || undefined,
          published: result.published || undefined,
          description: result.description || undefined,
          site: result.site || undefined,
        },
        source: 'defuddle',
        degraded: false,
      };
    }
  } catch {
    // 提取器崩了不影响兜底链
  }

  // 兜底选择器链
  for (const sel of FALLBACK_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    if ((el.textContent ?? '').trim().length <= 80) continue;
    const root = el.cloneNode(true) as HTMLElement;
    root
      .querySelectorAll('script,style,noscript')
      .forEach((node) => node.remove());
    return {
      contentHtml: root.innerHTML,
      meta: baseMeta,
      source: 'fallback',
      degraded: true,
    };
  }

  // 连 body 都没过 80 字：整页照收，保证有产物
  const body = (document.body?.cloneNode(true) as HTMLElement) ?? null;
  body?.querySelectorAll('script,style,noscript').forEach((n) => n.remove());
  return {
    contentHtml: body?.innerHTML ?? '',
    meta: baseMeta,
    source: 'fallback',
    degraded: true,
  };
}
