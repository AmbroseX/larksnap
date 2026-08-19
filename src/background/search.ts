// 浏览器搜索（扩展侧）—— 后台打开搜索引擎结果页，把条目解析成结构化 JSON 回传给 CC。
//
// 定位：**只是替用户按一次搜索按钮**。一次任务只跑一个引擎、只取结果页第一页，
// 不翻页、不并发、不绕验证码。换引擎降级的策略在 CLI 侧（search.mjs 连发多次任务），
// 这里永远只管「打开这一个页面 → 解析 → 回结果」，职责单一。
//
// ⚠️ `extractSearchResults` 会被 chrome.scripting.executeScript({ func }) 序列化后注入
// 目标页面执行（同 screenshot/page.ts、editor-inject.ts 的约定）：**函数体内不得引用任何
// import、模块级常量或闭包变量**，所有 helper 必须写在函数体内部；参数与返回值必须可
// JSON 序列化。改这个函数时先想清楚这条，否则注入后会报 xxx is not defined。

/** 一条搜索结果 */
export interface SearchItem {
  rank: number;
  title: string;
  url: string;
  snippet: string;
  /** 结果域名，方便一眼看出来源 */
  site: string;
}

/** ok=有结果；empty=页面正常但零结果；blocked=撞上验证码/同意页 */
export type SearchStatus = 'ok' | 'empty' | 'blocked';

export interface SearchExtraction {
  status: SearchStatus;
  results: SearchItem[];
  /** blocked 时说明撞上了什么，CLI 据此给准确提示 */
  note?: string;
}

/**
 * 引擎表。**不传条数参数**：Google 的 `&num=` 2025 年起已被忽略、带上反而像脚本流量，
 * Bing 的 `count` 同样不可靠 —— 一律只拿第一页，解析完按 limit 截断。
 */
export const SEARCH_ENGINES = {
  // Bing 排第一：几乎不弹验证码、DOM 结构最稳、不要登录态，成功率最高
  bing: {
    label: 'Bing',
    host: 'www.bing.com',
    build: (q: string) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
  },
  // Google 结果质量最好，但最容易撞人机验证 → auto 里排第二
  google: {
    label: 'Google',
    host: 'www.google.com',
    build: (q: string) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  },
  // 用主站不用 html.duckduckgo.com：主站带真实 cookie/UA，跟用户手动搜一模一样
  ddg: {
    label: 'DuckDuckGo',
    host: 'duckduckgo.com',
    build: (q: string) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
  },
} as const;

export type SearchEngine = keyof typeof SEARCH_ENGINES;

export const SEARCH_ENGINE_IDS = Object.keys(SEARCH_ENGINES) as SearchEngine[];

export function isSearchEngine(v: string): v is SearchEngine {
  return Object.prototype.hasOwnProperty.call(SEARCH_ENGINES, v);
}

/** 拼结果页 URL；引擎名不认识或关键词为空返回 null */
export function buildSearchUrl(engine: string, query: string): string | null {
  if (!isSearchEngine(engine)) return null;
  const q = (query || '').trim();
  if (!q) return null;
  return SEARCH_ENGINES[engine].build(q);
}

/** 该引擎结果页所在域名（权限检查用） */
export function searchEngineHost(engine: string): string {
  return isSearchEngine(engine) ? SEARCH_ENGINES[engine].host : '';
}

/**
 * 注入结果页执行的解析器。**自包含**：所有 helper 写在函数体内，不引用任何外部东西。
 *
 * 两级策略，缺一不可：
 *  1. 选择器优先：按各引擎已知结构抓（准，但类名说变就变）。
 *  2. 结构兜底：选择器抓到 0 条时，扫描主内容区里带标题文本的外链，靠结构判断。
 *     搜索引擎迟早会改 DOM，写死选择器等于埋雷，兜底保证不至于直接归零。
 *
 * 「被拦」只在零结果时才判定 —— 否则搜「captcha」这类词会被自己的特征串误伤。
 */
