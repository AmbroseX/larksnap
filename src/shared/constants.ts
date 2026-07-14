import type { ExtensionConfig } from './types';

/** 扩展版本（与 manifest 保持同步） */
export const EXTENSION_VERSION = '0.1.0';

/** chrome.storage.local 的键名 */
export const STORAGE_KEYS = {
  CONFIG: 'larksnap:config',
  RUNTIME_STATE: 'larksnap:runtime',
  /** 缓存文档索引 */
  CACHE_INDEX: 'larksnap:cache:index',
  /** 单篇缓存内容前缀，完整键为 `${CACHE_DOC_PREFIX}${token}` */
  CACHE_DOC_PREFIX: 'larksnap:cache:doc:',
  /** Markdown 导出能力缓存（按 host）：Record<host, MarkdownCapability> */
  MD_CAP: 'larksnap:md-capability',
  /** 视频下载线路记忆（按站点枚举名）：Record<site, VideoRoute> */
  VIDEO_ROUTE: 'larksnap:video-route',
  /** 后台触发动作的任务记录前缀（storage.session），完整键为 `${TASKS_PREFIX}${tabId}` */
  TASKS_PREFIX: 'larksnap:tasks:',
  /** 「AI 总结」导航意图（storage.session，单槽、读到即删） */
  INTENT: 'larksnap:intent',
  /** 侧边栏界面偏好（storage.local）：UiPrefs */
  UI_PREFS: 'larksnap:ui-prefs',
  /** AI 会话列表（storage.session）：ChatSession[]，按字节配额裁最旧 */
  CHAT_SESSIONS: 'larksnap:chat:sessions',
  /**
   * 侧边栏上次停留页（storage.local）：'home' | 'chat'。
   * 独立键——UI_PREFS 是整对象覆盖写，混存会互相冲掉（007 评审 P2）。
   */
  LAST_VIEW: 'larksnap:last-view',
} as const;

