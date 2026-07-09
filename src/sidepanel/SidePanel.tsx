import { useEffect, useState, useCallback, useRef } from 'react';
import type { DocInfo, ExportProgress, RuntimeState } from '../shared/types';
import { MSG } from '../shared/constants';
import { sendToBackground, onBackgroundMessage } from '../shared/messaging';
import { getConfig } from '../shared/storage';
import { hostOf, permissionPattern } from '../shared/feishu-host';
import { getWechatTheme } from '../shared/themes';
import { ACTIONS, type ActionItem } from './actions';
import { copyHtmlToClipboard } from './copy-html';
import { XhsPreview, type XhsPreviewData } from './XhsPreview';

/** 公众号样式的悬浮预览：用主题真实配色渲染一小段标题/正文/引用示例 */
function WechatThemePreview({ themeId }: { themeId: string }) {
  const t = getWechatTheme(themeId);
  return (
    <div className="wtp">
      <div
        className="wtp-heading"
        style={{
          color: t.headingColor,
          ...(t.accentBar
            ? { borderLeft: `3px solid ${t.accentBar}`, paddingLeft: 8 }
            : {}),
        }}
      >
        标题示例
      </div>
      <p className="wtp-body">正文示例：粘贴到公众号编辑器后保持这套排版。</p>
      <div className="wtp-quote" style={{ borderLeft: `3px solid ${t.quoteBorder}` }}>
        引用块示例
      </div>
    </div>
  );
}
import { CacheView } from './CacheView';
import { WebCopyView } from './WebCopyView';

type View = 'home' | 'cache' | 'xhsPreview';

const IDLE_TEXT = '准备就绪，等待操作...';

export function SidePanel() {
  const [view, setView] = useState<View>('home');
  const [status, setStatus] = useState(IDLE_TEXT);
  const [running, setRunning] = useState<string | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const [phase, setPhase] = useState<ExportProgress['status']>('idle');
  const [doc, setDoc] = useState<DocInfo | null>(null);
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
  }, []);

  // 成功提示挂几秒就够了，自动回到"准备就绪"；出错的提示保留给用户看
  const armIdleReset = useCallback(() => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => {
      resetTimer.current = null;
      setStatus(IDLE_TEXT);
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
    return () => {
      off();
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
        setStatus(doc.isFeishuDoc ? '已授权，可开始导出' : '已授权，可通过命令行后台抓取本页');
      } else {
        setStatus('未授权，无法访问该域名');
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
      setStatus(`「${item.title}」执行中...`);
      const res = await sendToBackground(item.msg, themeId ? { themeId } : undefined);
      if (!res.success) {
        setStatus(res.error || '操作失败');
        setPhase('error');
        setRunning(null);
        return;
      }

      // 小红书卡片：SW 只出图，先进预览页过目，确认后再打包下载
      if (item.key === 'xhs') {
        const d = res.data as { title?: string; pngs?: string[] } | undefined;
        if (d?.pngs?.length) {
          setXhsPreview({
            title: d.title || '飞书文档',
            pngs: d.pngs,
            themeName: item.themes?.find((t) => t.id === themeId)?.name,
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
          setStatus('已复制公众号格式，去公众号编辑器粘贴即可');
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
          <h1>飞书文档导出助手</h1>
          <span className="badge badge-free">限时免费</span>
          <button
            type="button"
            className="close-btn"
            title="关闭侧边栏"
            onClick={() => window.close()}
          >
            ✕
          </button>
        </div>
        <p className="subtitle">
          {doc?.isFeishuDoc
            ? `${doc.docType}${doc.isPrivateDeploy ? ' · 私有化' : ''}`
            : '网页复制 · 任意网页转 Markdown'}
        </p>
        <div className="quota-chip">
          <span className="quota-label">额度</span>
          <span>限时免费开放</span>
        </div>
      </header>

      {needsAuth && (
        <div className="auth-banner">
          <p>检测到私有化飞书部署，需授权访问该域名后才能导出。</p>
          <button
            className="auth-btn"
            onClick={handleAuthorize}
            disabled={authing}
          >
            {authing ? '授权中...' : '授权访问该域名'}
          </button>
        </div>
      )}

      {/* 非飞书页面：网页复制区块为主入口；飞书页面：导出区块（现状） */}
      {notFeishu ? (
        <>
          {webNeedsAuth && (
            <div className="auth-banner">
              <p>通过命令行（larksnap-fetch）后台抓取本网页，需先授权访问该域名。</p>
              <button
                className="auth-btn"
                onClick={handleAuthorize}
                disabled={authing}
              >
                {authing ? '授权中...' : '授权访问该域名'}
              </button>
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
                  <span className="action-title">{item.title}</span>
                  <span className="action-subtitle">{item.subtitle}</span>
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
                    {item.themes.map((t) => (
                      <button
                        key={t.id}
                        className={`theme-chip${savedTheme(item) === t.id ? ' selected' : ''}`}
                        disabled={!!running}
                        onClick={() => handleThemeClick(item, t.id)}
                        onMouseEnter={() =>
                          item.key === 'wechat' && setHoverWechatTheme(t.id)
                        }
                      >
                        <span className="theme-swatch" style={{ background: t.swatch }} />
                        {t.name}
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
          <span className="status-msg">{status}</span>
          {phase === 'running' && percent != null && (
            <span className="status-pct">{percent}%</span>
          )}
        </div>
      </footer>
    </div>
  );
}
