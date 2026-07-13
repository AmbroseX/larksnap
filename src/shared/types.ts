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
  | 'xhs'
  | 'wechat'
  | 'attachments'
  | 'cache'
  | 'cacheList'
  | 'diagnostic'
  | 'feedback'
  | 'video'
  | 'screenshot'
  | 'transcript'
  | 'summarize';

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
  /** 整页转 Markdown 时开头输出 YAML frontmatter（关闭则用简单标题头） */
  frontmatter: boolean;
  /** 整页转 Markdown 的图片处理：保留外链 / 内联 base64（跨域取不到时回退外链） */
  pageImageMode: 'link' | 'base64';
}

/**
 * AI 总结配置（004）。端点完全由用户自填，扩展不内置任何默认第三方端点（FR-003）。
 * apiKey 只存 chrome.storage.local，绝不进诊断包 / 统计 / 日志（FR-006）。
 */
export interface AiConfig {
  /** OpenAI 兼容端点根地址（如 https://你的端点，会拼上 /v1/chat/completions） */
  baseUrl: string;
  /** 用户自己的 API Key */
  apiKey: string;
  /** 模型名 */
  model: string;
  /** 总结产物的输出语言（也作字幕默认选轨语言） */
  targetLang: string;
  /** 首次使用「内容将发送到你配置的端点」告知是否已确认（FR-004） */
  acknowledged: boolean;
}

/** 界面语言的实际取值（字典语言） */
export type Language = 'zh' | 'en';

/** 界面语言设置项：auto = 跟随浏览器 UI 语言 */
export type LanguageSetting = 'auto' | Language;