/** UI ↔ 背景 的消息类型 */
export const MSG = {
  // 文档识别
  GET_DOC_INFO: 'get_doc_info',
  // 导出动作
  EXPORT_MARKDOWN: 'export_markdown',
  EXPORT_WORD: 'export_word',
  EXPORT_PDF: 'export_pdf',
  EXPORT_HTML: 'export_html',
  EXPORT_ATTACHMENTS: 'export_attachments',
  EXPORT_XHS: 'export_xhs',
  EXPORT_WECHAT: 'export_wechat',
  /** 整页长图截图（任意网页，输出 PNG/PDF），data={ format } */
  EXPORT_SCREENSHOT: 'export_screenshot',
  // 缓存
  CACHE_DOC: 'cache_doc',
  CACHE_LIST: 'cache_list',
  CACHE_DELETE: 'cache_delete',
  CACHE_GET: 'cache_get',
  // 工具
  EXPORT_DIAGNOSTIC: 'export_diagnostic',
  // 状态
  GET_STATUS: 'get_status',
  /** 当前标签页的后台任务记录（右键/快捷键触发的结果，006）：TaskRecord[] */
  LIST_TASK_RECORDS: 'list_task_records',
  // 桥接（CC ⇄ daemon）连接状态：popup 展示版本/连接/profile
  GET_BRIDGE_STATUS: 'get_bridge_status',
  // content → SW：读取 Cookie（HttpOnly CSRF token）
  GET_COOKIE: 'get_cookie',
  // 私有化域名权限（UI 用户手势触发）
  CHECK_PERMISSION: 'check_permission',
  REQUEST_PERMISSION: 'request_permission',
  REVOKE_PERMISSION: 'revoke_permission',
  LIST_TRUSTED: 'list_trusted',
  // 背景 → UI 的进度推送
  PROGRESS: 'progress',
  // 网页复制（webcopy，侧边栏发起时由侧边栏写剪贴板/下载）
  WEBCOPY_PAGE_MD: 'webcopy_page_md',
  WEBCOPY_SELECTION_MD: 'webcopy_selection_md',
  WEBCOPY_TOGGLE_UNLOCK: 'webcopy_toggle_unlock',
  /** 查询当前标签页 webcopy 挂载状态（不注入，零侵入） */
  WEBCOPY_GET_STATE: 'webcopy_get_state',
  /** 仅确保 webcopy 已注入当前标签页（自动复制开关生效用） */
  WEBCOPY_ENSURE: 'webcopy_ensure',
  // 视频下载（经桥接交给本地 daemon 跑 yt-dlp）
  DOWNLOAD_VIDEO: 'download_video',
  /** 查询当前标签页是否支持视频下载 + 桥接是否就绪（决定侧边栏入口显隐） */
  GET_VIDEO_STATE: 'get_video_state',
  /** 探测当前视频的可用清晰度档位（daemon 跑 yt-dlp -J） */
  PROBE_VIDEO: 'probe_video',
  /** 拉取视频下载任务列表（含排队/进行中/已结束） */
  LIST_VIDEO_TASKS: 'list_video_tasks',
  /** 清除已结束（成功/失败）的下载任务 */
  CLEAR_VIDEO_TASKS: 'clear_video_tasks',
  /** 在系统文件管理器里显示下载产物（daemon 执行；无 taskId 时打开下载根目录） */
  REVEAL_VIDEO_FILE: 'reveal_video_file',
  /** SW → UI：任务列表变化推送（全量） */
  VIDEO_TASKS: 'video_tasks',
  // 标签页链接复制
  COPY_TABS: 'copy_tabs',
  // UI → SW：匿名统计事件（SW 统一收口上报）
  TRACK: 'track',
  // ---- YouTube 字幕 + AI 总结（004）----
  /** 判断当前页类型：feishu / youtube / generic / restricted（侧边栏三态入口用） */
  GET_PAGE_KIND: 'get_page_kind',
  /** 导出 YouTube 字幕：data={ lang?, mode:'download'|'copy' } */
  EXPORT_TRANSCRIPT: 'export_transcript',
  /** 列出当前视频的字幕轨（语言选择用） */
  LIST_CAPTION_TRACKS: 'list_caption_tracks',
  /** AI 总结当前页（YouTube 字幕 / 网页正文），未配置端点或未确认时返回引导态 */
  SUMMARIZE_PAGE: 'summarize_page',
  // ---- AI 对话页与流式总结（007）----
  /** 总结前置：配置/确认检查 + 取材缓存，data={ tabId?, url? }，响应 SummaryPrepared 或引导态 */
  SUMMARIZE_PREPARE: 'summarize_prepare',
  /** 会话列表（元信息，不带 messages）：ChatSessionMeta[] */
  CHAT_LIST_SESSIONS: 'chat_list_sessions',
  /** 取单个会话全量：data={ id }，响应 ChatSession | null */
  CHAT_GET_SESSION: 'chat_get_session',
  /** 读当前活动标签页的选中文字（activeTab，读不到返回空串）：{ text } */
  GET_SELECTION: 'get_selection',
} as const;

/** AI 对话流式长连接的 Port 名（侧边栏 chrome.runtime.connect 用） */
export const CHAT_PORT_NAME = 'larksnap-chat';

/** SW ⇄ offscreen 页的消息类型（小红书卡片渲染，§六） */
export const OFFSCREEN_MSG = {
  /** SW → offscreen：渲染请求，data 为 XhsRenderRequest，响应带 XhsRenderResult */
  XHS_RENDER: 'offscreen_xhs_render',
  /** offscreen → SW：单张卡片渲染进度（fire-and-forget） */
  XHS_PROGRESS: 'offscreen_xhs_progress',
  /** SW → offscreen：整页截图拼接请求，data 为 ShotStitchRequest，响应带 ShotStitchResult */
  SHOT_STITCH: 'offscreen_shot_stitch',
  /** offscreen → SW：逐屏拼接进度（fire-and-forget） */
  SHOT_PROGRESS: 'offscreen_shot_progress',
} as const;

