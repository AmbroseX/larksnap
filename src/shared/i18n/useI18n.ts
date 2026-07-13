import { useEffect, useState } from 'react';
import type { Language } from '../types';
import { ensureI18n, getLanguage, onLanguageChanged, t } from './index';

/**
 * React 页面接入 i18n：挂载时初始化语言，之后跟随设置页切换即时重渲染。
 * t 本身是稳定引用，重渲染由 lang state 变化驱动。
 */
export function useI18n(): { t: typeof t; lang: Language } {
  const [lang, setLang] = useState<Language>(getLanguage());

  useEffect(() => {
    let mounted = true;
    ensureI18n().then(() => {
      if (mounted) setLang(getLanguage());
    });
    const off = onLanguageChanged((next) => {
      if (mounted) setLang(next);
    });
    return () => {
      mounted = false;
      off();
    };
  }, []);

  return { t, lang };
}
