import { describe, expect, it } from 'vitest';
import { classifyPage, isRestrictedUrl, isYoutubeWatchUrl, matchVideoSite } from './page-kind';

// 纯函数测试：不需要 chrome stub（page-kind 约定不出现 chrome API）

const FEISHU_TOKEN = 'AbCdEfGhIjKlMnOpQrStUv12';

describe('isRestrictedUrl', () => {
  it('非 http(s) 协议一律受限', () => {
    expect(isRestrictedUrl('chrome://extensions')).toBe(true);
    expect(isRestrictedUrl('about:blank')).toBe(true);
    expect(isRestrictedUrl('chrome-extension://abc/sidepanel.html')).toBe(true);
  });

  it('扩展商店页受限', () => {
    expect(isRestrictedUrl('https://chromewebstore.google.com/detail/xxx')).toBe(true);
    expect(isRestrictedUrl('https://chrome.google.com/webstore/detail/xxx')).toBe(true);
  });

  it('普通 http(s) 页不受限', () => {
    expect(isRestrictedUrl('https://example.com/a')).toBe(false);
    expect(isRestrictedUrl('http://example.com')).toBe(false);
  });
});

describe('matchVideoSite', () => {
  it('命中站点表（含子域）', () => {
    expect(matchVideoSite('https://www.bilibili.com/video/BV1xx411c7mD')).toBe('bilibili');
    expect(matchVideoSite('https://b23.tv/abc')).toBe('bilibili');
    expect(matchVideoSite('https://www.youtube.com/watch?v=abc')).toBe('youtube');
    expect(matchVideoSite('https://www.douyin.com/video/123')).toBe('douyin');
  });

  it('未命中与坏 URL 返回 null', () => {
    expect(matchVideoSite('https://example.com')).toBeNull();
    expect(matchVideoSite('not-a-url')).toBeNull();
  });
});

describe('isYoutubeWatchUrl', () => {
  it('仅 /watch 且带 v 参数才算观看页', () => {
    expect(isYoutubeWatchUrl('https://www.youtube.com/watch?v=abc123')).toBe(true);
    expect(isYoutubeWatchUrl('https://www.youtube.com/')).toBe(false);
    expect(isYoutubeWatchUrl('https://www.youtube.com/watch')).toBe(false);
    expect(isYoutubeWatchUrl('https://youtu.be/abc123')).toBe(false);
  });
});

describe('classifyPage 五分类（判定顺序互斥完备）', () => {
  it('空 / 受限 URL → restricted', () => {
    expect(classifyPage(undefined).kind).toBe('restricted');
    expect(classifyPage('').kind).toBe('restricted');
    expect(classifyPage('chrome://extensions').kind).toBe('restricted');
    expect(classifyPage('https://chromewebstore.google.com/detail/x').kind).toBe('restricted');
  });

  it('公有云飞书文档 → feishu', () => {
    const info = classifyPage(`https://xxx.feishu.cn/docx/${FEISHU_TOKEN}`, '产品方案');
    expect(info.kind).toBe('feishu');
    expect(info.title).toBe('产品方案');
  });

  it('私有化域名双信号（路径 + token 正则）→ feishu，不依赖域名白名单', () => {
    const info = classifyPage(`https://docs.mycorp.com/docx/${FEISHU_TOKEN}`);
    expect(info.kind).toBe('feishu');
  });

  it('YouTube 观看页 → youtube（优先于 video），并带 videoSite', () => {
    const info = classifyPage('https://www.youtube.com/watch?v=abc123', '某视频');
    expect(info.kind).toBe('youtube');
    expect(info.videoSite).toBe('youtube');
  });

  it('YouTube 非观看页命中站点表 → video（如首页/频道页）', () => {
    expect(classifyPage('https://www.youtube.com/').kind).toBe('video');
  });

  it('其余视频站点 → video，并带站点枚举名', () => {
    const info = classifyPage('https://www.bilibili.com/video/BV1xx411c7mD');
    expect(info.kind).toBe('video');
    expect(info.videoSite).toBe('bilibili');
  });

  it('普通网页 → generic，透传 url 与 title', () => {
    const info = classifyPage('https://example.com/post/1', '一篇文章');
    expect(info.kind).toBe('generic');
    expect(info.url).toBe('https://example.com/post/1');
    expect(info.title).toBe('一篇文章');
  });
});
