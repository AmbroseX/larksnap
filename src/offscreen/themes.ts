/**
 * 卡片主题（§七）：一套主题就是一组颜色/字体变量，渲染时套在卡片根节点上。
 * 第一版内置两套，默认「简约白」；以后加主题只需在这里加对象。
 */

export interface XhsTheme {
  id: string;
  name: string;
  /** 卡片背景色 */
  bg: string;
  /** 正文颜色 */
  text: string;
  /** 标题颜色 */
  heading: string;
  /** 次要文字（页码/占位/引用） */
  muted: string;
  /** 点缀色（引用竖线/列表圆点） */
  accent: string;
  /** 代码块背景 */
  codeBg: string;
  /** 表格边框/分割线 */
  border: string;
}

export const THEMES: Record<string, XhsTheme> = {
  white: {
    id: 'white',
    name: '简约白',
    bg: '#ffffff',
    text: '#1f2329',
    heading: '#111418',
    muted: '#8a919f',
    accent: '#3370ff',
    codeBg: '#f5f6f7',
    border: '#e5e7eb',
  },
  warm: {
    id: 'warm',
    name: '暖米黄',
    bg: '#faf5e9',
    text: '#3d3229',
    heading: '#2b2118',
    muted: '#a1957f',
    accent: '#c2703d',
    codeBg: '#f2ead8',
    border: '#e6dcc3',
  },
  dark: {
    id: 'dark',
    name: '夜间黑',
    bg: '#191b1f',
    text: '#e8eaed',
    heading: '#ffffff',
    muted: '#9aa0a6',
    accent: '#7aa2ff',
    codeBg: '#26292e',
    border: '#3a3f45',
  },
};

export const DEFAULT_THEME_ID = 'white';

export function getTheme(id?: string): XhsTheme {
  return THEMES[id ?? ''] ?? THEMES[DEFAULT_THEME_ID];
}
