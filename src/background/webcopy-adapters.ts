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

/**
 * extractor 命中确定性失败时的终止原因。带 abort 的结果不再退通用管线
 * （登录墙/风控页退到通用管线只会抓到垃圾），上层据此回明确错误：
 * - need-login：页面要求登录（bridge 路径回 need-login 让用户去浏览器登录）
 * - blocked：被站点风控拦截
 * - not-found：内容不存在或已删除
 * - extract-failed：确认是目标页面但两层提取都失败（页面结构可能已变化）
 */
export type AdapterAbort = 'need-login' | 'blocked' | 'not-found' | 'extract-failed';

export interface AdapterExtractResult {
  markdown: string;
  title: string;
  /** 附加说明；abort 时为给人读的失败原因 */
  note?: string;
  abort?: AdapterAbort;
}

export interface SiteAdapter {
  name: string;
  match: (host: string) => boolean;
  /** 注入主世界执行的自包含函数，返回结果、带 abort 的失败、或 null（不适用此页则退回通用管线） */
  extractor: () => AdapterExtractResult | null;
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

/**
 * 小红书笔记：页面 SSR，登录后笔记数据整包在 window.__INITIAL_STATE__.note
 * .noteDetailMap[noteId] 里（免 x-s/x-t 签名）。未登录会 302 到 /login。
 * 首选结构化数据（轮播顺序可靠），DOM 选择器兜底。
 */
function xiaohongshuExtractor(): AdapterExtractResult | null {
  const fail = (abort: AdapterAbort, note: string): AdapterExtractResult => ({
    markdown: '',
    title: '',
    note,
    abort,
  });

  // —— 异常页面识别（先于取数据，登录墙/风控页也有 __INITIAL_STATE__ 骨架）——
  const bodyText = (document.body?.innerText || '').slice(0, 3000);
  if (location.pathname.startsWith('/login') || /登录后查看|请登录/.test(bodyText)) {
    return fail('need-login', '需要登录小红书：请在 Chrome 中打开 xiaohongshu.com 登录后重试');
  }
  if (/error_code=(300017|300031)/.test(location.href) || /安全限制|访问链接异常/.test(bodyText)) {
    return fail('blocked', '被小红书风控拦截（安全限制/访问链接异常），请稍后在浏览器中手动打开确认');
  }
  if (/页面不见了|笔记不存在|无法浏览/.test(bodyText)) {
    return fail('not-found', '笔记不存在或已被删除');
  }

  // —— 笔记 ID：从当前 URL 现取（短链 302 后 pathname 已是完整链接）——
  const idMatch =
    location.pathname.match(/(?:explore|note|search_result|discovery\/item)\/([a-f0-9]+)/) ||
    location.pathname.match(/user\/profile\/[a-zA-Z0-9]+\/([a-f0-9]+)/);
  const noteId = idMatch ? idMatch[1] : '';

  // —— 首选 __INITIAL_STATE__（兼容 entry.note || entry 两种包装）——
  let note: any = null;
  try {
    const detailMap = (window as any).__INITIAL_STATE__?.note?.noteDetailMap;
    if (detailMap && typeof detailMap === 'object') {
      const entry = noteId ? detailMap[noteId] : undefined;
      if (entry) note = entry.note || entry;
      if (!note) {
        // 单条兜底：key 与 URL 对不上时（排除未登录的 "undefined" 空壳）
        const keys = Object.keys(detailMap).filter((k) => k !== 'undefined');
        if (keys.length === 1) {
          const e = detailMap[keys[0]];
          note = e?.note || e;
        }
      }
      if (note && typeof note !== 'object') note = null;
    }
  } catch {
    note = null;
  }

  // —— 公共小工具（extractor 必须自包含，全部就地定义）——
  const cleanImageUrl = (raw: unknown): string => {
    if (!raw || typeof raw !== 'string') return '';
    return raw.split('?')[0].replace(/\/imageView2?\/\d+\/w\/\d+.*$/, '');
  };
  const isXhsCdn = (u: string) =>
    u.includes('xhscdn') || u.includes('xiaohongshu') || u.includes('rednote');
  // desc 里话题呈 `#话题名[话题]#` 标记，清理成普通 #话题名；
  // 原文段落间有整行制表符，行尾空白一并清掉（行首 tab 会被 Markdown 当代码块）
  const cleanDesc = (raw: string) =>
    raw.replace(/#([^#[\]\n]+)\[话题\]#/g, '#$1').replace(/[ \t]+$/gm, '').trim();
  const fmtDate = (t: unknown): string => {
    let n = Number(t);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 1e12) n *= 1000; // 秒级时间戳兼容
    const d = new Date(n);
    const pad = (x: number) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  // 来源链接：清理跟踪参数，保留 xsec_token（裸链接已不可达）
  let sourceUrl = location.href;
  try {
    const u = new URL(location.href);
    const token = u.searchParams.get('xsec_token');
    const src = u.searchParams.get('xsec_source');
    u.search = '';
    if (token) u.searchParams.set('xsec_token', token);
    if (src) u.searchParams.set('xsec_source', src);
    sourceUrl = u.toString();
  } catch {
    /* 保留原链接 */
  }

  // —— 取字段：结构化优先，DOM 兜底 ——
  let title = '';
  let desc = '';
  let author = '';
  let published = '';
  let ipLocation = '';
  let liked = '';
  let collected = '';
  let comments = '';
  const images: string[] = [];
  let videoUrl = '';
  let tags: string[] = [];

  if (note) {
    title = String(note.title || '').trim();
    desc = cleanDesc(String(note.desc || ''));
    author = String(note.user?.nickname || '').trim();
    published = fmtDate(note.time);
    ipLocation = String(note.ipLocation || '').trim();
    liked = String(note.interactInfo?.likedCount ?? '');
    collected = String(note.interactInfo?.collectedCount ?? '');
    comments = String(note.interactInfo?.commentCount ?? '');
    if (Array.isArray(note.imageList)) {
      for (const item of note.imageList) {
        // 数组顺序即轮播顺序；urlDefault 是权威 CDN 地址
        const candidate =
          item?.urlDefault ||
          item?.urlPre ||
          item?.url ||
          item?.infoList?.find((i: any) => i?.imageScene === 'WB_DFT')?.url ||
          item?.infoList?.[0]?.url ||
          '';
        const src = cleanImageUrl(candidate);
        if (src && isXhsCdn(src) && !images.includes(src)) images.push(src);
      }
    }
    const video = note.video;
    if (video) {
      const streams = video.media?.stream?.h264;
      const master = Array.isArray(streams)
        ? streams.find((s: any) => s?.masterUrl)?.masterUrl
        : '';
      const key = video.consumer?.originVideoKey || '';
      videoUrl = master || (key ? `https://sns-video-bd.xhscdn.com/${key}` : '');
    }
    if (Array.isArray(note.tagList)) {
      tags = note.tagList.map((t: any) => String(t?.name || '').trim()).filter(Boolean);
    }
  }

  // —— DOM 兜底（__INITIAL_STATE__ 结构漂移时）——
  if (!title) title = document.querySelector('#detail-title')?.textContent?.trim() || '';
  if (!desc) desc = cleanDesc(document.querySelector('#detail-desc')?.textContent || '');
  if (!author) author = document.querySelector('.username')?.textContent?.trim() || '';
  if (!liked) {
    // 互动数必须限定在 .interact-container 内取，否则会匹配到评论区的数字
    const box = document.querySelector('.interact-container');
    liked = box?.querySelector('.like-wrapper .count')?.textContent?.trim() || '';
    collected = collected || box?.querySelector('.collect-wrapper .count')?.textContent?.trim() || '';
    comments = comments || box?.querySelector('.chat-wrapper .count')?.textContent?.trim() || '';
  }
  if (images.length === 0) {
    const selectors = ['.swiper-slide img', '.note-slider img', '.media-container img'];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach((img) => {
        const el = img as HTMLImageElement;
        const src = cleanImageUrl(el.src || el.getAttribute('data-src') || '');
        if (src && isXhsCdn(src) && !images.includes(src)) images.push(src);
      });
    }
  }

  // 两层都失败：回明确错误而非空文件（也不退通用管线抓导航壳）
  if (!title && !desc && images.length === 0 && !videoUrl) {
    return fail('extract-failed', '未能提取到笔记内容（小红书页面结构可能已变化）');
  }
  if (!title) title = desc.split('\n')[0].slice(0, 50).trim() || '无标题';

  // —— 拼 Markdown ——
  const metaLine1 = [
    author && `作者：${author}`,
    published && `发布：${published}`,
    ipLocation && `IP 属地：${ipLocation}`,
  ]
    .filter(Boolean)
    .join(' ｜ ');
  const metaLine2 = [liked && `赞 ${liked}`, collected && `收藏 ${collected}`, comments && `评论 ${comments}`]
    .filter(Boolean)
    .join(' ｜ ');
  const parts: string[] = [`# ${title}`];
  const metaLines = [metaLine1, metaLine2, `来源：${sourceUrl}`]
    .filter(Boolean)
    .map((l) => `> ${l}`);
  parts.push(metaLines.join('\n'));
  if (desc) parts.push(desc);
  if (images.length > 0) parts.push(images.map((u, i) => `![图${i + 1}](${u})`).join('\n'));
  if (videoUrl) parts.push(`[视频直链](${videoUrl})（CDN 签名可能过期，请尽快另存）`);
  if (tags.length > 0) parts.push(`标签：${tags.map((t) => `#${t}`).join(' ')}`);

  return { markdown: parts.join('\n\n') + '\n', title };
}

export const SITE_ADAPTERS: SiteAdapter[] = [
  {
    name: 'baidu-wenku',
    match: (host) => /(^|\.)wenku\.baidu\.com$/.test(host),
    extractor: wenkuExtractor,
  },
  {
    name: 'xiaohongshu',
    // rednote.com 是小红书海外域名，同一套前端
    match: (host) => /(^|\.)(xiaohongshu|rednote)\.com$/.test(host),
    extractor: xiaohongshuExtractor,
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
