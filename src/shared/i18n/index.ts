import type { ExtensionConfig, Language, LanguageSetting } from '../types';
import { STORAGE_KEYS } from '../constants';
import { getConfig } from '../storage';
import { zh } from './zh';
import { en } from './en';

// ==================== 类型推导 ====================

/** 把 zh 字典的字面量类型放宽成 string，作为其他语言字典的结构约束 */
type DeepStringify<T> = {
  [K in keyof T]: T[K] extends string ? string : DeepStringify<T[K]>;
};
export type Dict = DeepStringify<typeof zh>;

/** 递归推导点分路径联合类型：'common.save' | 'options.title' | ... */
type DotPath<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : DotPath<T[K], `${P}${K}.`>;
}[keyof T & string];
export type TranslationKey = DotPath<typeof zh>;

// ==================== 语言解析 ====================

/**
 * 把设置项解析成实际字典语言。
 * uiLanguage 参数供单测注入；运行时缺省取浏览器 UI 语言。
 */
export function resolveLanguage(setting: LanguageSetting | undefined, uiLanguage?: string): Language {
  if (setting === 'zh' || setting === 'en') return setting;
  const ui =
    uiLanguage ??
    (typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage
      ? chrome.i18n.getUILanguage()
      : 'zh');
  return ui.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

// ==================== 运行时状态（模块级单例） ====================

const DICTS: Record<Language, Dict> = { zh, en };

let currentLang: Language = 'zh';
let initPromise: Promise<void> | null = null;
const listeners = new Set<(lang: Language) => void>();

function applyLanguage(lang: Language): void {
  if (lang === currentLang) return;
  currentLang = lang;
  listeners.forEach((cb) => cb(lang));
}

/**
 * 幂等初始化：首次调用读配置并注册 storage 监听，之后复用同一个 Promise。
 * 所有会产生用户文案的 async 入口（消息路由、右键菜单回调、桥接任务等）
 * 必须先 await 它，保证同步 t() 拿到的语言已就绪。
 */
export function ensureI18n(): Promise<void> {
  initPromise ??= (async () => {
    const config = await getConfig();
    currentLang = resolveLanguage(config.language);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const next = changes[STORAGE_KEYS.CONFIG]?.newValue as
        | Partial<ExtensionConfig>
        | undefined;
      if (!next) return;
      applyLanguage(resolveLanguage(next.language));
    });
  })();
  return initPromise;
}

/** 当前生效语言（须在 ensureI18n 完成后才可靠） */
export function getLanguage(): Language {
  return currentLang;
}

/** 订阅语言变更（设置页切换后触发），返回取消订阅函数 */
export function onLanguageChanged(cb: (lang: Language) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// ==================== t() ====================

function lookup(dict: object, key: string): string | undefined {
  let node: unknown = dict;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

function format(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (raw, name: string) =>
    params[name] !== undefined ? String(params[name]) : raw
  );
}

/**
 * 取当前语言文案。查不到回退中文，再查不到原样返回 key（不崩）。
 * 占位符：字典里写 {name}，params 传 { name: 值 }，同名可出现多次。
 */
export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  const raw = lookup(DICTS[currentLang], key) ?? lookup(zh, key) ?? key;
  return params ? format(raw, params) : raw;
}

// ==================== 仅供单测 ====================

/** 重置模块级状态（单测隔离用，业务代码禁止调用） */
export function __resetForTests(): void {
  currentLang = 'zh';
  initPromise = null;
  listeners.clear();
}
