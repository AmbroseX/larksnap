import { useEffect, useState } from 'react';
import type {
  ExportProgress,
  SummaryNeedsAck,
  SummaryResult,
} from '../shared/types';
import { MSG } from '../shared/constants';
import { onBackgroundMessage } from '../shared/messaging';
import { getConfig, saveConfig } from '../shared/storage';
import { callWithPermission, copyToClipboard } from './permission-call';
import { t } from '../shared/i18n';
import { useI18n } from '../shared/i18n/useI18n';

/**
 * 「AI 总结」卡片（US2/US3）：
 *   - 未配置端点 → 引导态，点击跳设置页，不发任何请求（FR-003）
 *   - 首次使用 → 一次性告知框（含端点域名），确认写回 acknowledged 后重发（FR-004）
 *   - 进行中 → 块进度（第 i/n 块，PROGRESS 推送）
 *   - 结果 → Markdown 展示 + 复制；partial 结果已在正文里标注不完整
 */
export function SummaryView() {
  useI18n(); // 订阅语言切换，切换时整块重渲染
  /** null=配置读取中；false=未配置（引导态）；true=已配置 */
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const [result, setResult] = useState<SummaryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 待确认的一次性告知（端点域名） */
  const [ackOrigin, setAckOrigin] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refreshConfigured = () =>
    getConfig().then((cfg) =>
      setConfigured(!!(cfg.ai?.baseUrl && cfg.ai.apiKey && cfg.ai.model))
    );

  useEffect(() => {
    void refreshConfigured();
    // 订阅 summarize 的块进度推送
    return onBackgroundMessage((msg) => {
      if (msg.type !== MSG.PROGRESS) return;
      const p = msg.data as ExportProgress | undefined;
      if (!p || p.action !== 'summarize') return;
      if (p.status === 'running') {
        setProgress(p.message);
        setPercent(p.percent ?? null);
      }
    });
  }, []);

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setCopied(false);
    setProgress(t('summary.preparing'));
    setPercent(null);
    try {
      const res = await callWithPermission<SummaryResult | SummaryNeedsAck>(
        MSG.SUMMARIZE_PAGE
      );
      if (!res.success) {
        setError(res.error || t('summary.failed'));
        return;
      }
      const data = res.data;
      if (data && 'needsAck' in data && data.needsAck) {
        // 首次使用：弹一次性告知，确认后重发
        setAckOrigin(data.endpointOrigin);
        return;
      }
      setResult((data as SummaryResult) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  /** 用户确认告知：持久化 acknowledged 后立即重发（FR-004） */
  const confirmAck = async () => {
    const cfg = await getConfig();
    if (cfg.ai) {
      await saveConfig({ ai: { ...cfg.ai, acknowledged: true } });
    }
    setAckOrigin(null);
    await start();
  };

  const handleCopy = async () => {
    if (!result) return;
    const ok = await copyToClipboard(result.markdown);
    setCopied(ok);
    if (!ok) setError(t('summary.clipboardFailed'));
  };

  // 未配置端点：引导态，不发任何请求
  if (configured === false) {
    return (
      <div className="wc-card">
        <div className="wc-card-title">{t('summary.title')}</div>
        <div className="wc-row-sub">{t('summary.notConfigured')}</div>
        <div className="wc-btn-row">
          <button
            className="wc-btn primary"
            onClick={() => {
              chrome.runtime.openOptionsPage();
              // 用户从设置页回来后点卡片外任意操作会刷新；这里定时兜底刷新一次
              setTimeout(() => void refreshConfigured(), 3000);
            }}
          >
            {t('summary.goConfig')}
          </button>
        </div>
      </div>
    );
  }

  // 告知文案里的 {origin} 占位符切开渲染，端点域名加粗
  const [ackPre, ackPost] = t('summary.ackIntro').split('{origin}');

  return (
    <div className="wc-card">
      <div className="wc-card-title">{t('summary.title')}</div>

      {ackOrigin ? (
        <>
          <div className="wc-row-sub">
            {ackPre}
            <strong>{ackOrigin}</strong>
            {ackPost}
          </div>
          <div className="wc-btn-row">
            <button className="wc-btn primary" onClick={() => void confirmAck()}>
              {t('summary.confirm')}
            </button>
            <button className="wc-btn" onClick={() => setAckOrigin(null)}>
              {t('common.cancel')}
            </button>
          </div>
        </>
      ) : (
        <div className="wc-btn-row">
          <button
            className="wc-btn primary"
            disabled={busy || configured == null}
            onClick={() => void start()}
          >
            {busy ? t('summary.busy') : t('summary.start')}
          </button>
          {result && (
            <button className="wc-btn" onClick={() => void handleCopy()}>
              {copied ? t('summary.copied') : t('summary.copyMd')}
            </button>
          )}
        </div>
      )}

      {busy && progress && (
        <div className="wc-row-sub">
          {progress}
          {percent != null ? `（${percent}%）` : ''}
        </div>
      )}

      {error && <div className="wc-status wc-status-error">{error}</div>}

      {result && (
        <>
          {result.partial && (
            <div className="wc-status wc-status-error">{t('summary.partial')}</div>
          )}
          <textarea
            className="wc-preview"
            readOnly
            value={result.markdown}
            onFocus={(e) => e.currentTarget.select()}
          />
        </>
      )}
    </div>
  );
}
