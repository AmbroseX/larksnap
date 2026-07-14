import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from './sanitize';

/**
 * sanitize 依赖真实 DOM（DOMParser 的实体解码/结构归一是防绕过的关键，不能用假实现）。
 * jsdom 是可选 devDependency：装了就注入 DOM 全局跑完整载荷集，没装整组 skip。
 * 启用：npm i -D jsdom
 */
let hasDom = typeof DOMParser !== 'undefined';
if (!hasDom) {
  try {
    // @ts-ignore -- jsdom 为可选 devDependency，未安装时没有类型声明（装没装都不能报错）
    const { JSDOM } = await import('jsdom');
    const g = globalThis as Record<string, unknown>;
    const win = new JSDOM('').window;
    g.DOMParser = win.DOMParser;
    g.Node = win.Node;
    hasDom = true;
  } catch {
    // jsdom 未安装：跳过本测试集
  }
}

describe.skipIf(!hasDom)('sanitizeHtml 恶意载荷测试集', () => {
  it('script/style/iframe 连同子树整体丢弃', () => {
    expect(sanitizeHtml('<p>a</p><script>alert(1)</script>')).toBe('<p>a</p>');
    expect(sanitizeHtml('<style>*{display:none}</style><p>b</p>')).toBe('<p>b</p>');
    expect(sanitizeHtml('<iframe src="https://x.com"></iframe>')).toBe('');
  });

  it('on* 事件属性剥除（不在任何白名单里）', () => {
    const out = sanitizeHtml('<p onclick="alert(1)" onmouseover="x()">hi</p>');
    expect(out).toBe('<p>hi</p>');
  });

  it('javascript: 链接及大小写/空白/实体变体全部拒收', () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).not.toContain('href');
    expect(sanitizeHtml('<a href="JaVaScRiPt:alert(1)">x</a>')).not.toContain('href');
    // 制表符/换行混入协议名
    expect(sanitizeHtml('<a href="java\tscript:alert(1)">x</a>')).not.toContain('href');
    // 实体编码的冒号：DOMParser 解码后仍是 javascript:，URL 协议校验拒收
    expect(sanitizeHtml('<a href="javascript&colon;alert(1)">x</a>')).not.toContain('href');
    expect(sanitizeHtml('<a href="&#106;avascript:alert(1)">x</a>')).not.toContain('href');
  });

  it('data:/vbscript:/blob: 协议拒收，http/https/锚点放行', () => {
    expect(sanitizeHtml('<a href="data:text/html,<script>x</script>">x</a>')).not.toContain(
      'href'
    );
    expect(sanitizeHtml('<a href="vbscript:x">x</a>')).not.toContain('href');
    const ok = sanitizeHtml('<a href="https://example.com/a?b=1">x</a>');
    expect(ok).toContain('href="https://example.com/a?b=1"');
    expect(ok).toContain('target="_blank"');
    expect(ok).toContain('rel="noopener noreferrer"');
    expect(sanitizeHtml('<a href="#sec">x</a>')).toContain('href');
  });

  it('svg onload / math 向量整体丢弃', () => {
    expect(sanitizeHtml('<svg onload="alert(1)"><circle/></svg><p>k</p>')).toBe('<p>k</p>');
    expect(
      sanitizeHtml('<math><mtext><script>alert(1)</script></mtext></math>')
    ).toBe('');
  });

  it('img 不渲染：有 alt 降级为文本，无 alt 直接删（onerror 无处附着）', () => {
    expect(sanitizeHtml('<img src="https://t.example/p.png" alt="示意图">')).toBe('[示意图]');
    expect(sanitizeHtml('<img src="x" onerror="alert(1)">')).toBe('');
  });

  it('form/input/button 丢弃，嵌套载荷不漏出', () => {
    expect(sanitizeHtml('<form action="https://x.com"><input value="a"><p>内</p></form>')).toBe(
      ''
    );
  });

  it('注释节点删除', () => {
    expect(sanitizeHtml('<p>a<!-- <script>x</script> -->b</p>')).toBe('<p>ab</p>');
  });

  it('code 只保留 language-* class，其余属性剥掉', () => {
    const out = sanitizeHtml(
      '<pre><code class="language-ts" data-x="1" style="color:red">const a=1</code></pre>'
    );
    expect(out).toContain('class="language-ts"');
    expect(out).not.toContain('data-x');
    expect(out).not.toContain('style');
    expect(sanitizeHtml('<code class="evil">x</code>')).toBe('<code>x</code>');
  });

  it('正常 Markdown 产物结构完整保留（标题/列表/表格/引用）', () => {
    const html =
      '<h2>标题</h2><ul><li>一</li></ul><blockquote><p>引</p></blockquote>' +
      '<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>';
    expect(sanitizeHtml(html)).toBe(html);
  });

  it('残缺/畸形标签不抛错', () => {
    expect(() => sanitizeHtml('<p><b>未闭合 <table><tr><td>x')).not.toThrow();
    expect(() => sanitizeHtml('<<>>&&"\'')).not.toThrow();
  });
});
