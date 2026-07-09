/**
 * 导出样式的 UI 元数据（侧边栏选择器用）。
 * 只有 id/名字/色块，完整样式定义在各渲染器侧
 * （小红书：src/offscreen/themes.ts；公众号：src/background/convert/wechat-html.ts），
 * 两边靠 id 对上，避免侧边栏包进渲染器代码。
 */

export interface ThemeOption {
  id: string;
  name: string;
  /** 选择器里的色块颜色 */
  swatch: string;
}

/** 小红书卡片主题 */
export const XHS_THEME_OPTIONS: ThemeOption[] = [
  { id: 'white', name: '简约白', swatch: '#ffffff' },
  { id: 'warm', name: '暖米黄', swatch: '#faf5e9' },
  { id: 'dark', name: '夜间黑', swatch: '#191b1f' },
];

/** 公众号排版主题 */
export const WECHAT_THEME_OPTIONS: ThemeOption[] = [
  { id: 'classic', name: '经典黑', swatch: '#1f2329' },
  { id: 'blue', name: '商务蓝', swatch: '#3370ff' },
  { id: 'green', name: '微信绿', swatch: '#07c160' },
];

/**
 * 公众号排版主题的完整定义：只动"点缀"（标题色/标题色条/引用边条），正文规则不变。
 * 放在 shared 是因为渲染器（SW）和侧边栏的悬浮预览都要用，保持单一来源。
 */
export interface WechatTheme {
  id: string;
  /** 标题文字色 */
  headingColor: string;
  /** h1/h2 左侧色条（经典主题不带） */
  accentBar?: string;
  /** 引用块左边条颜色 */
  quoteBorder: string;
}

export const WECHAT_THEMES: Record<string, WechatTheme> = {
  classic: { id: 'classic', headingColor: 'rgba(0,0,0,0.9)', quoteBorder: '#e0e0e0' },
  blue: { id: 'blue', headingColor: '#2b58d9', accentBar: '#3370ff', quoteBorder: '#3370ff' },
  green: { id: 'green', headingColor: '#08915c', accentBar: '#07c160', quoteBorder: '#07c160' },
};

export function getWechatTheme(id?: string): WechatTheme {
  return WECHAT_THEMES[id ?? ''] ?? WECHAT_THEMES.classic;
}
