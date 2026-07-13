import { useEffect, useState, useCallback, useRef } from 'react';
import type {
  DocInfo,
  ExportProgress,
  PageKindInfo,
  RuntimeState,
} from '../shared/types';
import { MSG } from '../shared/constants';
import { sendToBackground, onBackgroundMessage } from '../shared/messaging';
import { getConfig } from '../shared/storage';
import { hostOf, permissionPattern } from '../shared/feishu-host';
import { getWechatTheme } from '../shared/themes';
import { useI18n } from '../shared/i18n/useI18n';
import { t } from '../shared/i18n';
import { ACTIONS, type ActionItem } from './actions';
import { copyHtmlToClipboard } from './copy-html';
import { XhsPreview, type XhsPreviewData } from './XhsPreview';

/** 公众号样式的悬浮预览：用主题真实配色渲染一小段标题/正文/引用示例 */
function WechatThemePreview({ themeId }: { themeId: string }) {
  const theme = getWechatTheme(themeId);
  return (
    <div className="wtp">
      <div
        className="wtp-heading"
        style={{
          color: theme.headingColor,
          ...(theme.accentBar
            ? { borderLeft: `3px solid ${theme.accentBar}`, paddingLeft: 8 }
            : {}),
        }}
      >
        {t('sidepanel.themePreview.heading')}
      </div>
      <p className="wtp-body">{t('sidepanel.themePreview.body')}</p>
      <div className="wtp-quote" style={{ borderLeft: `3px solid ${theme.quoteBorder}` }}>
        {t('sidepanel.themePreview.quote')}
      </div>
    </div>
  );
}
import { CacheView } from './CacheView';
import { WebCopyView } from './WebCopyView';
import { TranscriptCard } from './TranscriptCard';
import { SummaryView } from './SummaryView';

type View = 'home' | 'cache' | 'xhsPreview';

