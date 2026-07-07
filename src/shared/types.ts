// ==================== 飞书文档类型 ====================

/** 飞书文档子类型（对应 URL 路径段） */
export type FeishuDocType =
  | 'docx' // 新版文档
  | 'docs' // 旧版文档
  | 'wiki' // 知识库节点
  | 'sheets' // 电子表格
  | 'base' // 多维表格
  | 'file' // 云文件
  | 'unknown';

/** 当前页面识别出的飞书文档信息 */
export interface DocInfo {
  /** 是否为受支持的飞书文档页面 */
  isFeishuDoc: boolean;
  /** 文档子类型 */
  docType: FeishuDocType;
  /** 文档 token（URL 中的资源 ID） */
  token: string;
  /** 文档标题（尽力从页面提取） */
  title: string;
  /** 页面 URL */
  url: string;
  /** 文档所在域名（用于私有化部署识别） */
  host: string;
  /** 是否为私有化/企业自建域名部署（未知域名靠路径+token 模式命中） */
  isPrivateDeploy: boolean;
  /** 瞬时信号：私有化域名尚未授权，UI 需引导用户手势授权（非持久属性） */
  needsAuth?: boolean;
}

// ==================== 导出动作 ====================

/** 侧边栏可触发的导出/工具动作 */
export type ExportAction =
  | 'markdown'
  | 'word'
  | 'pdf'
  | 'html'
  | 'attachments'
  | 'cache'
  | 'cacheList'
  | 'diagnostic'
  | 'feedback';

/** 单次导出任务的运行状态 */
export type TaskStatus = 'idle' | 'running' | 'success' | 'error';

/** 导出任务进度（背景 → 侧边栏推送） */
export interface ExportProgress {
  action: ExportAction;
  status: TaskStatus;
  /** 0-100，未知进度时为 undefined */
  percent?: number;
  /** 状态栏展示的文案，如 "准备就绪，等待操作..." */
  message: string;
}

// ==================== 缓存 ====================

/** 已缓存到本地的文档元信息 */
export interface CachedDoc {
  token: string;
  docType: FeishuDocType;
  title: string;
  url: string;
  /** 缓存时间戳（ms） */
  cachedAt: number;
  /** 缓存内容大小（字节，估算值） */
  size: number;
}

// ==================== 配置 / 运行时状态 ====================

/** 标签页复制的输出格式 */
export type TabCopyFormat = 'markdown' | 'title-url' | 'title' | 'url';

/** 网页复制（webcopy）配置 */
export interface WebCopyConfig {
  /** 选中文字自动复制开关 */
  autoCopyEnabled: boolean;
  /** 自动复制的最小选中字符数 */
  autoCopyMinChars: number;
  /** 自动复制格式 */
  autoCopyFormat: 'text' | 'markdown';
  /** 标签页复制格式 */
  tabCopyFormat: TabCopyFormat;
}

/** 插件配置（持久化在 chrome.storage.local） */
export interface ExtensionConfig {
  /** 导出 Markdown 时图片处理方式 */
  imageMode: 'download' | 'link';
  /** 反馈页面 URL */
  feedbackUrl: string;
  /** 是否在导出诊断信息中包含页面快照 */
  diagnosticIncludeSnapshot: boolean;
  /** 已运行时授权的私有化域名 origin 列表（如 https://x.私有化租户.com） */
  trustedDomains: string[];
  /** 网页复制（任意网页转 Markdown / 解锁 / 自动复制） */
  webcopy: WebCopyConfig;
  /** 匿名使用统计开关（Umami，仅事件名+版本号，无任何文档内容/URL） */
  analyticsEnabled: boolean;
}

// ==================== 匿名统计（Umami） ====================

/** 允许上报的事件名（白名单，超出即丢弃） */
export type TrackEventName =
  | 'install'
  | 'update'
  | 'open'
  | 'export'
  | 'webcopy'
  | 'bridge'
  | 'edit';

