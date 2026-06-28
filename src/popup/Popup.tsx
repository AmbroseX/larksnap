/**
 * Popup —— 展示桥接（CC ⇄ daemon）连接状态：扩展版本、连接态、daemon 版本、profile code。
 * 仿 OpenCLI popup。点击图标默认打开侧边栏（见 background）；此弹窗用于看状态/复制 profile。
 */
import { useEffect, useState } from 'react';
import { MSG } from '../shared/constants';
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

  return (
    <div className="popup">
      <header className="hd">
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
            在 CC 里运行 <code>feishu-fetch</code> 命令会自动拉起 daemon；扩展随后自动连上。点一下图标可立即唤醒后台。
          </div>
        )}
      </div>
    </div>
  );
}
