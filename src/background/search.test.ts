import { describe, it, expect, afterEach } from 'vitest';
import { parseHTML } from 'linkedom';
import {
  buildSearchUrl,
  extractSearchResults,
  isSearchEngine,
  searchEngineHost,
  SEARCH_ENGINE_IDS,
} from './search';

/**
 * 解析器是注入页面执行的自包含函数，这里用 linkedom 造 document 直接调它，
 * 不依赖浏览器。固件都是手写的精简结构，够复现各引擎的关键形状即可。
 */
function withDoc<T>(html: string, pageUrl: string, fn: () => T): T {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  Object.defineProperty(document, 'location', { value: { href: pageUrl }, configurable: true });
  (globalThis as unknown as { document: Document }).document = document as unknown as Document;
  return fn();
}

afterEach(() => {
  delete (globalThis as unknown as { document?: Document }).document;
});

const BING_URL = 'https://www.bing.com/search?q=test';
const GOOGLE_URL = 'https://www.google.com/search?q=test';
const DDG_URL = 'https://duckduckgo.com/?q=test';

const BING_HTML = `
<ol id="b_results">
  <li class="b_algo">
    <h2><a href="https://vitest.dev/guide/">Vitest 上手指南</a></h2>
    <div class="b_caption"><p>Vitest 是一个由 Vite 驱动的单元测试框架。</p></div>
  </li>
  <li class="b_algo">
    <h2><a href="https://cn.vitejs.dev/">Vite 官方中文文档</a></h2>
    <div class="b_caption"><p>下一代前端工具链。</p></div>
  </li>
  <li class="b_pag"><a href="https://www.bing.com/search?q=test&first=11">下一页</a></li>
</ol>`;

const GOOGLE_HTML = `
<div id="search"><div id="rso">
  <div data-hveid="x1">
    <a href="https://vitest.dev/guide/"><h3>Vitest 上手指南</h3></a>
    <div><span>Vitest 是一个由 Vite 驱动的单元测试框架。</span></div>
  </div>
  <div data-hveid="x2">
    <a href="/url?q=https://cn.vitejs.dev/&sa=U&ved=abc"><h3>Vite 官方中文文档</h3></a>
    <div><span>下一代前端工具链。</span></div>
  </div>
</div></div>`;

const DDG_HTML = `
<div id="links">
  <article data-testid="result">
    <a data-testid="result-title-a" href="https://vitest.dev/guide/">Vitest 上手指南</a>
    <div data-result="snippet">Vitest 是一个由 Vite 驱动的单元测试框架。</div>
  </article>
  <article data-testid="result">
    <a data-testid="result-title-a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fcn.vitejs.dev%2F&rut=x">Vite 官方中文文档</a>
    <div data-result="snippet">下一代前端工具链。</div>
  </article>
</div>`;

describe('引擎表', () => {
  it('拼 URL 时关键词被转义，且不带条数参数', () => {
    const u = buildSearchUrl('bing', 'a b&c');
    expect(u).toBe('https://www.bing.com/search?q=a%20b%26c');
    expect(u).not.toContain('count=');
    expect(buildSearchUrl('google', 'x')).not.toContain('num=');
  });

  it('引擎名不认识或关键词为空返回 null', () => {
    expect(buildSearchUrl('yahoo', 'x')).toBeNull();
    expect(buildSearchUrl('bing', '   ')).toBeNull();
    expect(isSearchEngine('yahoo')).toBe(false);
    expect(SEARCH_ENGINE_IDS).toEqual(['bing', 'google', 'ddg']);
  });

  it('每个引擎都给得出用于权限检查的域名', () => {
    for (const e of SEARCH_ENGINE_IDS) expect(searchEngineHost(e)).toMatch(/\./);
    expect(searchEngineHost('yahoo')).toBe('');
  });
});

describe('选择器解析', () => {
  it('Bing：抓到标题/链接/摘要，翻页链接被滤掉', () => {
    const r = withDoc(BING_HTML, BING_URL, () => extractSearchResults('bing', 10));
    expect(r.status).toBe('ok');
    expect(r.results).toHaveLength(2);
    expect(r.results[0]).toMatchObject({
      rank: 1,
      title: 'Vitest 上手指南',
      url: 'https://vitest.dev/guide/',
      site: 'vitest.dev',
    });
    expect(r.results[0].snippet).toContain('Vite 驱动');
    expect(r.results.some((x) => x.url.includes('bing.com'))).toBe(false);
  });

  it('Google：h3 往上 closest(a) 能抓到，/url?q= 跳转被剥掉', () => {
    const r = withDoc(GOOGLE_HTML, GOOGLE_URL, () => extractSearchResults('google', 10));
    expect(r.status).toBe('ok');
    expect(r.results.map((x) => x.url)).toEqual(['https://vitest.dev/guide/', 'https://cn.vitejs.dev/']);
    expect(r.results[0].snippet).toContain('单元测试框架');
    // 摘要里不该把标题重复一遍
    expect(r.results[0].snippet).not.toContain('上手指南');
  });

  it('DuckDuckGo：uddg 包装链接被解开', () => {
    const r = withDoc(DDG_HTML, DDG_URL, () => extractSearchResults('ddg', 10));
    expect(r.status).toBe('ok');
    expect(r.results.map((x) => x.url)).toEqual(['https://vitest.dev/guide/', 'https://cn.vitejs.dev/']);
  });

  it('Bing 的 /ck/a?u=a1<base64> 包装链接被解开', () => {
    const real = 'https://example.com/a?b=1';
    const b64 = 'aHR0cHM6Ly9leGFtcGxlLmNvbS9hP2I9MQ'; // 上面这个 URL 的 base64url（写死避免依赖 node 类型）
    const html = `<ol id="b_results"><li class="b_algo">
      <h2><a href="https://www.bing.com/ck/a?!&&p=1&u=a1${b64}">被包装的结果标题</a></h2>
      <div class="b_caption"><p>摘要</p></div></li></ol>`;
    const r = withDoc(html, BING_URL, () => extractSearchResults('bing', 10));
    expect(r.results[0].url).toBe(real);
  });
});

