/**
 * Popup —— 展示桥接（CC ⇄ daemon）连接状态：扩展版本、连接态、daemon 版本、profile code。
 * 仿 OpenCLI popup。点击图标弹出本窗口（manifest default_popup）；侧边栏从底部按钮打开。
 */
import { useEffect, useState } from 'react';
import { ISSUES_URL, MSG, REPO_URL } from '../shared/constants';
import { sendToBackground } from '../shared/messaging';
import { useI18n } from '../shared/i18n/useI18n';

interface BridgeStatus {
  connected: boolean;
  reconnecting: boolean;
  daemonVersion: string | null;
  protocolMismatch: boolean;
  contextId: string;
  extensionVersion: string;
}

type Phase = 'loading' | 'connected' | 'connecting' | 'disconnected';

export function Popup() {
  const { t } = useI18n();
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // 匿名统计：popup 打开即当日活跃（可在设置页关闭）
    void sendToBackground(MSG.TRACK, { name: 'open', url: '/open/popup', data: { ui: 'popup' } });
    let alive = true;
    const poll = async () => {
      const res = await sendToBackground<BridgeStatus>(MSG.GET_BRIDGE_STATUS);
      if (alive && res.success && res.data) setStatus(res.data);
    };
    void poll();
    const t = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const phase: Phase = !status
    ? 'loading'
    : status.connected
      ? 'connected'
      : status.reconnecting
        ? 'connecting'
        : 'disconnected';

  const statusText = {
    loading: t('popup.status.loading'),
    connected: t('popup.status.connected'),
    connecting: t('popup.status.connecting'),
    disconnected: t('popup.status.disconnected'),
  }[phase];

  // 提示语里的 {cmd} 占位符切开渲染，保留 <code> 样式
  const [hintPre, hintPost] = t('popup.connectHint').split('{cmd}');

  const copy = async () => {
    if (!status?.contextId) return;
    try {
      await navigator.clipboard.writeText(status.contextId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };

  // popup 内的点击是用户手势，可以直接开侧边栏；开完关掉自己
  const openSidePanel = async () => {
    try {
      const win = await chrome.windows.getCurrent();
      if (win.id == null) return;
      await chrome.sidePanel.open({ windowId: win.id });
      window.close();
    } catch (e) {
      console.warn('[larksnap] 打开侧边栏失败:', e);
    }
  };

  return (
    <div className="popup">
      <header className="hd">
        <img className="logo" src="icons/icon-32.png" alt="" />
        <h1>{t('popup.title')}</h1>
        {status && <span className="ver">v{status.extensionVersion}</span>}
      </header>

      <div className={`card ${phase}`}>
        <div className="status-row">
          <span className={`dot ${phase}`} />
          <span className="status-text">{statusText}</span>
          {phase === 'connected' && status?.daemonVersion && (
            <span className="daemon-ver">daemon v{status.daemonVersion}</span>
          )}
        </div>

        {status?.contextId && (
          <div className="profile-row">
            <span className="profile-label">Profile</span>
            <span className="profile-id">{status.contextId}</span>
            <button type="button" className={`copy-btn ${copied ? 'copied' : ''}`} onClick={copy}>
              {copied ? t('common.copied') : t('common.copy')}
            </button>
          </div>
        )}

        {phase === 'connected' && status?.protocolMismatch && (
          <div className="hint">{t('popup.protocolMismatch')}</div>
        )}

        {phase !== 'connected' && (
          <div className="hint">
            {hintPre}
            <code>/larksnap-fetch</code>
            {hintPost}
          </div>
        )}
      </div>

      <footer className="ft">
        <button type="button" className="panel-btn" onClick={openSidePanel}>
          {t('popup.openSidePanel')}
        </button>
        <span className="links">
          <a className="doc-link" href={REPO_URL} target="_blank" rel="noreferrer">
            {t('popup.repo')}
          </a>
          <span className="link-sep">·</span>
          <a className="doc-link" href={ISSUES_URL} target="_blank" rel="noreferrer">
            {t('popup.feedback')}
          </a>
        </span>
      </footer>
    </div>
  );
}
