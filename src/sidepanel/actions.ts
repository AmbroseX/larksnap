import { MSG } from '../shared/constants';

/** 侧边栏一个操作卡片的配置 */
export interface ActionItem {
  /** 唯一 key */
  key: string;
  /** 标题 */
  title: string;
  /** 副标题 */
  subtitle: string;
  /** 点击发送给背景的消息类型；为空表示前端自行处理（如打开页面 / 视图切换） */
  msg?: string;
  /** 是否禁用（功能开发中） */
  disabled?: boolean;
  /** 前端动作：'cacheList' 切到缓存列表视图，'feedback' 打开反馈页 */
  clientAction?: 'cacheList' | 'feedback';
}

/** 与 PRD 一致的操作清单 */
export const ACTIONS: ActionItem[] = [
  {
    key: 'markdown',
    title: '导出为 Markdown',
    subtitle: '下载 .zip 压缩包到本地',
    msg: MSG.EXPORT_MARKDOWN,
  },
  {
    key: 'word',
    title: '导出为 Word',
    subtitle: '功能开发中',
    disabled: true,
  },
  {
    key: 'pdf',
    title: '导出为 PDF',
    subtitle: '自动渲染生成高清 PDF',
    msg: MSG.EXPORT_PDF,
  },
  {
    key: 'html',
    title: '导出为 HTML',
    subtitle: '下载完整网页文件',
    msg: MSG.EXPORT_HTML,
  },
  {
    key: 'attachments',
    title: '导出附件',
    subtitle: '批量下载图片和文件',
    msg: MSG.EXPORT_ATTACHMENTS,
  },
  {
    key: 'cache',
    title: '缓存到本地',
    subtitle: '支持离线浏览文档',
    msg: MSG.CACHE_DOC,
  },
  {
    key: 'cacheList',
    title: '查看缓存',
    subtitle: '管理已缓存的文档',
    clientAction: 'cacheList',
  },
  {
    key: 'diagnostic',
    title: '导出诊断信息',
    subtitle: '定位私有化飞书格式差异',
    msg: MSG.EXPORT_DIAGNOSTIC,
  },
  {
    key: 'feedback',
    title: '提交意见和问题',
    subtitle: '反馈使用体验或遇到的错误',
    clientAction: 'feedback',
  },
];
