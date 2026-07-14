import { useEffect, useState, useCallback, useRef } from 'react';
import type {
  DocInfo,
  ExportProgress,
  NavigationIntent,
  PageKindInfo,
  RuntimeState,
  TaskRecord,
} from '../shared/types';
import { MSG, STORAGE_KEYS } from '../shared/constants';
import { sendToBackground, onBackgroundMessage } from '../shared/messaging';
import { hostOf, permissionPattern } from '../shared/feishu-host';
import { useI18n } from '../shared/i18n/useI18n';
import { type ActionItem } from './actions';
import { copyHtmlToClipboard } from './copy-html';
import { XhsPreview, type XhsPreviewData } from './XhsPreview';
import { CacheView } from './CacheView';
import { HeaderStatus } from './HeaderStatus';
import { ContextZone, VideoSection } from './ContextZone';
import { ToolGroups } from './ToolGroups';
import { Footer } from './Footer';
import { ChatView, type ChatAutoStart } from './ChatView';

/**
 * 侧边栏主组件（006 重构，007 增加双页 Tab）：
 *   header（logo + daemon 状态点 + 工具/AI 对话 Tab + 设置 + 缓存库）
 *   → home（上下文区 + 通用工具区）⇄ chat（AI 对话页，保持挂载切显隐——
 *     卸载会断 Port 导致 SW 中止流式生成）。
 * cache、xhsPreview 仍是带返回的二级页。
 */

type View = 'home' | 'chat' | 'cache' | 'xhsPreview';

/**
 * 读取并消费导航意图（006「AI 总结」/ 008「问 AI 选中文字」，右键/快捷键入口写入）：
 * 单槽、读到即删（一次性）、超 30s 视为过期丢弃、形状不合法丢弃。
 */
async function consumeIntent(): Promise<NavigationIntent | null> {
  try {
    const got = await chrome.storage.session.get(STORAGE_KEYS.INTENT);
    const intent = got[STORAGE_KEYS.INTENT] as NavigationIntent | undefined;
    if (!intent || (intent.target !== 'summary' && intent.target !== 'chat-selection'))
      return null;
    await chrome.storage.session.remove(STORAGE_KEYS.INTENT);
    if (typeof intent.tabId !== 'number' || typeof intent.url !== 'string') return null;
    if (Date.now() - (intent.createdAt || 0) > 30_000) return null;
    return intent.autoStart ? intent : null;
  } catch {
    return null;
  }
}

