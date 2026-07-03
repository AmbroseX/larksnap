/**
 * Popup —— 展示桥接（CC ⇄ daemon）连接状态：扩展版本、连接态、daemon 版本、profile code。
 * 仿 OpenCLI popup。点击图标弹出本窗口（manifest default_popup）；侧边栏从底部按钮打开。
 */
import { useEffect, useState } from 'react';
import { ISSUES_URL, MSG, REPO_URL } from '../shared/constants';
import { sendToBackground } from '../shared/messaging';

interface BridgeStatus {
  connected: boolean;
  reconnecting: boolean;
  daemonVersion: string | null;
  contextId: string;
  extensionVersion: string;
}

type Phase = 'loading' | 'connected' | 'connecting' | 'disconnected';

export function Popup() {
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
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
    loading: 'Checking…',
    connected: 'Connected to daemon',
    connecting: 'Reconnecting…',
    disconnected: 'No daemon connected',
  }[phase];

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
        <h1>飞书文档导出助手</h1>
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
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        )}

        {phase !== 'connected' && (
          <div className="hint">
            在 CC 里运行 <code>/larksnap-fetch</code> 命令会自动拉起 daemon；扩展随后自动连上。点一下图标可立即唤醒后台。
          </div>
        )}
      </div>

      <footer className="ft">
        <button type="button" className="panel-btn" onClick={openSidePanel}>
          打开侧边栏
        </button>
        <span className="links">
          <a className="doc-link" href={REPO_URL} target="_blank" rel="noreferrer">
            开源项目
          </a>
          <span className="link-sep">·</span>
          <a className="doc-link" href={ISSUES_URL} target="_blank" rel="noreferrer">
            反馈问题
          </a>
        </span>
      </footer>
    </div>
  );
}