export function SidePanel() {
  const { t } = useI18n();
  const [view, setView] = useState<View>('home');
  /** null = 空闲态，渲染时取当前语言的「准备就绪」文案（切语言即跟随） */
  const [status, setStatus] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const [phase, setPhase] = useState<ExportProgress['status']>('idle');
  const [doc, setDoc] = useState<DocInfo | null>(null);
  /** 页面三态（004）：youtube 出字幕+总结入口，generic 出总结入口，feishu 现状不动 */
  const [pageKind, setPageKind] = useState<PageKindInfo['kind'] | null>(null);
  const [authing, setAuthing] = useState(false);
  /** 当前展开样式选择器的 action key */
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  /** 小红书卡片预览数据（出图后先预览，确认再下载） */
  const [xhsPreview, setXhsPreview] = useState<XhsPreviewData | null>(null);
  /** 悬浮中的公众号样式 id（展示排版预览） */
  const [hoverWechatTheme, setHoverWechatTheme] = useState<string | null>(null);

  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshDoc = useCallback(async () => {
    const res = await sendToBackground<DocInfo>(MSG.GET_DOC_INFO);
    if (res.success) setDoc(res.data ?? null);
    const kind = await sendToBackground<PageKindInfo>(MSG.GET_PAGE_KIND);
    if (kind.success) setPageKind(kind.data?.kind ?? null);
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
      const granted = await chrome.permissions.request({ origins: [pattern] });
      if (granted) {
        await sendToBackground(MSG.REQUEST_PERMISSION, { pattern });
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

  const handleClick = useCallback(
    async (item: ActionItem) => {
      if (item.disabled || running) return;

      // 前端动作
      if (item.clientAction === 'cacheList') {
        setView('cache');
        return;
      }
      if (item.clientAction === 'feedback') {
        const config = await getConfig();
        chrome.tabs.create({ url: config.feedbackUrl });
        return;
      }

      // 有样式可选：先展开/收起选择器，点具体样式才执行
      if (item.themes?.length) {
        setPickerFor((cur) => (cur === item.key ? null : item.key));
        return;
      }

      await runAction(item);
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
      setPickerFor(null);
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

  const needsAuth = !!doc?.isFeishuDoc && !!doc?.needsAuth;
  const notFeishu = doc != null && !doc.isFeishuDoc;
  // 普通网页未授权：不挡侧边栏功能（有手势兜底），只给桥接后台抓取一个授权入口
  const webNeedsAuth = notFeishu && !!doc?.needsAuth;

  return (
    <div className="panel">
      <header className="panel-header">
        <div className="title-row">
          <h1>{t('sidepanel.title')}</h1>
          <span className="badge badge-free">{t('sidepanel.badgeFree')}</span>
          <button
            type="button"
            className="close-btn"
            title={t('sidepanel.closeTitle')}
            onClick={() => window.close()}
          >
            ✕
          </button>
        </div>
        <p className="subtitle">
          {doc?.isFeishuDoc
            ? `${doc.docType}${doc.isPrivateDeploy ? t('sidepanel.privateSuffix') : ''}`
            : t('sidepanel.subtitleWeb')}
        </p>
        <div className="quota-chip">
          <span className="quota-label">{t('sidepanel.quotaLabel')}</span>
          <span>{t('sidepanel.quotaValue')}</span>
        </div>
      </header>

      {needsAuth && (
        <div className="auth-banner">
          <p>{t('sidepanel.authBannerFeishu')}</p>
          <button
            className="auth-btn"
            onClick={handleAuthorize}
            disabled={authing}
          >
            {authing ? t('sidepanel.authorizing') : t('sidepanel.authorize')}
          </button>
        </div>
      )}

      {/* 非飞书页面：网页复制区块为主入口；飞书页面：导出区块（现状） */}
      {notFeishu ? (
        <>
          {webNeedsAuth && (
            <div className="auth-banner">
              <p>{t('sidepanel.authBannerWeb')}</p>
              <button
                className="auth-btn"
                onClick={handleAuthorize}
                disabled={authing}
              >
                {authing ? t('sidepanel.authorizing') : t('sidepanel.authorize')}
              </button>
            </div>
          )}
          {/* 004 三态入口：YouTube 视频页出字幕卡片，YouTube/普通页出 AI 总结卡片 */}
          {pageKind === 'youtube' && <TranscriptCard />}
          {(pageKind === 'youtube' || pageKind === 'generic') && <SummaryView />}
          {pageKind === 'restricted' && (
            <div className="wc-card">
              <div className="wc-row-sub">{t('sidepanel.restrictedPage')}</div>
            </div>
          )}
          <WebCopyView />
        </>
      ) : (
        <main className="action-list">
          {ACTIONS.map((item) => (
            <div key={item.key} className="action-group">
              <button
                className={`action-card${item.disabled ? ' disabled' : ''}${
                  running === item.key ? ' running' : ''
                }`}
                onClick={() => handleClick(item)}
                disabled={item.disabled || !!running || needsAuth}
              >
                <div className="action-text">
                  <span className="action-title">{t(item.title)}</span>
                  <span className="action-subtitle">{t(item.subtitle)}</span>
                </div>
                <span className="action-arrow">
                  {item.themes ? (pickerFor === item.key ? '⌄' : '›') : '›'}
                </span>
              </button>
              {item.themes && pickerFor === item.key && (
                <>
                  <div
                    className="theme-picker"
                    onMouseLeave={() => setHoverWechatTheme(null)}
                  >
                    {item.themes.map((th) => (
                      <button
                        key={th.id}
                        className={`theme-chip${savedTheme(item) === th.id ? ' selected' : ''}`}
                        disabled={!!running}
                        onClick={() => handleThemeClick(item, th.id)}
                        onMouseEnter={() =>
                          item.key === 'wechat' && setHoverWechatTheme(th.id)
                        }
                      >
                        <span className="theme-swatch" style={{ background: th.swatch }} />
                        {t(th.name)}
                      </button>
                    ))}
                  </div>
                  {item.key === 'wechat' && hoverWechatTheme && (
                    <WechatThemePreview themeId={hoverWechatTheme} />
                  )}
                </>
              )}
            </div>
          ))}
        </main>
      )}

      <footer className="status-bar">
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
      </footer>
    </div>
  );
}