/**
 * 一次统计事件。隐私红线：data 只允许枚举串 / 布尔 / 整数，
 * 禁止文档 token、标题、真实 URL、域名等任何可识别信息。
 */
export interface TrackEvent {
  name: TrackEventName;
  /** Umami 里展示的伪路径（如 /export/markdown），缺省用 /{name} */
  url?: string;
  data?: Record<string, string | number | boolean>;
}

// ==================== 网页复制（webcopy） ====================

/** 整页 / 选区转换结果 */
export interface WebCopyMdResult {
  markdown: string;
  title: string;
}

/** webcopy 在某标签页上的挂载状态（未注入过则 mounted=false） */
export interface WebCopyState {
  mounted: boolean;
  unlocked: boolean;
}

/** 侧边栏注入失败时的兜底信息：需在 UI 手势里发起 permissions.request */
export interface WebCopyNeedsPermission {
  needsPermission: true;
  /** 授权用 origin pattern，如 *://example.com/* */
  originPattern: string;
}

// ==================== Markdown 导出能力（按 host 缓存） ====================

/** 某 host 是否支持官方 Markdown 导出（决定走 P-official 还是 P-decode） */
export interface MarkdownCapability {
  /** 域名（唯一键） */
  host: string;
  /** 官方 md 导出是否可用 */
  mdExportSupported: boolean;
  /** 探测时间（ms） */
  checkedAt: number;
}

// ==================== P-decode 中间结构 ====================

/** apool 解码后的行内文本节点（纯文本 + 行内标记） */
export interface InlineNode {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  inlineCode?: boolean;
  /** 链接 URL（存在则为链接） */
  link?: string;
  /** 行内公式的 LaTeX 源码（正文里只是占位符，渲染时用它替换） */
  equation?: string;
}

/** client_vars block_map 归一后的块结构 */
export interface Block {
  id: string;
  /** client_vars 的字符串类型，如 text/code/heading1/bullet/table */
  type: string;
  parentId: string | null;
  /** 子块顺序（block id） */
  children: string[];
  /** apool 解码后的行内文本（文本类块） */
  text: InlineNode[];
  /** 块特有数据：image.token / code.language / table 结构等 */
  extra: Record<string, unknown>;
}

/** 导出中收集的素材（图片/附件） */
export interface MediaAsset {
  /** box… token，去重键 */
  token: string;
  /** 该素材所在块的 id（dox…）——媒体下载接口的 mount_node_token 用它，不是文档 token */
  mountToken: string;
  /** 原名 / alt 文本 */
  name: string;
  /** MIME 类型，用于定扩展名 */
  mimeType: string;
  /** 是否图片（决定走 cover 还是 download/all） */
  isImage?: boolean;
  width?: number;
  height?: number;
}

/** docx 内嵌 sheet 块的引用（client_vars 里只有引用，单元格在页面内存模型里） */
export interface EmbeddedSheetRef {
  /** sheet 块自己的 id（dox…），DOM 锚点 data-record-id 用它 */
  blockId: string;
  /** 源电子表格 token（sht…），兜底链接用 */
  shtToken: string;
  /** 子表 id，在页面 window.spread.sheets 里按它定位模型 */
  subId: string;
}

/** 转换器输出：Markdown 正文（含 feishu-asset:// / feishu-sheet-block:// 占位）+ 待处理素材 */
export interface MarkdownResult {
  markdown: string;
  images: MediaAsset[];
  /** 内嵌 sheet 块引用，exporter 取数后替换占位符 */
  sheetBlocks: EmbeddedSheetRef[];
}

/** 运行时状态（背景写入，UI 读取） */
export interface RuntimeState {
  lastProgress: ExportProgress | null;
}

// ==================== 消息协议 ====================

/** UI ↔ 背景 的统一消息信封 */
export interface Message<T = unknown> {
  type: string;
  data?: T;
}

/** 背景对一次请求的统一响应 */
export interface Response<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