describe('结构兜底（类名被改光也要能抓到）', () => {
  it('Bing 的 class 全删光，仍能靠结构抓到结果', () => {
    const stripped = BING_HTML.replace(/class="[^"]*"/g, '');
    const r = withDoc(stripped, BING_URL, () => extractSearchResults('bing', 10));
    expect(r.status).toBe('ok');
    expect(r.results.map((x) => x.url)).toEqual(['https://vitest.dev/guide/', 'https://cn.vitejs.dev/']);
  });

  it('Google 的 h3 结构没了也能靠链接文字兜底', () => {
    const html = `<div id="rso">
      <div><a href="https://vitest.dev/guide/">Vitest 上手指南</a><p>一个单元测试框架。</p></div>
    </div>`;
    const r = withDoc(html, GOOGLE_URL, () => extractSearchResults('google', 10));
    expect(r.status).toBe('ok');
    expect(r.results[0].url).toBe('https://vitest.dev/guide/');
  });

  it('兜底时滤掉站内导航、javascript: 和过短的功能链接', () => {
    const html = `<div id="rso">
      <a href="https://www.google.com/preferences">搜索设置与偏好选项</a>
      <a href="javascript:void(0)">切换到图片搜索模式</a>
      <a href="https://accounts.google.com/signin">登录你的 Google 帐号</a>
      <a href="https://vitest.dev/guide/">下一页</a>
      <a href="https://example.com/real">一条真正的搜索结果</a>
    </div>`;
    const r = withDoc(html, GOOGLE_URL, () => extractSearchResults('google', 10));
    expect(r.results.map((x) => x.url)).toEqual(['https://example.com/real']);
  });
});

describe('去重与条数', () => {
  it('同一个链接出现两次只保留一条', () => {
    const html = `<ol id="b_results">
      <li class="b_algo"><h2><a href="https://a.com/p">同一篇文章的标题</a></h2><div class="b_caption"><p>x</p></div></li>
      <li class="b_algo"><h2><a href="https://a.com/p">同一篇文章的标题（重复）</a></h2><div class="b_caption"><p>y</p></div></li>
    </ol>`;
    const r = withDoc(html, BING_URL, () => extractSearchResults('bing', 10));
    expect(r.results).toHaveLength(1);
  });

  it('limit 生效，rank 从 1 连续编号', () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      `<li class="b_algo"><h2><a href="https://a.com/${i}">结果标题 ${i}</a></h2><div class="b_caption"><p>摘要</p></div></li>`
    ).join('');
    const r = withDoc(`<ol id="b_results">${items}</ol>`, BING_URL, () =>
      extractSearchResults('bing', 2)
    );
    expect(r.results.map((x) => x.rank)).toEqual([1, 2]);
  });
});

describe('被拦 vs 真没搜到', () => {
  it('零结果 + 异常流量提示 → blocked（带原因）', () => {
    const html = `<div>Our systems have detected unusual traffic from your computer network.</div>`;
    const r = withDoc(html, GOOGLE_URL, () => extractSearchResults('google', 10));
    expect(r.status).toBe('blocked');
    expect(r.note).toContain('异常流量');
  });

  it('零结果 + 落在 /sorry 页 → blocked', () => {
    const r = withDoc('<div>需要验证</div>', 'https://www.google.com/sorry/index?continue=x', () =>
      extractSearchResults('google', 10)
    );
    expect(r.status).toBe('blocked');
    expect(r.note).toContain('/sorry');
  });

  it('页面正常但零结果 → empty，不是 blocked', () => {
    const r = withDoc('<ol id="b_results"></ol><p>找不到与此相关的结果</p>', BING_URL, () =>
      extractSearchResults('bing', 10)
    );
    expect(r.status).toBe('empty');
    expect(r.results).toHaveLength(0);
  });

  it('搜「captcha」这类词本身时不会被自己的特征串误伤', () => {
    const html = `<ol id="b_results">
      <li class="b_algo"><h2><a href="https://a.com/captcha">怎么绕过 captcha 人机验证</a></h2>
      <div class="b_caption"><p>verify you are human 的原理</p></div></li>
    </ol>`;
    const r = withDoc(html, BING_URL, () => extractSearchResults('bing', 10));
    expect(r.status).toBe('ok');
    expect(r.results).toHaveLength(1);
  });
});
