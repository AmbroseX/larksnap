import { useEffect, useRef, useState } from 'react';
import { MSG } from '../shared/constants';
import { sendToBackground } from '../shared/messaging';
import { useI18n } from '../shared/i18n/useI18n';

/**
 * header 的桥接状态点（006 阶段1c，等价替代原 popup 全部信息）：
 *   圆点三色：绿=已连接 daemon / 黄=连接中 / 灰=未连接；
 *   点击展开详情行：daemon 版本、可复制的 contextId、协议不一致提示、未连接引导。
 */

interface BridgeStatus {
  connected: boolean;
  reconnecting: boolean;
  daemonVersion: string | null;
  protocolMismatch: boolean;
  contextId: string;
  extensionVersion: string;
}

type Phase = 'loading' | 'connected' | 'connecting' | 'disconnected';

export function HeaderStatus() {
  const { t } = useI18n();
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 点浮层外部即收起
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const res = await sendToBackground<BridgeStatus>(MSG.GET_BRIDGE_STATUS);
      if (alive && res.success && res.data) setStatus(res.data);
    };
    void poll();
    const timer = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
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

  const extVersion = status?.extensionVersion ?? chrome.runtime.getManifest().version;

  return (
    <div className="hs" ref={rootRef}>
      <button
        type="button"
        className="hs-dot-btn"
        title={statusText}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`hs-dot ${phase}`} />
      </button>

      {open && (
        <div className="hs-detail">
          <div className="hs-row">
            <span className={`hs-dot ${phase}`} />
            <span className="hs-status-text">{statusText}</span>
          </div>

          <div className="hs-row">
            <span className="hs-ver-chip">LarkSnap v{extVersion}</span>
            <span className="hs-ver-chip">
              daemon {status?.daemonVersion ? `v${status.daemonVersion}` : '—'}
            </span>
          </div>

          {status?.contextId && (
            <div className="hs-row">
              <span className="hs-label">Profile</span>
              <span className="hs-profile-id">{status.contextId}</span>
              <button
                type="button"
                className={`hs-copy-btn${copied ? ' copied' : ''}`}
                onClick={() => void copy()}
              >
                {copied ? t('common.copied') : t('common.copy')}
              </button>
            </div>
          )}

          {phase === 'connected' && status?.protocolMismatch && (
            <div className="hs-hint">{t('popup.protocolMismatch')}</div>
          )}

          {phase !== 'connected' && (
            <div className="hs-hint">
              {hintPre}
              <code>/larksnap-fetch</code>
              {hintPost}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
