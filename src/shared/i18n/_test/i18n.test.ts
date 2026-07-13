import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetForTests,
  ensureI18n,
  getLanguage,
  onLanguageChanged,
  resolveLanguage,
  t,
} from '../index';
import { STORAGE_KEYS } from '../../constants';

// ==================== chrome stub ====================

type StorageListener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;

let storageListeners: StorageListener[] = [];
let storedConfig: Record<string, unknown> = {};

function stubChrome(uiLanguage = 'zh-CN'): void {
  storageListeners = [];
  (globalThis as Record<string, unknown>).chrome = {
    i18n: { getUILanguage: () => uiLanguage },
    storage: {
      local: {
        get: vi.fn(async () => ({ [STORAGE_KEYS.CONFIG]: storedConfig })),
        set: vi.fn(async () => {}),
      },
      onChanged: {
        addListener: (cb: StorageListener) => storageListeners.push(cb),
      },
    },
  };
}

/** 模拟设置页保存配置后 chrome.storage.onChanged 的广播 */
function fireConfigChanged(config: Record<string, unknown>): void {
  storageListeners.forEach((cb) =>
    cb({ [STORAGE_KEYS.CONFIG]: { newValue: config } }, 'local')
  );
}

beforeEach(() => {
  storedConfig = {};
  stubChrome();
  __resetForTests();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).chrome;
});

// ==================== resolveLanguage ====================

describe('resolveLanguage', () => {
  it('显式 zh / en 直接返回', () => {
    expect(resolveLanguage('zh', 'en-US')).toBe('zh');
    expect(resolveLanguage('en', 'zh-CN')).toBe('en');
  });

  it('auto：zh 系 UI 语言 → zh', () => {
    expect(resolveLanguage('auto', 'zh-CN')).toBe('zh');
    expect(resolveLanguage('auto', 'zh-TW')).toBe('zh');
    expect(resolveLanguage('auto', 'ZH')).toBe('zh');
  });

  it('auto：非 zh 系 UI 语言 → en', () => {
    expect(resolveLanguage('auto', 'en-US')).toBe('en');
    expect(resolveLanguage('auto', 'ja')).toBe('en');
    expect(resolveLanguage('auto', 'de-DE')).toBe('en');
  });

  it('设置缺失（存量配置）按 auto 处理', () => {
    expect(resolveLanguage(undefined, 'en-US')).toBe('en');
    expect(resolveLanguage(undefined, 'zh-CN')).toBe('zh');
  });

  it('未注入 uiLanguage 时读 chrome.i18n.getUILanguage', () => {
    stubChrome('en-GB');
    expect(resolveLanguage('auto')).toBe('en');
  });
});

// ==================== t() ====================

describe('t', () => {
  it('默认中文查找', () => {
    expect(t('common.save')).toBe('保存设置');
  });

  it('切到英文后取英文文案', async () => {
    storedConfig = { language: 'en' };
    await ensureI18n();
    expect(t('common.save')).toBe('Save Settings');
  });

  it('缺失 key 原样返回（不崩）', () => {
    // 故意绕过类型检查模拟运行期坏 key
    expect(t('no.such.key' as never)).toBe('no.such.key');
  });

  it('占位符替换，同名可出现多次', () => {
    // 缺失 key 会原样返回并继续走占位符替换，借此直接测 format 逻辑
    expect(t('{n} of {n} done' as never, { n: 3 })).toBe('3 of 3 done');
  });

  it('占位符参数缺失时保留原样', () => {
    expect(t('miss.{a}.{b}' as never, { a: 'A' })).toBe('miss.A.{b}');
  });
});

// ==================== ensureI18n 单例语义 ====================

describe('ensureI18n', () => {
  it('并发调用只初始化一次', async () => {
    storedConfig = { language: 'en' };
    await Promise.all([ensureI18n(), ensureI18n(), ensureI18n()]);
    const getMock = (chrome.storage.local.get as ReturnType<typeof vi.fn>);
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getLanguage()).toBe('en');
  });

  it('storage 变更触发语言切换与订阅回调', async () => {
    storedConfig = { language: 'zh' };
    await ensureI18n();
    const seen: string[] = [];
    onLanguageChanged((lang) => seen.push(lang));

    fireConfigChanged({ language: 'en' });
    expect(getLanguage()).toBe('en');
    expect(t('common.save')).toBe('Save Settings');
    expect(seen).toEqual(['en']);

    // 语言未变时不重复触发
    fireConfigChanged({ language: 'en' });
    expect(seen).toEqual(['en']);
  });

  it('非 local 区域、无关 key 的变更被忽略', async () => {
    storedConfig = { language: 'zh' };
    await ensureI18n();
    storageListeners.forEach((cb) =>
      cb({ [STORAGE_KEYS.CONFIG]: { newValue: { language: 'en' } } }, 'sync')
    );
    storageListeners.forEach((cb) => cb({ 'other:key': { newValue: 1 } }, 'local'));
    expect(getLanguage()).toBe('zh');
  });

  it('取消订阅后不再收到回调', async () => {
    await ensureI18n();
    const seen: string[] = [];
    const off = onLanguageChanged((lang) => seen.push(lang));
    off();
    fireConfigChanged({ language: 'en' });
    expect(seen).toEqual([]);
  });
});
