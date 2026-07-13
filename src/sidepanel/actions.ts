import { MSG } from '../shared/constants';
import type { TranslationKey } from '../shared/i18n';
import {
  XHS_THEME_OPTIONS,
  WECHAT_THEME_OPTIONS,
  type ThemeOption,
} from '../shared/themes';

/** 侧边栏飞书动作的配置（006：按组布局——export 主按钮网格 / publish 样式直选行 / misc 单行） */
export interface ActionItem {
  /** 唯一 key */
  key: string;
  /** 标题（i18n 字典 key，渲染时经 t() 取文案） */
  title: TranslationKey;
  /** 副标题（i18n 字典 key） */
  subtitle: TranslationKey;
  /** 点击发送给背景的消息类型 */
  msg?: string;
  /** 渲染分组 */
  group: 'export' | 'publish' | 'misc';
  /** 有样式可选的导出：下拉直选，点样式即执行（publish 组） */
  themes?: ThemeOption[];
}

/**
 * 飞书上下文区动作清单（4 主按钮 + 转发布 + 缓存）。
 * word 占位卡已删除（等功能真做了再加回）；「查看缓存」并入 header 缓存库图标；
 * 「诊断」「反馈」移页脚小字链接（见 Footer.tsx）。
 */
export const ACTIONS: ActionItem[] = [
  {
    key: 'markdown',
    title: 'actions.markdown.title',
    subtitle: 'actions.markdown.subtitle',
    msg: MSG.EXPORT_MARKDOWN,
    group: 'export',
  },
  {
    key: 'pdf',
    title: 'actions.pdf.title',
    subtitle: 'actions.pdf.subtitle',
    msg: MSG.EXPORT_PDF,
    group: 'export',
  },
  {
    key: 'html',
    title: 'actions.html.title',
    subtitle: 'actions.html.subtitle',
    msg: MSG.EXPORT_HTML,
    group: 'export',
  },
  {
    key: 'attachments',
    title: 'actions.attachments.title',
    subtitle: 'actions.attachments.subtitle',
    msg: MSG.EXPORT_ATTACHMENTS,
    group: 'export',
  },
  {
    key: 'xhs',
    title: 'actions.xhs.title',
    subtitle: 'actions.xhs.subtitle',
    msg: MSG.EXPORT_XHS,
    themes: XHS_THEME_OPTIONS,
    group: 'publish',
  },
  {
    key: 'wechat',
    title: 'actions.wechat.title',
    subtitle: 'actions.wechat.subtitle',
    msg: MSG.EXPORT_WECHAT,
    themes: WECHAT_THEME_OPTIONS,
    group: 'publish',
  },
  {
    key: 'cache',
    title: 'actions.cache.title',
    subtitle: 'actions.cache.subtitle',
    msg: MSG.CACHE_DOC,
    group: 'misc',
  },
];