/** 插件配置（持久化在 chrome.storage.local） */
export interface ExtensionConfig {
  /** 界面语言（设置页可切换，默认跟随浏览器） */
  language: LanguageSetting;
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
  /**
   * 视频下载代理。host 为空 = 跟随 daemon 的系统代理环境变量。
   * 命中 bypass 列表的站点强制直连；其余站点走代理还是直连由
   * 「按站点线路记忆」决定（失败自动切换并记住）。
   */
  videoProxy: VideoProxyConfig;
  /** 匿名使用统计开关（Umami，仅事件名+版本号，无任何文档内容/URL） */
  analyticsEnabled: boolean;
  /** AI 总结端点（用户自配，缺省即未配置 → 总结入口呈引导态，不发任何请求） */
  ai?: AiConfig;
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
  | 'edit'
  | 'video'
  | 'summarize';

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
  /** 正文来源：defuddle=提取器命中 / fallback=选择器链兜底 / raw-text·pre=非 HTML 短路 */
  source?: 'defuddle' | 'fallback' | 'raw-text' | 'pre';
  /** 走了兜底链，正文识别可能不全（UI 提示用） */
  degraded?: boolean;
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
  underline?: boolean;
  inlineCode?: boolean;
  /** 文字颜色（CSS 色值；apool 里非 CSS 形态的值不透传） */
  color?: string;
  /** 背景高亮色（CSS 色值） */
  background?: string;
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

// ==================== 视频下载（扩展 → daemon 反向任务） ====================

/** 探测出的一个清晰度档位（fps 只分 60 帧档 / 普通档两种） */
export interface VideoQualityOption {
  height: number;
  fps: number | null;
}

/** 清晰度探测结果（背景 → 侧边栏） */
export interface VideoProbeResult {
  title?: string;
  options: VideoQualityOption[];
  /** 本次探测实际成功的线路（SW 用来更新按站点线路记忆，UI 不用管） */
  route?: VideoRoute;
}

/** 视频下载线路：走配置的代理（或系统代理）/ 直连 */
export type VideoRoute = 'proxy' | 'direct';

/** 视频下载代理配置（options 页「代理服务器」区块） */
export interface VideoProxyConfig {
  /** 代理协议 */
  scheme: 'http' | 'https' | 'socks5';
  /** 代理服务器主机；留空 = 不配显式代理，跟随 daemon 的系统代理环境变量 */
  host: string;
  /** 代理端口（字符串存储，方便表单往返） */
  port: string;
  /** 不走代理的站点列表：每行一个主机，支持 * 通配（如 *.bilibili.com） */
  bypass: string;
  /** 必须走代理的站点列表（同格式）；命中则强制走代理、失败不切直连。与 bypass 都命中时 bypass 优先 */
  proxyOnly: string;
}

/** 一次视频下载任务（SW 内存任务表，侧边栏任务列表渲染用） */
export interface VideoTaskInfo {
  id: string;
  url: string;
  site: string;
  /** 发起时的页面标题（尽力取，取不到用 URL） */
  title: string;
  status: 'queued' | 'running' | 'success' | 'error';
  percent?: number;
  /** 最近一条进度/错误文案（错误时含完整日志路径） */
  message?: string;
  /** 成功落盘的文件路径 */
  file?: string;
  createdAt: number;
}

/** 侧边栏「下载视频」入口的可用状态 */
export interface VideoState {
  /** 当前标签页是否为支持的视频站点 */
  supported: boolean;
  /** 命中的站点枚举名（bilibili/youtube/douyin/tiktok） */
  site?: string;
  /** 当前标签页地址（UI 用于「换视频了才重新探测」的去重） */
  url?: string;
  /** 桥接就绪（daemon 已连且协议 >= v3）；false 时 reason 给引导文案 */
  bridgeReady: boolean;
  reason?: string;
}

// ==================== 整页截图（任意网页长图） ====================

/** 截图导出格式 */
export type ScreenshotFormat = 'png' | 'pdf';

/** 逐屏抓取的一屏截图（滚动 + captureVisibleTab 产物） */
export interface CaptureShot {
  /** 该屏 PNG 的 dataURL */
  dataUrl: string;
  /** 该屏顶部在文档中的纵向偏移（CSS 像素，缩放系数由 offscreen 侧按首屏真实像素宽反推） */
  yPos: number;
}

/** SW → offscreen 的拼接请求 */
export interface ShotStitchRequest {
  shots: CaptureShot[];
  format: ScreenshotFormat;
  /** 视口 CSS 宽度：offscreen 用「首屏真实像素宽 ÷ 它」得实际缩放系数（含 DPR 与浏览器缩放） */
  viewportCssWidth: number;
  /** 整页 CSS 高度（×缩放系数后得画布高） */
  totalHeightCss: number;
}

/** offscreen → SW 的拼接结果 */
export interface ShotStitchResult {
  /** 长图 PNG 或多页 PDF 的 dataURL */
  dataUrl: string;
  /** 页面过长被封顶截断时为 true（MVP 尺寸保护） */
  truncated?: boolean;
}

/** offscreen → SW 的拼接进度（fire-and-forget） */
export interface ShotStitchProgress {
  done: number;
  total: number;
}

/** 运行时状态（背景写入，UI 读取） */
export interface RuntimeState {
  lastProgress: ExportProgress | null;
}

// ==================== YouTube 字幕 + AI 总结（004） ====================

/** 侧边栏三态路由的页面类型（FR-009：飞书页现状不动，其余按站点出入口） */
export type PageKind = 'feishu' | 'youtube' | 'generic' | 'restricted';

/** GET_PAGE_KIND 的响应 */
export interface PageKindInfo {
  kind: PageKind;
  url?: string;
}

/** 一条字幕轨（语言选择用） */
export interface CaptionTrackInfo {
  languageCode: string;
  /** 轨道展示名（如「中文（简体）」） */
  name: string;
  /** 字幕接口地址（只在 content 内部用，不回传 UI） */
  baseUrl?: string;
}

/** 字幕里保留时间戳的一段（P2 章节时间戳直接用，US1 导出时拍平） */
export interface TranscriptSegment {
  tStartMs: number;
  text: string;
}

/** 字幕抓取结果（content → SW）。degraded=true 时走「标题+简介」降级链 */
export interface TranscriptResult {
  degraded: boolean;
  title: string;
  videoId: string;
  /** 拍平后的字幕全文（degraded 时为空） */
  transcript?: string;
  /** 保留 tStartMs 的分段结构 */
  segments?: TranscriptSegment[];
  /** 降级时的视频简介 */
  description?: string;
  /** 实际选中的字幕轨 */
  track?: CaptionTrackInfo;
}

/** AI 总结结果（SW → 侧边栏） */
export interface SummaryResult {
  markdown: string;
  /** 切了几块（统计只报这个数值，不含内容） */
  chunks: number;
  /** refine 中途失败时保留的部分结果标记 */
  partial?: boolean;
  /** 取材来源枚举（统计用：youtube 字幕 / 网页正文） */
  kind?: 'youtube' | 'page';
}

/** SUMMARIZE_PAGE 的引导响应：端点已配置但首次使用未确认（FR-004） */
export interface SummaryNeedsAck {
  needsAck: true;
  /** 一次性告知框里展示的端点域名 */
  endpointOrigin: string;
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
