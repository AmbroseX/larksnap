import { useEffect, useState } from 'react';
import type { CachedDoc } from '../shared/types';
import { MSG } from '../shared/constants';
import { sendToBackground } from '../shared/messaging';
import { useI18n } from '../shared/i18n/useI18n';

interface Props {
  onBack: () => void;
}

export function CacheView({ onBack }: Props) {
  const { t, lang } = useI18n();
  const [docs, setDocs] = useState<CachedDoc[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const res = await sendToBackground<CachedDoc[]>(MSG.CACHE_LIST);
    setDocs(res.success && res.data ? res.data : []);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const handleDelete = async (token: string) => {
    await sendToBackground(MSG.CACHE_DELETE, { token });
    load();
  };

  const handleOpen = async (token: string) => {
    const res = await sendToBackground<{ html: string }>(MSG.CACHE_GET, { token });
    if (res.success && res.data?.html) {
      const url =
        'data:text/html;charset=utf-8,' + encodeURIComponent(res.data.html);
      chrome.tabs.create({ url });
    }
  };

  return (
    <div className="panel">
      <header className="panel-header">
        <div className="title-row">
          <button className="back-btn" onClick={onBack}>
            {t('cache.back')}
          </button>
          <h1>{t('cache.title')}</h1>
        </div>
      </header>

      <main className="action-list">
        {loading && <p className="empty-hint">{t('cache.loading')}</p>}
        {!loading && docs.length === 0 && (
          <p className="empty-hint">{t('cache.empty')}</p>
        )}
        {docs.map((doc) => (
          <div key={doc.token} className="cache-card">
            <div className="action-text">
              <span className="action-title">{doc.title}</span>
              <span className="action-subtitle">
                {doc.docType} ·{' '}
                {new Date(doc.cachedAt).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US')}
              </span>
            </div>
            <div className="cache-actions">
              <button
                className="open-btn"
                onClick={() => handleOpen(doc.token)}
              >
                {t('cache.open')}
              </button>
              <button
                className="delete-btn"
                onClick={() => handleDelete(doc.token)}
              >
                {t('cache.delete')}
              </button>
            </div>
          </div>
        ))}
      </main>
    </div>
  );
}
