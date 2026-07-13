import { describe, expect, it, vi } from 'vitest';
import type { TranslationKey } from '../shared/i18n';

// 只测纯函数 buildMenuSpecs/feishuUrlPatterns/MENU_ACTION：注册与分发属 Chrome 真实行为，真机手测
vi.mock('../shared/i18n', () => ({
  ensureI18n: vi.fn(async () => {}),
  onLanguageChanged: vi.fn(),
  t: (k: string) => k,
}));
vi.mock('../shared/storage', () => ({ getConfig: vi.fn(async () => ({})) }));
vi.mock('./actions-dispatch', () => ({ dispatchAction: vi.fn() }));

import { MENU_ACTION, MENU_ROOT_ID, buildMenuSpecs, feishuUrlPatterns } from './context-menus';

const tf = (key: TranslationKey) => `[${key}]`;

describe('feishuUrlPatterns', () => {
  it('官方三域 + 授权私有化域 pattern 原样并入', () => {
    const patterns = feishuUrlPatterns(['*://*.mycorp.com/*']);
    expect(patterns).toEqual([
      '*://*.feishu.cn/*',
      '*://*.feishu.net/*',
      '*://*.larksuite.com/*',
      '*://*.mycorp.com/*',
    ]);
  });
});

describe('buildMenuSpecs 菜单集合', () => {
  const specs = buildMenuSpecs(tf, []);
  const byId = new Map(specs.map((s) => [s.id, s]));

  it('唯一父菜单，其余全部挂在它下面', () => {
    const root = byId.get(MENU_ROOT_ID);
    expect(root).toBeTruthy();
    expect(root!.parentId).toBeUndefined();
    for (const s of specs) {
      if (s.id !== MENU_ROOT_ID) expect(s.parentId).toBe(MENU_ROOT_ID);
    }
  });

  it('通用组：任何页面可见（无 documentUrlPatterns），覆盖 spec FR-004 全部六项', () => {
    const generic = specs.filter((s) => s.id !== MENU_ROOT_ID && !s.documentUrlPatterns);
    expect(generic.map((s) => s.id)).toEqual([
      'menu-page-md',
      'menu-selection-md',
      'menu-screenshot',
      'menu-summarize',
      'menu-unlock',
      'menu-open-panel',
    ]);
  });

  it('飞书组：MD/PDF/HTML/更多导出方式，全部带域名匹配（spec FR-005）', () => {
    const feishu = specs.filter((s) => s.documentUrlPatterns);
    expect(feishu.map((s) => s.id)).toEqual([
      'menu-feishu-md',
      'menu-feishu-pdf',
      'menu-feishu-html',
      'menu-feishu-more',
    ]);
    for (const s of feishu) {
      expect(s.documentUrlPatterns).toContain('*://*.feishu.cn/*');
    }
  });

  it('私有化域授权后注入飞书组匹配（授权变更重建即生效，spec FR-006）', () => {
    const withTrusted = buildMenuSpecs(tf, ['*://*.mycorp.com/*']);
    const md = withTrusted.find((s) => s.id === 'menu-feishu-md');
    expect(md!.documentUrlPatterns).toContain('*://*.mycorp.com/*');
  });

  it('选区项只在 selection context 出现，整页项只在 page context 出现', () => {
    expect(byId.get('menu-selection-md')!.contexts).toEqual(['selection']);
    expect(byId.get('menu-page-md')!.contexts).toEqual(['page']);
    expect(byId.get('menu-unlock')!.contexts).toEqual(['page', 'selection']);
  });

  it('标题跟随翻译函数（语言切换重建即换语言，spec FR-007）', () => {
    const zh = buildMenuSpecs((k) => `zh:${k}`, []);
    const en = buildMenuSpecs((k) => `en:${k}`, []);
    expect(zh.find((s) => s.id === 'menu-screenshot')!.title).toBe('zh:menu.screenshot');
    expect(en.find((s) => s.id === 'menu-screenshot')!.title).toBe('en:menu.screenshot');
  });

  it('每个子菜单项都能映射到动作（MENU_ACTION 全覆盖）', () => {
    for (const s of specs) {
      if (s.id === MENU_ROOT_ID) continue;
      expect(MENU_ACTION[s.id], `菜单 ${s.id} 缺少动作映射`).toBeTruthy();
    }
  });
});
