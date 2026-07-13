import type TurndownService from 'turndown';

/**
 * 图片规则（002.1b）：懒加载兼容 + 绝对化 + 两种模式。
 *   - 'link'（默认）：保留外链，data-src / data-original / srcset 兜底取真图
 *   - 'base64'：借页面里已加载好的同图 <img> 画 canvas 内联；
 *     跨域图 canvas 被污染取不到时回退外链（零网络请求，不另行下载）
 */

export type PageImageMode = 'link' | 'base64';

function pickSrc(img: HTMLElement): string {
  const raw =
    img.getAttribute('data-src') ||
    img.getAttribute('data-original') ||
    img.getAttribute('src') ||
    firstSrcset(img.getAttribute('srcset')) ||
    '';
  return raw;
}

/** srcset 取第一个候选的 URL */
function firstSrcset(srcset: string | null): string {
  if (!srcset) return '';
  return srcset.split(',')[0]?.trim().split(/\s+/)[0] ?? '';
}

function toAbsolute(url: string): string {
  try {
    return new URL(url, document.baseURI).href;
  } catch {
    return url;
  }
}

/** 在实时页面里找同 src 的已加载 <img>，画 canvas 转 dataURL；失败返回空 */
function tryInlineBase64(absUrl: string): string {
  const live = Array.from(document.images).find(
    (i) => i.currentSrc === absUrl || i.src === absUrl
  );
  if (!live || !live.complete || live.naturalWidth === 0) return '';
  try {
    const canvas = document.createElement('canvas');
    canvas.width = live.naturalWidth;
    canvas.height = live.naturalHeight;
    canvas.getContext('2d')?.drawImage(live, 0, 0);
    return canvas.toDataURL('image/png');
  } catch {
    // 跨域污染（SecurityError）：回退外链
    return '';
  }
}

export function addImageRule(td: TurndownService, mode: PageImageMode): void {
  td.addRule('image-absolute', {
    filter: 'img',
    replacement: (_content, node) => {
      const img = node as HTMLElement;
      const raw = pickSrc(img);
      if (!raw) return '';
      const alt = (img.getAttribute('alt') || '').replace(/[\[\]\n]/g, ' ');
      if (raw.startsWith('data:')) {
        // 页面原生内联的小图标：base64 模式保留，link 模式丢弃（跟旧行为一致）
        return mode === 'base64' ? `![${alt}](${raw})` : '';
      }
      const abs = toAbsolute(raw);
      if (mode === 'base64') {
        const inline = tryInlineBase64(abs);
        if (inline) return `![${alt}](${inline})`;
      }
      return `![${alt}](${abs})`;
    },
  });
}
