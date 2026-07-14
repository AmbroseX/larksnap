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
  img: ['src', 'alt', 'title'],
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

/** img 的 src：http/https/data/blob 放行；解析不出协议的当相对路径保留（编辑器再换成 blob） */
function isSafeImgSrc(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return true; // 相对路径（如 images/x.png）——留着交给 resolveSrc 处理
  }
  return (
    u.protocol === 'http:' ||
    u.protocol === 'https:' ||
    u.protocol === 'data:' ||
    u.protocol === 'blob:'
  );
}

function keepAttr(tag: string, name: string, value: string): boolean {
  if (!ALLOWED[tag]?.includes(name)) return false;
  if (tag === 'a' && name === 'href') return isSafeHref(value);
  if (tag === 'code' && name === 'class') return CODE_CLASS_RE.test(value);
  if (tag === 'img' && name === 'src') return isSafeImgSrc(value);
  return true;
}

function sanitizeChildren(parent: Element, allowImages: boolean): void {
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) continue;
    if (child.nodeType !== Node.ELEMENT_NODE) {
      child.remove(); // 注释、CDATA 等一律不留
      continue;
    }
    const el = child as Element;
    const tag = el.tagName.toLowerCase();

    // img 默认降级为 alt 文本（对话页渲染远程内容，不发外部请求防泄漏）；
    // 只有本地编辑器这类可信场景显式开 allowImages 才保留图片。
    if (tag === 'img') {
      if (!allowImages) {
        const alt = el.getAttribute('alt')?.trim();
        if (alt) el.replaceWith(el.ownerDocument.createTextNode(`[${alt}]`));
        else el.remove();
        continue;
      }
      // 保留 img，但按白名单裁属性（src 走 isSafeImgSrc），src 非法则整删
      for (const attr of Array.from(el.attributes)) {
        if (!keepAttr('img', attr.name.toLowerCase(), attr.value)) {
          el.removeAttribute(attr.name);
        }
      }
      if (!el.getAttribute('src')) el.remove();
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
    sanitizeChildren(el, allowImages);
  }
}

/**
 * 输入 marked 渲染出的 HTML（或任意不可信 HTML），输出白名单内的安全 HTML。
 * allowImages：默认 false（对话页删图防泄漏）；本地编辑器传 true 以保留图片。
 */
export function sanitizeHtml(html: string, allowImages = false): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  sanitizeChildren(doc.body, allowImages);
  return doc.body.innerHTML;
}