export function SidePanel() {
  const { t } = useI18n();
  const [view, setView] = useState<View>('home');
  /** null = 空闲态，渲染时取当前语言的「准备就绪」文案（切语言即跟随） */
  const [status, setStatus] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const [phase, setPhase] = useState<ExportProgress['status']>('idle');
  const [doc, setDoc] = useState<DocInfo | null>(null);
  /** 页面五分类（006）：驱动上下文区渲染 */
  const [pageInfo, setPageInfo] = useState<PageKindInfo | null>(null);
  const [authing, setAuthing] = useState(false);
  /** 小红书卡片预览数据（出图后先预览，确认再下载） */
  const [xhsPreview, setXhsPreview] = useState<XhsPreviewData | null>(null);
  /** 当前标签页最近一条后台任务失败记录（右键/快捷键触发，US5） */
  const [taskErr, setTaskErr] = useState<TaskRecord | null>(null);
  /** 导航意图带来的自动总结目标（消费后传给 ChatView，按 ts 去重） */
  const [chatIntent, setChatIntent] = useState<ChatAutoStart | null>(null);

  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** home ⇄ chat 切换并记住停留页（独立键，不与 ui-prefs 互写，007） */
  const switchView = useCallback((v: 'home' | 'chat') => {
    setView(v);
    void chrome.storage.local.set({ [STORAGE_KEYS.LAST_VIEW]: v });
  }, []);

  // 恢复上次停留页 + 消费「AI 总结」导航意图（意图优先，直接落到对话页）
  useEffect(() => {
    let landed = false;
    const tryConsume = () =>
      void consumeIntent().then((intent) => {
        if (!intent) return;
        landed = true;
        setChatIntent({
          tabId: intent.tabId,
          url: intent.url,
          ts: Date.now(),
          ...(intent.target === 'chat-selection'
            ? { selectionText: intent.selectionText, selPrompt: intent.selPrompt }
            : null),
        });
        setView('chat');
      });
    chrome.storage.local.get(STORAGE_KEYS.LAST_VIEW).then((got) => {
      if (!landed && got[STORAGE_KEYS.LAST_VIEW] === 'chat') setView('chat');
    });
    tryConsume();
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (area !== 'session' || !changes[STORAGE_KEYS.INTENT]?.newValue) return;
      tryConsume();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  const refreshDoc = useCallback(async () => {
    const res = await sendToBackground<DocInfo>(MSG.GET_DOC_INFO);
    if (res.success) setDoc(res.data ?? null);
    const kind = await sendToBackground<PageKindInfo>(MSG.GET_PAGE_KIND);
    if (kind.success) setPageInfo(kind.data ?? null);
    // 后台任务记录：最近一条失败的展示在状态栏上方（打开侧边栏即视为已读，背景会清角标）
    const tasks = await sendToBackground<TaskRecord[]>(MSG.LIST_TASK_RECORDS);
    const latest = tasks.success ? tasks.data?.[0] : null;
    setTaskErr(latest && latest.status === 'error' ? latest : null);
  }, []);

  // 成功提示挂几秒就够了，自动回到"准备就绪"；出错的提示保留给用户看
  const armIdleReset = useCallback(() => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => {
      resetTimer.current = null;
      setStatus(null);
      setPhase('idle');
      setPercent(null);
    }, 4000);
  }, []);

  // 启动时拉取上次进度 + 当前文档信息，并订阅后续进度推送
  useEffect(() => {
    // 匿名统计：侧边栏打开即当日活跃（可在设置页关闭）
    void sendToBackground(MSG.TRACK, {
      name: 'open',
      url: '/open/sidepanel',
      data: { ui: 'sidepanel' },
    });
    sendToBackground<RuntimeState>(MSG.GET_STATUS).then((res) => {
      const last = res.success ? res.data?.lastProgress : null;
      // 只恢复进行中的任务；上次已完成/失败的旧提示不再翻出来
      if (last && last.status === 'running') {
        setStatus(last.message);
        setPhase(last.status);
        setPercent(last.percent ?? null);
      }
    });
    refreshDoc();

    const off = onBackgroundMessage((msg) => {
      if (msg.type === MSG.PROGRESS) {
        const p = msg.data as ExportProgress;
        setStatus(p.message);
        setPhase(p.status);
        setPercent(p.percent ?? null);
        if (p.status !== 'running') setRunning(null);
        if (p.status === 'success') {
          armIdleReset();
        } else if (resetTimer.current) {
          clearTimeout(resetTimer.current);
          resetTimer.current = null;
        }
      }
    });
    // 切标签页 / 页内跳转（YouTube 是 SPA）→ 重新识别页面类型与文档信息
    const onActivated = () => void refreshDoc();
    const onUpdated = (
      _tabId: number,
      info: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab
    ) => {
      if (tab.active && (info.url || info.status === 'complete')) void refreshDoc();
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      off();
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, [refreshDoc, armIdleReset]);

  // 私有化未授权：用户手势触发 chrome.permissions.request（必须在页面上下文调用）
  const handleAuthorize = useCallback(async () => {
    if (!doc) return;
    const host = hostOf(doc.url);
    if (!host) return;
    // 按基础域通配授权，覆盖页面域 + 图片/导出下载子域（internal-api-drive-stream.*）
    const pattern = permissionPattern(host);
    setAuthing(true);
    try {
      // request 异常（如手势失效、pattern 不合法）不吞：原因直接显示在状态栏
      let granted = false;
      try {
        granted = await chrome.permissions.request({ origins: [pattern] });
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e));
        return;
      }
      if (granted) {
        // 只有飞书文档页的授权才记入「已信任域名」——那份列表同时决定右键菜单
        // 飞书导出组的显示范围，普通网页的域名混进去会让「导出为 Markdown/PDF」
        // 出现在非飞书页面上（点了必失败）。普通网页只授权、不记录。
        if (doc.isFeishuDoc) {
          await sendToBackground(MSG.REQUEST_PERMISSION, { pattern });
        }
        await refreshDoc();
        setStatus(
          doc.isFeishuDoc ? t('sidepanel.authorizedFeishu') : t('sidepanel.authorizedWeb')
        );
      } else {
        setStatus(t('sidepanel.notAuthorized'));
      }
    } finally {
      setAuthing(false);
    }
  }, [doc, refreshDoc]);

  const runAction = useCallback(
    async (item: ActionItem, themeId?: string) => {
      if (!item.msg) return;
      setRunning(item.key);
      setPhase('running');
      setPercent(null);
      setStatus(t('sidepanel.runningAction', { name: t(item.title) }));
      const res = await sendToBackground(item.msg, themeId ? { themeId } : undefined);
      if (!res.success) {
        setStatus(res.error || t('sidepanel.actionFailed'));
        setPhase('error');
        setRunning(null);
        return;
      }

      // 小红书卡片：SW 只出图，先进预览页过目，确认后再打包下载
      if (item.key === 'xhs') {
        const d = res.data as { title?: string; pngs?: string[] } | undefined;
        if (d?.pngs?.length) {
          const themeKey = item.themes?.find((th) => th.id === themeId)?.name;
          setXhsPreview({
            title: d.title || t('sidepanel.xhsDefaultTitle'),
            pngs: d.pngs,
            themeName: themeKey ? t(themeKey) : undefined,
          });
          setView('xhsPreview');
        }
        setRunning(null);
        return;
      }

      // 公众号格式：SW 只负责生成 HTML，剪贴板由侧边栏写（手势/焦点在这边）
      if (item.key === 'wechat') {
        const html = (res.data as { html?: string } | undefined)?.html;
        if (!html) return;
        try {
          await copyHtmlToClipboard(html);
          setStatus(t('sidepanel.wechatCopied'));
          setPhase('success');
          armIdleReset();
        } catch (e) {
          setStatus(e instanceof Error ? e.message : String(e));
          setPhase('error');
        }
        setRunning(null);
      }
    },
    [armIdleReset]
  );

  const handleAction = useCallback(
    (item: ActionItem) => {
      if (running) return;
      void runAction(item);
    },
    [running, runAction]
  );

  // 记住每个功能上次选的样式（纯 UI 偏好，localStorage 即可）
  const savedTheme = useCallback((item: ActionItem): string => {
    return (
      localStorage.getItem(`larksnap:style:${item.key}`) ?? item.themes?.[0]?.id ?? ''
    );
  }, []);

  const handleThemeClick = useCallback(
    (item: ActionItem, themeId: string) => {
      if (running) return;
      localStorage.setItem(`larksnap:style:${item.key}`, themeId);
      void runAction(item, themeId);
    },
    [running, runAction]
  );

  if (view === 'cache') {
    return <CacheView onBack={() => setView('home')} />;
  }

  if (view === 'xhsPreview' && xhsPreview) {
    return (
      <XhsPreview
        data={xhsPreview}
        onBack={() => {
          setView('home');
          setXhsPreview(null); // 释放几十 MB 的 dataURL
        }}
      />
    );
  }

  const kind = pageInfo?.kind ?? null;
  const needsAuth = !!doc?.isFeishuDoc && !!doc?.needsAuth;
  const notFeishu = doc != null && !doc.isFeishuDoc;
  // 普通网页未授权：不挡侧边栏功能（有手势兜底），只给桥接后台抓取一个授权入口
  const webNeedsAuth = notFeishu && !!doc?.needsAuth;

  return (
    <div className={`panel${view === 'chat' ? ' panel-chat' : ''}`}>
      <header className="panel-header">
        <div className="title-row">
          <h1>{t('sidepanel.title')}</h1>
          <HeaderStatus />
          <div className="hd-tabs">
            <button
              type="button"
              className={`hd-tab${view !== 'chat' ? ' active' : ''}`}
              onClick={() => switchView('home')}
            >
              {t('sidepanel.tabTools')}
            </button>
            <button
              type="button"
              className={`hd-tab${view === 'chat' ? ' active' : ''}`}
              onClick={() => switchView('chat')}
            >
              {t('sidepanel.tabChat')}
            </button>
          </div>
          <span className="title-spacer" />
          <button
            type="button"
            className="hd-icon-btn"
            title={t('sidepanel.headerSettings')}
            onClick={() => chrome.runtime.openOptionsPage()}
          >
            ⚙
          </button>
          <button
            type="button"
            className="hd-icon-btn"
            title={t('sidepanel.headerCache')}
            onClick={() => setView('cache')}
          >
            🗂
          </button>
          <button
            type="button"
            className="close-btn"
            title={t('sidepanel.closeTitle')}
            onClick={() => window.close()}
          >
            ✕
          </button>
        </div>
      </header>

      {/* 授权横幅只服务首页（工具）视图：给桥接后台抓取一个授权入口。
          对话页是纯聊天，用不到全文抓取，必须跟随标签页一起隐藏，否则会误导成「聊天也要授权」 */}
      {view !== 'chat' && needsAuth && (
        <div className="auth-banner">
          <p>{t('sidepanel.authBannerFeishu')}</p>
          <button className="auth-btn" onClick={handleAuthorize} disabled={authing}>
            {authing ? t('sidepanel.authorizing') : t('sidepanel.authorize')}
          </button>
        </div>
      )}
      {view !== 'chat' && webNeedsAuth && (
        <div className="auth-banner">
          <p>{t('sidepanel.authBannerWeb')}</p>
          <button className="auth-btn" onClick={handleAuthorize} disabled={authing}>
            {authing ? t('sidepanel.authorizing') : t('sidepanel.authorize')}
          </button>
        </div>
      )}

      <main
        className="home-main"
        style={view === 'chat' ? { display: 'none' } : undefined}
      >
        <ContextZone
          doc={doc}
          pageInfo={pageInfo}
          running={running}
          needsAuth={needsAuth}
          onAction={handleAction}
          onPickTheme={handleThemeClick}
          savedTheme={savedTheme}
        />
        {/* 视频下载卡 + 任务列表：视频站点显示卡片，有任务时列表任何非飞书页可见 */}
        {kind !== 'feishu' && <VideoSection />}
        <ToolGroups disabled={kind === 'restricted'} onOpenChat={() => switchView('chat')} />
      </main>

      {/* 对话页保持挂载只切显隐：卸载会断 Port，SW 会中止进行中的流式生成 */}
      <div className="chat-host" style={view === 'chat' ? undefined : { display: 'none' }}>
        <ChatView autoStart={chatIntent} />
      </div>

      <footer className="status-bar" style={view === 'chat' ? { display: 'none' } : undefined}>
        {taskErr && (
          <div className="task-error-line" title={taskErr.error}>
            {t('sidepanel.lastTaskFailed', { msg: taskErr.error ?? '' })}
          </div>
        )}
        {phase === 'running' && (
          <div className={`progress-track${percent == null ? ' indeterminate' : ''}`}>
            <div
              className="progress-fill"
              style={percent == null ? undefined : { width: `${percent}%` }}
            />
          </div>
        )}
        <div className={`status-text status-${phase}`}>
          <span className="status-msg">{status ?? t('sidepanel.idle')}</span>
          {phase === 'running' && percent != null && (
            <span className="status-pct">{percent}%</span>
          )}
        </div>
        <Footer />
      </footer>
    </div>
  );
}