/** content script 内部消息类型（背景 → content） */
export const CONTENT_MSG = {
  DETECT_DOC: 'detect_doc',
  GET_SNAPSHOT: 'get_snapshot',
  /** 代发飞书内部接口（同源 fetch）：data={ method, path, body? } */
  FEISHU_REQUEST: 'feishu_request',
  /** 下载媒体二进制（content 同源 fetch → base64）：data={ token, objToken } */
  DOWNLOAD_MEDIA: 'download_media',
  /** 滚动加载全文（懒加载内容） */
  SCROLL_LOAD: 'scroll_load',
  // ---- webcopy（SW → webcopy.js，与飞书 content 消息互不相干）----
  /** 整页转 Markdown：data={ writeClipboard? } */
  WEBCOPY_PAGE_TO_MD: 'webcopy_page_to_md',
  /** 选区转 Markdown：data={ writeClipboard? } */
  WEBCOPY_SELECTION_TO_MD: 'webcopy_selection_to_md',
  /** 解锁开关：data={ enabled? }，缺省则取反（右键菜单切换用） */
  WEBCOPY_UNLOCK: 'webcopy_unlock',
  /** 查询挂载状态（unlocked 等） */
  WEBCOPY_STATE: 'webcopy_state',
} as const;

/** YouTube 字幕 content script（youtube.js）的内部消息类型（背景 → content） */
export const YT_MSG = {
  /** 抓当前视频字幕：data={ lang? }，响应 TranscriptResult */
  GET_TRANSCRIPT: 'yt_get_transcript',
  /** 列出字幕轨：响应 CaptionTrackInfo[] */
  LIST_TRACKS: 'yt_list_tracks',
} as const;

/** POST 校验用的 CSRF cookie 候选名（按序尝试，失败换名重试） */
export const CSRF_COOKIE_NAMES = ['_csrf_token', 'swp_csrf_token'];

/** 飞书 token 正则：未知域名识别门槛 */
export const FEISHU_TOKEN_RE = /^[A-Za-z0-9]{16,}$/;

/** 飞书文档支持的域名后缀 */
export const FEISHU_HOSTS = ['feishu.cn', 'feishu.net', 'larksuite.com'];

/**
 * 支持视频下载的站点（第一层：整页 URL 交给 daemon 的 yt-dlp 提取）。
 * site 是统计用的枚举名（隐私红线：只上报枚举，不上报真实 URL）。
 */
export const VIDEO_SITES: ReadonlyArray<{ site: string; hosts: string[] }> = [
  { site: 'bilibili', hosts: ['bilibili.com', 'b23.tv'] },
  { site: 'youtube', hosts: ['youtube.com', 'youtu.be'] },
  { site: 'douyin', hosts: ['douyin.com'] },
  { site: 'tiktok', hosts: ['tiktok.com'] },
];

/** 匿名统计（Umami 自建实例）。上报内容见 src/background/analytics.ts 白名单 */
export const UMAMI_HOST = 'https://umami.youmiai.ai';
export const UMAMI_WEBSITE_ID = '2825d17d-e96c-4ec0-813b-4e2144cc25c1';

/** 开源项目主页 */
export const REPO_URL = 'https://github.com/AmbroseX/larksnap';

/** 错误反馈（GitHub Issues） */
export const ISSUES_URL = 'https://github.com/AmbroseX/larksnap/issues';

/** 默认配置 */
export const DEFAULT_CONFIG: ExtensionConfig = {
  language: 'auto',
  imageMode: 'download',
  feedbackUrl: `${ISSUES_URL}/new`,
  diagnosticIncludeSnapshot: true,
  trustedDomains: [],
  webcopy: {
    autoCopyEnabled: false,
    autoCopyMinChars: 5,
    autoCopyFormat: 'text',
    tabCopyFormat: 'markdown',
    frontmatter: true,
    pageImageMode: 'link',
  },
  analyticsEnabled: true,
  videoProxy: { scheme: 'http', host: '', port: '', bypass: '', proxyOnly: '' },
};
