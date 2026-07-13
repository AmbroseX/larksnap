/**
 * DOM 遍历白名单 sanitizer（007，评审阻断项 3）。
 * 不用正则过滤——正则挡不住实体编码、大小写/空白变体、SVG/MathML 向量；
 * 这里让 DOMParser 先完成实体解码与结构归一，再按白名单裁剪：
 *   - 标签白名单之外的元素连同子树整体丢弃（script/style/iframe/svg/math/form 全灭）；
 *   - 属性按标签白名单，白名单外一律剥（on* 自然不存在）；
 *   - href 用 URL 解析后只许 http/https；
 *   - img 不渲染，降级为 alt 文本（远程图片会向第三方泄漏浏览行为）。
 * 侧边栏是扩展页有严格 CSP，此处是纵深防御的第二道闸。
 */

/** 标签 → 允许保留的属性名集合 */
const ALLOWED: Record<string, ReadonlyArray<string>> = {
  p: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  h5: [],
  h6: [],
  ul: [],
  ol: [],
  li: [],
  blockquote: [],
  pre: [],
  code: ['class'],
  table: [],
  thead: [],
  tbody: [],
  tr: [],
  th: ['align'],
  td: ['align'],
  a: ['href'],
  strong: [],
  em: [],
  del: [],
  hr: [],
  br: [],
};

/** code 的 class 只放行 marked 生成的语言标注 */
const CODE_CLASS_RE = /^language-[\w+#.-]+$/;

function isSafeHref(value: string): boolean {
  try {
    // 相对地址挂到占位 base 上解析：协议只可能落在 http/https，锚点/相对链接无害
    const url = new URL(value, 'https://placeholder.invalid/');
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function keepAttr(tag: string, name: string, value: string): boolean {
  if (!ALLOWED[tag]?.includes(name)) return false;
  if (tag === 'a' && name === 'href') return isSafeHref(value);
  if (tag === 'code' && name === 'class') return CODE_CLASS_RE.test(value);
  return true;
}

function sanitizeChildren(parent: Element): void {
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) continue;
    if (child.nodeType !== Node.ELEMENT_NODE) {
      child.remove(); // 注释、CDATA 等一律不留
      continue;
    }
    const el = child as Element;
    const tag = el.tagName.toLowerCase();

    // 图片降级为 alt 文本（不发外部请求）
    if (tag === 'img') {
      const alt = el.getAttribute('alt')?.trim();
      if (alt) el.replaceWith(el.ownerDocument.createTextNode(`[${alt}]`));
      else el.remove();
      continue;
    }

    if (!(tag in ALLOWED)) {
      el.remove(); // 连同子树整体丢弃，不做「拆壳留子」——SVG/MathML 里的载荷没机会漏出
      continue;
    }

    for (const attr of Array.from(el.attributes)) {
      if (!keepAttr(tag, attr.name.toLowerCase(), attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
    if (tag === 'a') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
    sanitizeChildren(el);
  }
}

/** 输入 marked 渲染出的 HTML（或任意不可信 HTML），输出白名单内的安全 HTML */
export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  sanitizeChildren(doc.body);
  return doc.body.innerHTML;
}
