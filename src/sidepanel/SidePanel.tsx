import { useEffect, useState, useCallback, useRef } from 'react';
import type { DocInfo, ExportProgress, RuntimeState } from '../shared/types';
import { MSG } from '../shared/constants';
import { sendToBackground, onBackgroundMessage } from '../shared/messaging';
import { getConfig } from '../shared/storage';
import { hostOf, permissionPattern } from '../shared/feishu-host';
import { ACTIONS, type ActionItem } from './actions';
import { CacheView } from './CacheView';
import { WebCopyView } from './WebCopyView';

type View = 'home' | 'cache';

const IDLE_TEXT = '准备就绪，等待操作...';

export function SidePanel() {
  const [view, setView] = useState<View>('home');
  const [status, setStatus] = useState(IDLE_TEXT);
  const [running, setRunning] = useState<string | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const [phase, setPhase] = useState<ExportProgress['status']>('idle');
  const [doc, setDoc] = useState<DocInfo | null>(null);
  const [authing, setAuthing] = useState(false);

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

      if (!item.msg) return;
      setRunning(item.key);
      setPhase('running');
      setPercent(null);
      setStatus(`「${item.title}」执行中...`);
      const res = await sendToBackground(item.msg);
      if (!res.success) {
        setStatus(res.error || '操作失败');
        setPhase('error');
        setRunning(null);
      }
    },
    [running]
  );

  if (view === 'cache') {
    return <CacheView onBack={() => setView('home')} />;
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
            <button
              key={item.key}
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
              <span className="action-arrow">›</span>
            </button>
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
