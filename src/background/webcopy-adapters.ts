import type { WebCopyMdResult } from '../shared/types';

/**
 * 站点专属适配器（技术方案 §3 的补充）。
 *
 * 绝大多数网页走通用管线（Readability + Turndown）。个别站点正文不在 DOM 里
 * ——比如百度文库把正文渲染进 <canvas>，真正的文字藏在签名的云存储 JSON 里，
 * 通用管线只能抓到导航栏那点文字。这类站点单独写适配器。
 *
 * 适配器在页面主世界（world: 'MAIN'）执行：既能读到页面自己的全局变量
 * （如 window.pageData），fetch 也走页面 origin（跨域 JSON 的 CORS 已放行），
 * 还不受页面 CSP 对内联脚本的限制。
 */

export interface SiteAdapter {
  name: string;
  match: (host: string) => boolean;
  /** 注入主世界执行的自包含函数，返回结果或 null（拿不到就退回通用管线） */
  extractor: () => { markdown: string; title: string; note?: string } | null;
}

// ⚠️ extractor 会被序列化后在页面主世界运行，必须完全自包含：
// 不能引用本文件/外部作用域的任何变量或函数。

/** 百度文库：正文是逐字（word）带坐标的 JSON，按 _enter 还原换行拼接 */
function wenkuExtractor(): { markdown: string; title: string; note?: string } | null {
  const pd = (window as unknown as { pageData?: any }).pageData;
  const ri = pd?.readerInfo;
  const jsonPages: Array<{ pageLoadUrl: string }> = ri?.htmlUrls?.json;
  if (!jsonPages || jsonPages.length === 0) return null;

  const title = String(pd?.title || document.title || '百度文库文档').replace(
    /\s*-\s*百度文库\s*$/,
    ''
  );

  // 注意：executeStript 的返回值必须是可序列化的普通对象，故整个抓取用同步
  // 收尾——这里返回 Promise 让外层 await（Chrome 支持 func 返回 Promise）。
  const fetchPage = async (url: string): Promise<any> => {
    const txt = await (await fetch(url)).text();
    // JSONP 包裹：wenku_N({...})
    const body = txt.replace(/^[^(]*\(/, '').replace(/\)\s*;?\s*$/, '');
    return JSON.parse(body);
  };

  const build = async () => {
    let out = '';
    for (const p of jsonPages) {
      try {
        const j = await fetchPage(p.pageLoadUrl);
        for (const el of j.body || []) {
          if (el && el.t === 'word' && typeof el.c === 'string') {
            out += el.c;
            if (el.ps && el.ps._enter) out += '\n';
          }
        }
      } catch {
        // 单页失败跳过，尽力拼其余页
      }
    }
    out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!out) return null;

    const showPage = Number(ri?.showPage) || 0;
    const total = Number(ri?.page) || 0;
    const clipped =
      total > showPage && showPage > 0
        ? `\n\n> ⚠️ 百度文库仅开放前 ${showPage}/${total} 页预览，其余为付费内容，无法抓取。`
        : '';
    const header = `# ${title}\n\n> 来源：${location.href}\n\n`;
    return {
      markdown: header + out + clipped,
      title,
      note: clipped ? `仅抓取到前 ${showPage}/${total} 页` : undefined,
    };
  };

  // 返回 Promise，executeScript 会等它 resolve
  return build() as unknown as {
    markdown: string;
    title: string;
    note?: string;
  } | null;
}

export const SITE_ADAPTERS: SiteAdapter[] = [
  {
    name: 'baidu-wenku',
    match: (host) => /(^|\.)wenku\.baidu\.com$/.test(host),
    extractor: wenkuExtractor,
  },
];

/** 按 host 找命中的适配器 */
export function findAdapter(url: string): SiteAdapter | null {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  return SITE_ADAPTERS.find((a) => a.match(host)) ?? null;
}
