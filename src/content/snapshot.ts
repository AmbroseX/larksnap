/**
 * DOM 快照 —— HTML 导出与离线缓存共用。
 * 滚动加载全文（懒加载）→ clone document → 移除脚本/交互 → 内联样式与图片。
 *
 * 运行在 content script（页面上下文）。
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 滚动到底，触发飞书编辑器的懒加载渲染 */
export async function scrollLoadAll(maxSteps = 60): Promise<void> {
  // 飞书正文滚动容器不固定，优先滚 window，再兜底滚可滚动元素
  let lastHeight = 0;
  for (let i = 0; i < maxSteps; i++) {
    window.scrollTo(0, document.body.scrollHeight);
    const containers = document.querySelectorAll<HTMLElement>(
      '.bear-web-x-container, .docx-page-block, [data-page-id], .page-block-children'
    );
    containers.forEach((el) => (el.scrollTop = el.scrollHeight));
    await sleep(250);
    const h = document.body.scrollHeight;
    if (h === lastHeight && i > 2) break;
    lastHeight = h;
  }
  window.scrollTo(0, 0);
  await sleep(200);
}

/** 把图片 src 转 dataURL（同源 + 登录态可取） */
async function inlineImages(doc: Document): Promise<void> {
  const imgs = Array.from(doc.querySelectorAll('img'));
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute('src');
      if (!src || src.startsWith('data:')) return;
      try {
        const res = await fetch(src, { credentials: 'include' });
        const blob = await res.blob();
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result as string);
          fr.onerror = reject;
          fr.readAsDataURL(blob);
        });
        img.setAttribute('src', dataUrl);
        img.removeAttribute('srcset');
      } catch {
        /* 单图失败不阻断整体（宪法原则 III） */
      }
    })
  );
}

/** 内联所有同源样式表为 <style> */
function inlineStyles(doc: Document): void {
  const links = Array.from(
    doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')
  );
  // 同步收集已加载样式（document.styleSheets），跨域表跳过
  const cssTexts: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const rules = sheet.cssRules;
      let text = '';
      for (const rule of Array.from(rules)) text += rule.cssText + '\n';
      if (text) cssTexts.push(text);
    } catch {
      /* 跨域样式表无法读取，跳过 */
    }
  }
  links.forEach((l) => l.remove());
  if (cssTexts.length) {
    const style = doc.createElement('style');
    style.textContent = cssTexts.join('\n');
    doc.head.appendChild(style);
  }
}

/** 生成单文件 HTML 快照 */
export async function captureSnapshot(): Promise<{
  html: string;
  title: string;
  capturedAt: number;
}> {
  await scrollLoadAll();
  const clone = document.cloneNode(true) as Document;

  // 移除脚本与交互元素
  clone
    .querySelectorAll('script, noscript, iframe, [contenteditable]')
    .forEach((el) => {
      if (el.tagName === 'SCRIPT' || el.tagName === 'NOSCRIPT' || el.tagName === 'IFRAME') {
        el.remove();
      } else {
        el.removeAttribute('contenteditable');
      }
    });

  inlineStyles(clone);
  await inlineImages(clone);

  const html = '<!DOCTYPE html>\n' + clone.documentElement.outerHTML;
  return { html, title: document.title, capturedAt: Date.now() };
}
