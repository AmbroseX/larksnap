import { describe, expect, it, vi } from 'vitest';
import type { TranslationKey } from '../shared/i18n';

// 只测纯函数 buildMenuSpecs/feishuMenusVisible/MENU_ACTION：注册与分发属 Chrome 真实行为，真机手测
vi.mock('../shared/i18n', () => ({
  ensureI18n: vi.fn(async () => {}),
  onLanguageChanged: vi.fn(),
  t: (k: string) => k,
}));
vi.mock('./actions-dispatch', () => ({ dispatchAction: vi.fn() }));

import {
  FEISHU_MENU_IDS,
  MENU_ACTION,
  MENU_PAYLOAD,
  MENU_ROOT_ID,
  buildMenuSpecs,
  feishuMenusVisible,
} from './context-menus';

const tf = (key: TranslationKey) => `[${key}]`;

describe('feishuMenusVisible 按页识别（取代按域名列表显隐）', () => {
  it('官方域文档页可见', () => {
    expect(feishuMenusVisible('https://xxx.feishu.cn/docx/AbCdEfGhIjKlMnOpQrStUv12')).toBe(true);
    expect(feishuMenusVisible('https://a.larksuite.com/wiki/AbCdEfGhIjKlMnOpQrStUv12')).toBe(true);
  });

  it('私有化域靠「路径 + token 形态」识别，无需出现在任何授权列表里', () => {
    expect(
      feishuMenusVisible('https://tenant.corp.example.com/docx/AbCdEfGhIjKlMnOpQrStUv12')
    ).toBe(true);
  });

  it('普通网页一律不可见——即使其域名曾被误记进「已信任域名」', () => {
    expect(feishuMenusVisible('https://mp.weixin.qq.com/s/abc')).toBe(false);
    expect(feishuMenusVisible('https://www.zhihu.com/question/1')).toBe(false);
    expect(feishuMenusVisible('')).toBe(false);
  });
});

describe('buildMenuSpecs 菜单集合', () => {
  const specs = buildMenuSpecs(tf);
  const byId = new Map(specs.map((s) => [s.id, s]));

  it('唯一父菜单，其余全部挂在它下面', () => {
    const root = byId.get(MENU_ROOT_ID);
    expect(root).toBeTruthy();
    expect(root!.parentId).toBeUndefined();
    for (const s of specs) {
      if (s.id !== MENU_ROOT_ID) expect(s.parentId).toBe(MENU_ROOT_ID);
    }
  });

  it('通用组：任何页面可见（不设 visible），FR-004 六项 + md 下载/PDF + 问 AI 两项', () => {
    const generic = specs.filter((s) => s.id !== MENU_ROOT_ID && s.visible === undefined);
    expect(generic.map((s) => s.id)).toEqual([
      'menu-page-md',
      'menu-page-md-dl',
      'menu-selection-md',
      'menu-ask-ai-sum',
      'menu-ask-ai-translate',
      'menu-screenshot',
      'menu-screenshot-pdf',
      'menu-summarize',
      'menu-unlock',
      'menu-open-panel',
    ]);
  });

  it('飞书组：MD/PDF/HTML/更多导出方式，创建时默认隐藏，等页面识别后再亮（FR-005）', () => {
    const feishu = specs.filter((s) => s.visible === false);
    expect(feishu.map((s) => s.id)).toEqual([...FEISHU_MENU_IDS]);
  });

  it('选区项只在 selection context 出现，整页项只在 page context 出现', () => {
    expect(byId.get('menu-selection-md')!.contexts).toEqual(['selection']);
    expect(byId.get('menu-ask-ai-sum')!.contexts).toEqual(['selection']);
    expect(byId.get('menu-ask-ai-translate')!.contexts).toEqual(['selection']);
    expect(byId.get('menu-page-md')!.contexts).toEqual(['page']);
    expect(byId.get('menu-unlock')!.contexts).toEqual(['page', 'selection']);
  });

  it('问 AI 两项共用 ask-ai-selection 动作，指令由 payload 区分（008）', () => {
    expect(MENU_ACTION['menu-ask-ai-sum']).toBe('ask-ai-selection');
    expect(MENU_ACTION['menu-ask-ai-translate']).toBe('ask-ai-selection');
    expect(MENU_PAYLOAD['menu-ask-ai-sum']).toEqual({ selPrompt: 'summarize' });
    expect(MENU_PAYLOAD['menu-ask-ai-translate']).toEqual({ selPrompt: 'translate' });
  });

  it('标题跟随翻译函数（语言切换重建即换语言，spec FR-007）', () => {
    const zh = buildMenuSpecs((k) => `zh:${k}`);
    const en = buildMenuSpecs((k) => `en:${k}`);
    expect(zh.find((s) => s.id === 'menu-screenshot')!.title).toBe('zh:menu.screenshot');
    expect(en.find((s) => s.id === 'menu-screenshot')!.title).toBe('en:menu.screenshot');
  });

  it('每个子菜单项都能映射到动作（MENU_ACTION 全覆盖）', () => {
    for (const s of specs) {
      if (s.id === MENU_ROOT_ID) continue;
      expect(MENU_ACTION[s.id], `菜单 ${s.id} 缺少动作映射`).toBeTruthy();
    }
  });

  it('整页导出 PDF 项复用 screenshot 动作并携带 pdf 格式参数', () => {
    expect(MENU_ACTION['menu-screenshot-pdf']).toBe('screenshot');
    expect(MENU_PAYLOAD['menu-screenshot-pdf']).toEqual({ format: 'pdf' });
    expect(MENU_PAYLOAD['menu-screenshot']).toBeUndefined();
  });
});
