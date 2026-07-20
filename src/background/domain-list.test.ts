import { describe, expect, it } from 'vitest';
import { baseFromPattern } from '../shared/feishu-host';
import { composeDomainList } from './domain-list';

// 只测纯逻辑：pattern 解析与清单合成优先级。chrome.tabs / storage 的采集
// 属真实浏览器行为，真机手测（quickstart 手测清单）。

describe('baseFromPattern 授权 pattern 剥基础域', () => {
  it('飞书授权的基础域通配形状 → 基础域', () => {
    expect(baseFromPattern('*://*.a.example.com/*')).toBe('a.example.com');
    expect(baseFromPattern('*://*.feishu.cn/*')).toBe('feishu.cn');
  });

  it('AI 端点形状（Options 页存的 origin 全等 pattern）→ null，不混入清单', () => {
    expect(baseFromPattern('https://api.openai.example/*')).toBeNull();
    expect(baseFromPattern('http://10.0.0.8:8000/*')).toBeNull();
  });

  it('边界形状 → null：全通配 / 带路径 / 空串', () => {
    expect(baseFromPattern('*://*/*')).toBeNull();
    expect(baseFromPattern('*://*.a.com/docs/*')).toBeNull();
    expect(baseFromPattern('')).toBeNull();
  });
});

describe('composeDomainList 清单合成与 sampleUrl 优先级', () => {
  const builtin = ['feishu.cn', 'feishu.net', 'larksuite.com'];

  it('A 优先：授权时记的 origin 命中时不看已打开标签', () => {
    const list = composeDomainList({
      builtin,
      trustedPatterns: ['*://*.corp.example.com/*'],
      origins: { 'corp.example.com': 'https://tenant.corp.example.com' },
      openTabUrls: ['https://other.corp.example.com/drive/me/'],
    });
    const entry = list.find((d) => d.host === 'corp.example.com');
    expect(entry).toEqual({
      host: 'corp.example.com',
      kind: 'trusted',
      sampleUrl: 'https://tenant.corp.example.com',
    });
  });

  it('B 兜底：无记录时取已打开标签的 origin（含基础域本身与子域命中）', () => {
    const list = composeDomainList({
      builtin,
      trustedPatterns: ['*://*.corp.example.com/*'],
      origins: {},
      openTabUrls: [
        'https://unrelated.site/',
        'https://sub.tenant.corp.example.com/wiki/x',
      ],
    });
    expect(list.find((d) => d.host === 'corp.example.com')?.sampleUrl).toBe(
      'https://sub.tenant.corp.example.com'
    );
  });

  it('都没有 → sampleUrl null；builtin 无标签时同样为 null', () => {
    const list = composeDomainList({
      builtin,
      trustedPatterns: ['*://*.corp.example.com/*'],
      origins: {},
      openTabUrls: [],
    });
    expect(list.find((d) => d.host === 'corp.example.com')?.sampleUrl).toBeNull();
    expect(list.find((d) => d.host === 'feishu.cn')?.sampleUrl).toBeNull();
  });

  it('builtin 靠已打开的公有云标签补上 sampleUrl', () => {
    const list = composeDomainList({
      builtin,
      trustedPatterns: [],
      origins: {},
      openTabUrls: ['https://xyz123.feishu.cn/docx/abc'],
    });
    expect(list.find((d) => d.host === 'feishu.cn')?.sampleUrl).toBe('https://xyz123.feishu.cn');
  });

  it('AI 端点 pattern 被过滤，不出现在清单里；trusted pattern 去重', () => {
    const list = composeDomainList({
      builtin,
      trustedPatterns: [
        'https://api.openai.example/*',
        '*://*.corp.example.com/*',
        '*://*.corp.example.com/*',
      ],
      origins: {},
      openTabUrls: [],
    });
    expect(list.filter((d) => d.kind === 'trusted')).toHaveLength(1);
    expect(list.some((d) => d.host.includes('openai'))).toBe(false);
  });

  it('坏 URL 与非 http(s) 标签忽略，不影响其余解析', () => {
    const list = composeDomainList({
      builtin,
      trustedPatterns: [],
      origins: {},
      openTabUrls: ['chrome://extensions', 'not a url', 'https://t.feishu.cn/'],
    });
    expect(list.find((d) => d.host === 'feishu.cn')?.sampleUrl).toBe('https://t.feishu.cn');
  });

  it('子域后缀匹配不误伤形近域名（evilfeishu.cn 不算 feishu.cn 的标签）', () => {
    const list = composeDomainList({
      builtin,
      trustedPatterns: [],
      origins: {},
      openTabUrls: ['https://evilfeishu.cn/'],
    });
    expect(list.find((d) => d.host === 'feishu.cn')?.sampleUrl).toBeNull();
  });
});
