import { useCallback, useEffect, useState } from 'react';
import type { CaptionTrackInfo } from '../shared/types';
import { MSG } from '../shared/constants';
import { callWithPermission, copyToClipboard } from './permission-call';
import { t } from '../shared/i18n';
import { useI18n } from '../shared/i18n/useI18n';

/**
 * YouTube「导出字幕」卡片（US1，纯本地）：
 * 语言轨选择（复用 theme-picker 交互样式）+ 下载 .md / 复制两种出口。
 * 剪贴板由侧边栏写（手势在这边），下载由 SW 经 chrome.downloads 落盘。
 */
export function TranscriptCard() {
  useI18n(); // 订阅语言切换，切换时整块重渲染
  const [tracks, setTracks] = useState<CaptionTrackInfo[] | null>(null);
  /** 选中的字幕语言码；空串 = 自动（默认中文优先，三级兜底） */
  const [lang, setLang] = useState('');
  const [busy, setBusy] = useState(false);
  /** null = 空闲态，渲染时取当前语言的默认提示 */
  const [msg, setMsg] = useState<string | null>(null);
  const [msgKind, setMsgKind] = useState<'idle' | 'success' | 'error'>('idle');
  /** 剪贴板写入失败时的手动复制预览 */
  const [preview, setPreview] = useState<string | null>(null);

  const loadTracks = useCallback(async () => {
    // 列轨失败不挡导出（导出自己还会再抓一次），只影响语言选择器
    const res = await callWithPermission<CaptionTrackInfo[]>(MSG.LIST_CAPTION_TRACKS);
    setTracks(res.success && res.data ? res.data : []);
  }, []);

  useEffect(() => {
    void loadTracks();
  }, [loadTracks]);

  const run = async (mode: 'download' | 'copy') => {
    if (busy) return;
    setBusy(true);
    setMsgKind('idle');
    setPreview(null);
    setMsg(t('transcript.fetching'));
    try {
      const res = await callWithPermission<{
        markdown: string;
        title: string;
        degraded: boolean;
      }>(MSG.EXPORT_TRANSCRIPT, { lang: lang || undefined, mode });
      if (!res.success || !res.data) {
        setMsg(res.error || t('transcript.exportFailed'));
        setMsgKind('error');
        return;
      }
      const { markdown, degraded } = res.data;
      if (mode === 'copy') {
        const ok = await copyToClipboard(markdown);
        if (!ok) {
          setPreview(markdown);
          setMsg(t('transcript.clipboardFailed'));
          setMsgKind('error');
          return;
        }
      }
      setMsg(
        degraded
          ? t('transcript.degraded')
          : mode === 'copy'
            ? t('transcript.copiedOk')
            : t('transcript.savedOk')
      );
      setMsgKind('success');
      // 之前没拿到轨列表的话（如刚授权成功），补一次
      if (!tracks?.length) void loadTracks();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wc-card">
      <div className="wc-card-title">{t('transcript.title')}</div>
      {tracks && tracks.length > 0 && (
        <div className="theme-picker">
          {[{ languageCode: '', name: t('transcript.auto') } as CaptionTrackInfo, ...tracks].map(
            (t) => (
              <button
                key={t.languageCode || '__auto__'}
                className={`theme-chip${lang === t.languageCode ? ' selected' : ''}`}
                disabled={busy}
                onClick={() => setLang(t.languageCode)}
              >
                {t.name || t.languageCode}
              </button>
            )
          )}
        </div>
      )}
      <div className="wc-btn-row">
        <button
          className="wc-btn primary"
          disabled={busy}
          onClick={() => run('download')}
        >
          {busy ? t('transcript.busy') : t('transcript.downloadMd')}
        </button>
        <button className="wc-btn" disabled={busy} onClick={() => run('copy')}>
          {t('common.copy')}
        </button>
      </div>
      <div className={`wc-status wc-status-${msgKind}`}>
        {msg ?? t('transcript.idleHint')}
      </div>
      {preview != null && (
        <textarea
          className="wc-preview"
          readOnly
          value={preview}
          onFocus={(e) => e.currentTarget.select()}
        />
      )}
    </div>
  );
}