export function extractSearchResults(engine: string, limit: number): SearchExtraction {
  const doc: Document = document;
  const cap = Math.max(1, Math.min(Number(limit) || 10, 20));

  const clean = (s: string | null | undefined): string => (s || '').replace(/\s+/g, ' ').trim();

  let pageUrl = '';
  try {
    pageUrl = doc.location ? doc.location.href : '';
  } catch {
    pageUrl = '';
  }
  const base = pageUrl || 'https://www.bing.com/';

  // 各引擎自家的域名：出现在结果里的都是导航/设置链接，不是搜索结果
  const INTERNAL: Record<string, string[]> = {
    bing: ['www.bing.com', 'bing.com', 'go.microsoft.com', 'login.live.com'],
    google: ['www.google.com', 'google.com', 'accounts.google.com', 'policies.google.com'],
    ddg: ['duckduckgo.com', 'www.duckduckgo.com', 'html.duckduckgo.com'],
  };
  const internalHosts = INTERNAL[engine] || [];

  /** 剥掉各家的跳转包装，拿到真实链接 */
  const unwrap = (raw: string | null): string => {
    const href = raw || '';
    try {
      const u = new URL(href, base);
      const q = u.searchParams.get('q');
      if (u.pathname === '/url' && q) return q; // Google: /url?q=
      const uddg = u.searchParams.get('uddg');
      if (uddg) return uddg; // DuckDuckGo: /l/?uddg=（URL 解析已自动解码）
      const bu = u.searchParams.get('u');
      if (u.pathname.indexOf('/ck/a') === 0 && bu && bu.indexOf('a1') === 0) {
        // Bing: /ck/a?...&u=a1<base64url>
        try {
          const b64 = bu.slice(2).replace(/-/g, '+').replace(/_/g, '/');
          const dec = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
          if (/^https?:\/\//i.test(dec)) return dec;
        } catch {
          /* 解不开就用原链接 */
        }
      }
      return u.href;
    } catch {
      return href;
    }
  };

  const isResultUrl = (u: string): boolean => {
    try {
      const p = new URL(u, base);
      if (p.protocol !== 'http:' && p.protocol !== 'https:') return false;
      if (internalHosts.indexOf(p.hostname) >= 0) return false;
      return true;
    } catch {
      return false;
    }
  };

  /** 从结果块里取摘要：块内全文减掉标题（innerText 在无头/单测环境不可靠，一律用 textContent） */
  const snippetFrom = (box: Element | null, title: string): string => {
    if (!box) return '';
    let t = clean(box.textContent);
    if (title) t = t.split(title).join(' ');
    return clean(t).slice(0, 400);
  };

  const out: SearchItem[] = [];
  const seen: Record<string, boolean> = {};
  const push = (title: string | null, rawHref: string | null, snippet: string | null): void => {
    const t = clean(title);
    if (!t) return;
    const url = unwrap(rawHref);
    if (!isResultUrl(url)) return;
    if (seen[url]) return;
    seen[url] = true;
    let site = '';
    try {
      site = new URL(url, base).hostname;
    } catch {
      site = '';
    }
    out.push({ rank: out.length + 1, title: t, url, snippet: clean(snippet).slice(0, 400), site });
  };

  const selectorPass = (): void => {
    if (engine === 'bing') {
      Array.from(doc.querySelectorAll('#b_results > li.b_algo')).forEach((li) => {
        const a = li.querySelector('h2 a[href]') || li.querySelector('a[href]');
        if (!a) return;
        const h2 = li.querySelector('h2');
        const cap2 =
          li.querySelector('.b_caption p') || li.querySelector('.b_algoSlug') || li.querySelector('p');
        push(h2 ? h2.textContent : a.textContent, a.getAttribute('href'), cap2 ? cap2.textContent : '');
      });
      return;
    }
    if (engine === 'google') {
      // 不用 `a:has(h3)`：linkedom 不支持 :has()，单测就跑不起来。先抓 h3 再 closest('a')。
      Array.from(doc.querySelectorAll('#search h3, #rso h3')).forEach((h3) => {
        const a =
          h3.closest('a[href]') ||
          (h3.parentElement ? h3.parentElement.querySelector('a[href]') : null);
        if (!a) return;
        const title = clean(h3.textContent);
        const box = h3.closest('div[data-hveid]') || h3.closest('div.g');
        push(title, a.getAttribute('href'), snippetFrom(box, title));
      });
      return;
    }
    if (engine === 'ddg') {
      Array.from(
        doc.querySelectorAll('article[data-testid="result"], li[data-layout="organic"], div.result')
      ).forEach((art) => {
        const a =
          art.querySelector('a[data-testid="result-title-a"]') ||
          art.querySelector('h2 a[href]') ||
          art.querySelector('a.result__a');
        if (!a) return;
        const title = clean(a.textContent);
        const sn = art.querySelector('[data-result="snippet"]') || art.querySelector('.result__snippet');
        push(title, a.getAttribute('href'), sn ? sn.textContent : snippetFrom(art, title));
      });
    }
  };

  /** 结构兜底：类名全变了也还能抓到东西 */
  const fallbackPass = (): void => {
    const scope =
      doc.querySelector('#b_results') ||
      doc.querySelector('#rso') ||
      doc.querySelector('#search') ||
      doc.querySelector('#links') ||
      doc.querySelector('main') ||
      doc.body;
    if (!scope) return;
    Array.from(scope.querySelectorAll('a[href]')).forEach((a) => {
      if (out.length >= cap) return;
      const title = clean(a.textContent);
      if (title.length < 8) return; // 太短的多半是「缓存 / 翻译 / 更多」这类功能链接
      push(title, a.getAttribute('href'), snippetFrom(a.closest('li, article, div'), title));
    });
  };

  /** 零结果时才查：是被拦了，还是真没搜到 */
  const blockedNote = (): string => {
    let host = '';
    let pathname = '';
    try {
      const u = new URL(base);
      host = u.hostname;
      pathname = u.pathname;
    } catch {
      /* 拿不到 URL 就只看页面文字 */
    }
    if (host.indexOf('consent.') === 0) return 'Google 同意页（consent）拦在前面';
    if (pathname.indexOf('/sorry') === 0) return 'Google 人机验证页（/sorry）';
    const text = clean(doc.body ? doc.body.textContent : '').slice(0, 4000);
    const signs: Array<{ re: RegExp; note: string }> = [
      { re: /unusual traffic|异常流量/i, note: '被判定为异常流量' },
      { re: /not a robot|verify you are (a )?human|请证明您不是机器人|人机验证/i, note: '要求人机验证' },
      { re: /before you continue to google|在继续前往 google/i, note: 'Google 同意页拦在前面' },
      { re: /bots use duckduckgo too/i, note: 'DuckDuckGo 反爬页' },
    ];
    for (let i = 0; i < signs.length; i++) if (signs[i].re.test(text)) return signs[i].note;
    return '';
  };

  selectorPass();
  if (out.length === 0) fallbackPass();
  if (out.length > 0) return { status: 'ok', results: out.slice(0, cap) };
  const note = blockedNote();
  return note ? { status: 'blocked', results: [], note } : { status: 'empty', results: [] };
}
