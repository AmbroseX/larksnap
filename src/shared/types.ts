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
  | 'summarize'
  // 每日心跳：同一设备一天只报一次，某天的 active 事件总数≈当日活跃设备数
  | 'active';

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

/**
 * docx 画板（whiteboard）块引用。client_vars 里画板没有任何图片，内容由页面
 * WASM 引擎实时画在 <canvas> 上，所以只能注入页面抓 canvas 转 PNG（同 sheet 块思路）。
 */
export interface WhiteboardRef {
  /** 画板块自己的 id（dox…），DOM 里 data-record-id 用它定位那块 canvas */
  blockId: string;
}

/** 转换器输出：Markdown 正文（含 feishu-asset:// / feishu-sheet-block:// / feishu-whiteboard-block:// 占位）+ 待处理素材 */
export interface MarkdownResult {
  markdown: string;
  images: MediaAsset[];
  /** 内嵌 sheet 块引用，exporter 取数后替换占位符 */
  sheetBlocks: EmbeddedSheetRef[];
  /** 画板块引用，exporter 抓 canvas 转图后替换占位符 */
  whiteboards: WhiteboardRef[];
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

/** SW → offscreen：文档 HTML 渲染成多页 PDF（官方 PDF 关闭时的 md→pdf 回退） */
export interface DocToPdfRequest {
  /** 完整正文 HTML（含内联 <style>、图片已内联为 dataURL） */
  html: string;
  /** 渲染容器的 CSS 宽度（px），按 A4 宽取值 */
  cssWidth: number;
}

/** offscreen → SW：md→pdf 渲染结果 */
export interface DocToPdfResult {
  /** 多页 PDF 的 dataURL */
  dataUrl: string;
  /** 文档过长、渲染时缩小以塞进画布上限（清晰度下降）时为 true */
  truncated?: boolean;
}

/** 运行时状态（背景写入，UI 读取） */
export interface RuntimeState {
  lastProgress: ExportProgress | null;
}

// ==================== YouTube 字幕 + AI 总结（004） ====================

/** 侧边栏页面类型（006：新增 video——youtube 之外的可下载视频站点） */
export type PageKind = 'feishu' | 'youtube' | 'video' | 'generic' | 'restricted';

/** GET_PAGE_KIND 的响应 */
export interface PageKindInfo {
  kind: PageKind;
  url?: string;
  /** 页面标题（侧边栏识别条展示用） */
  title?: string;
  /** kind 为 youtube/video 时的站点枚举名（bilibili/youtube/douyin/tiktok） */
  videoSite?: string;
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

// ==================== AI 对话页与流式总结（007） ====================

/**
 * 会话内一条消息（存储形态）。发送给端点前由 SW 经 prompts 模板转换：
 * kind='source' 的首轮取材消息会包上总结指令，其余原样透传。
 */
export interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  /** 首轮取材消息（页面全文/字幕）：UI 渲染为「已读取内容」小条，不展开原文 */
  kind?: 'source';
  /** 生成被用户停止或中途失败，内容不完整 */
  stopped?: boolean;
}

/** 一个 AI 会话。存 storage.session，按字节配额裁最旧（chat-port 落盘时执行） */
export interface ChatSession {
  id: string;
  /** 总结会话取页面标题；纯聊天会话取首条消息截断 */
  title: string;
  /** 总结会话的取材目标页；纯聊天会话没有（不碰页面） */
  target?: { tabId: number; url: string };
  /** 取材来源（统计与展示用枚举，不含 URL）；chat = 纯聊天，无页面取材 */
  sourceKind: 'youtube' | 'page' | 'chat';
  /** 取材降级提示（如「无字幕，用标题+简介总结」） */
  note?: string;
  messages: ChatMsg[];
  createdAt: number;
  updatedAt: number;
}

/** SUMMARIZE_PREPARE 成功数据：取材已缓存在 SW 内存，凭 sourceId 在 Port 上开跑 */
export interface SummaryPrepared {
  sourceId: string;
  title: string;
  sourceKind: 'youtube' | 'page';
  /** 取材字符数（UI 展示「已读取 N 字」） */
  chars: number;
  note?: string;
}

/** 会话列表条目（下拉用，不带 messages 全量） */
export interface ChatSessionMeta {
  id: string;
  title: string;
  sourceKind: 'youtube' | 'page' | 'chat';
  updatedAt: number;
}

/** 对话 Port：UI → SW。requestId 由 UI 每次生成自增分配 */
export type ChatClientMsg =
  | { type: 'start-summary'; requestId: number; sourceId: string }
  /** 纯聊天开场：不取页面、不需要任何 host 授权，首条就是普通用户消息 */
  | { type: 'start-chat'; requestId: number; text: string }
  | { type: 'ask'; requestId: number; sessionId: string; text: string }
  | { type: 'stop'; requestId: number };

/** 对话 Port：SW → UI。UI 只认等于当前 requestId 的事件，迟到的旧流直接丢弃 */
export type ChatServerMsg =
  | { type: 'accepted'; requestId: number; session: ChatSession }
  | { type: 'progress'; requestId: number; current: number; total: number }
  | { type: 'delta'; requestId: number; text: string }
  | { type: 'done'; requestId: number; message: ChatMsg }
  | { type: 'error'; requestId: number; kind: string; message: string };

// ==================== 交互入口与动作分发（006） ====================

/** 统一动作枚举：右键菜单项、快捷键 command、侧边栏入口都收敛到它 */
export type ActionId =
  | 'page-md'
  | 'page-md-download'
  | 'selection-md'
  | 'screenshot'
  | 'summarize'
  | 'ask-ai-selection'
  | 'unlock'
  | 'open-panel'
  | 'feishu-md'
  | 'feishu-pdf'
  | 'feishu-html';

/**
 * 动作分发上下文：触发瞬间捕获目标标签页，全链路显式传递。
 * 约定：dispatch 之下的任何实现禁止再查询「当前活动标签页」。
 */
export interface DispatchContext {
  tabId: number;
  url: string;
  /** 触发来源：右键菜单 / 键盘快捷键 / 侧边栏按钮 */
  source: 'menu' | 'command' | 'panel';
}

/** 后台触发动作的任务记录（storage.session，键按 tabId 分片） */
export interface TaskRecord {
  id: string;
  tabId: number;
  actionId: ActionId;
  status: 'running' | 'success' | 'error';
  /** status='error' 时的失败原因（已本地化，UI 直接展示） */
  error?: string;
  startedAt: number;
  endedAt?: number;
}

/** 选中文字的推荐指令（右键菜单与对话页推荐按钮共用的枚举） */
export type SelectionPrompt = 'summarize' | 'translate' | 'explain' | 'rewrite';

/**
 * 右键/快捷键触发时传给侧边栏的一次性导航意图（读到即删）。
 *   summary：AI 总结当前页（抓整页，可能需要授权）
 *   chat-selection：问 AI 选中文字（纯聊天通路，零授权）
 */
export interface NavigationIntent {
  target: 'summary' | 'chat-selection';
  autoStart: boolean;
  tabId: number;
  url: string;
  /** target='chat-selection'：右键时的选中文字（info.selectionText） */
  selectionText?: string;
  /** target='chat-selection'：推荐指令 */
  selPrompt?: SelectionPrompt;
  /** 写入时间：超过 30s 未被消费视为过期丢弃 */
  createdAt: number;
}

/** 侧边栏界面偏好（storage.local，与 config 解耦） */
export interface UiPrefs {
  /** 通用工具区各分组的折叠态；缺省时剪藏展开、其余折叠 */
  collapsedGroups: Record<string, boolean>;
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
