import { MSG } from '../shared/constants';
import type { TranslationKey } from '../shared/i18n';
import {
  XHS_THEME_OPTIONS,
  WECHAT_THEME_OPTIONS,
  type ThemeOption,
} from '../shared/themes';

/** 侧边栏一个操作卡片的配置 */
export interface ActionItem {
  /** 唯一 key */
  key: string;
  /** 标题（i18n 字典 key，渲染时经 t() 取文案） */
  title: TranslationKey;
  /** 副标题（i18n 字典 key） */
  subtitle: TranslationKey;
  /** 点击发送给背景的消息类型；为空表示前端自行处理（如打开页面 / 视图切换） */
  msg?: string;
  /** 是否禁用（功能开发中） */
  disabled?: boolean;
  /** 前端动作：'cacheList' 切到缓存列表视图，'feedback' 打开反馈页 */
  clientAction?: 'cacheList' | 'feedback';
  /** 有样式可选的导出：点卡片先展开选择器，点样式再执行 */
  themes?: ThemeOption[];
}

/** 与 PRD 一致的操作清单 */
export const ACTIONS: ActionItem[] = [
  {
    key: 'markdown',
    title: 'actions.markdown.title',
    subtitle: 'actions.markdown.subtitle',
    msg: MSG.EXPORT_MARKDOWN,
  },
  {
    key: 'word',
    title: 'actions.word.title',
    subtitle: 'actions.word.subtitle',
    disabled: true,
  },
  {
    key: 'pdf',
    title: 'actions.pdf.title',
    subtitle: 'actions.pdf.subtitle',
    msg: MSG.EXPORT_PDF,
  },
  {
    key: 'html',
    title: 'actions.html.title',
    subtitle: 'actions.html.subtitle',
    msg: MSG.EXPORT_HTML,
  },
  {
    key: 'xhs',
    title: 'actions.xhs.title',
    subtitle: 'actions.xhs.subtitle',
    msg: MSG.EXPORT_XHS,
    themes: XHS_THEME_OPTIONS,
  },
  {
    key: 'wechat',
    title: 'actions.wechat.title',
    subtitle: 'actions.wechat.subtitle',
    msg: MSG.EXPORT_WECHAT,
    themes: WECHAT_THEME_OPTIONS,
  },
  {
    key: 'attachments',
    title: 'actions.attachments.title',
    subtitle: 'actions.attachments.subtitle',
    msg: MSG.EXPORT_ATTACHMENTS,
  },
  {
    key: 'cache',
    title: 'actions.cache.title',
    subtitle: 'actions.cache.subtitle',
    msg: MSG.CACHE_DOC,
  },
  {
    key: 'cacheList',
    title: 'actions.cacheList.title',
    subtitle: 'actions.cacheList.subtitle',
    clientAction: 'cacheList',
  },
  {
    key: 'diagnostic',
    title: 'actions.diagnostic.title',
    subtitle: 'actions.diagnostic.subtitle',
    msg: MSG.EXPORT_DIAGNOSTIC,
  },
  {
    key: 'feedback',
    title: 'actions.feedback.title',
    subtitle: 'actions.feedback.subtitle',
    clientAction: 'feedback',
  },
];
