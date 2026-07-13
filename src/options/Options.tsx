import { useEffect, useState } from 'react';
import type { AiConfig, ExtensionConfig, VideoProxyConfig, WebCopyConfig } from '../shared/types';
import { DEFAULT_CONFIG, MSG } from '../shared/constants';
import { getConfig, saveConfig } from '../shared/storage';
import { sendToBackground } from '../shared/messaging';
import { useI18n } from '../shared/i18n/useI18n';

/** AI 总结的空白配置（未配置态；扩展不内置任何默认端点，FR-003） */
const EMPTY_AI: AiConfig = {
  baseUrl: '',
  apiKey: '',
  model: '',
  targetLang: '中文',
  acknowledged: false,
};

/** 取 URL 的 origin，非法返回空串 */
function originOf(url: string): string {
  try {
    return new URL(url.trim()).origin;
  } catch {
    return '';
  }
}

export function Options() {
  const { t } = useI18n();
  const [config, setConfig] = useState<ExtensionConfig>(DEFAULT_CONFIG);
  const [saved, setSaved] = useState(false);
  const [trusted, setTrusted] = useState<string[]>([]);
  // AI 总结配置单独一套状态：保存要走端点授权手势，与主表单分开保存
  const [ai, setAi] = useState<AiConfig>(EMPTY_AI);
  const [aiMsg, setAiMsg] = useState('');
  /** 上次保存的端点 origin：换端点时首次告知需重新确认 */
  const [savedAiOrigin, setSavedAiOrigin] = useState('');

  const refreshTrusted = () => {
    sendToBackground<string[]>(MSG.LIST_TRUSTED).then((res) => {
      if (res.success) setTrusted(res.data ?? []);
    });
  };

  useEffect(() => {
    getConfig().then((cfg) => {
      setConfig(cfg);
      if (cfg.ai) {
        setAi(cfg.ai);
        setSavedAiOrigin(originOf(cfg.ai.baseUrl));
      }
    });
    refreshTrusted();
  }, []);

  const handleRevoke = async (pattern: string) => {
    await sendToBackground(MSG.REVOKE_PERMISSION, { pattern });
    refreshTrusted();
  };

  const update = <K extends keyof ExtensionConfig>(key: K, value: ExtensionConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const updateWebcopy = <K extends keyof WebCopyConfig>(
    key: K,
    value: WebCopyConfig[K]
  ) => {
    setConfig((prev) => ({ ...prev, webcopy: { ...prev.webcopy, [key]: value } }));
    setSaved(false);
  };

  const updateVideoProxy = <K extends keyof VideoProxyConfig>(
    key: K,
    value: VideoProxyConfig[K]
  ) => {
    setConfig((prev) => ({ ...prev, videoProxy: { ...prev.videoProxy, [key]: value } }));
    setSaved(false);
  };

  const handleSave = async () => {
    // ai 由「AI 总结」区块单独保存（要走端点授权手势），这里剔除避免旧值覆盖
    const { ai: _ai, ...rest } = config;
    await saveConfig(rest);
    setSaved(true);
  };

  const updateAi = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => {
    setAi((prev) => ({ ...prev, [key]: value }));
    setAiMsg('');
  };

  /** 保存 AI 配置：在用户手势里对端点 origin 发起运行时授权，成功才落库（FR-005） */
  const handleSaveAi = async () => {
    const baseUrl = ai.baseUrl.trim();
    const origin = originOf(baseUrl);
    if (!origin) {
      setAiMsg(t('options.ai.invalidUrl'));
      return;
    }
    if (!ai.apiKey.trim() || !ai.model.trim()) {
      setAiMsg(t('options.ai.missingFields'));
      return;
    }
    const pattern = `${origin}/*`;
    const granted = await chrome.permissions
      .request({ origins: [pattern] })
      .catch(() => false);
    if (!granted) {
      setAiMsg(t('options.ai.notGranted'));
      return;
    }
    // 持久化到「已信任域名」列表（沿用 001 运行时授权模式）
    await sendToBackground(MSG.REQUEST_PERMISSION, { pattern });
    // 换了端点 → 「内容将发送到该端点」的首次告知需重新确认（FR-004）
    const acknowledged = origin === savedAiOrigin ? ai.acknowledged : false;
    const next: AiConfig = {
      baseUrl,
      apiKey: ai.apiKey.trim(),
      model: ai.model.trim(),
      targetLang: ai.targetLang.trim() || '中文',
      acknowledged,
    };
    await saveConfig({ ai: next });
    setAi(next);
    setSavedAiOrigin(origin);
    refreshTrusted();
    setAiMsg(t('options.ai.savedGranted'));
  };

  /** 清除 AI 配置（含 API Key），恢复未配置态 */
  const handleClearAi = async () => {
    await saveConfig({ ai: undefined });
    setAi(EMPTY_AI);
    setSavedAiOrigin('');
    setAiMsg(t('options.ai.cleared'));
  };

  return (
    <div className="options">
      <h1>{t('options.title')}</h1>

      {/* 语言选项文字固定中英并排，保证任何语言状态下都能认出来 */}
      <section className="field">
        <label>界面语言 / Language</label>
        <select
          value={config.language}
          onChange={(e) =>
            update('language', e.target.value as ExtensionConfig['language'])
          }
        >
          <option value="auto">跟随浏览器 / Auto</option>
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select>
      </section>

      <section className="field">
        <label>{t('options.imageMode.label')}</label>
        <select
          value={config.imageMode}
          onChange={(e) => update('imageMode', e.target.value as ExtensionConfig['imageMode'])}
        >
          <option value="download">{t('options.imageMode.download')}</option>
          <option value="link">{t('options.imageMode.link')}</option>
        </select>
      </section>

      {/* 快捷键说明（006）：chrome:// 地址不能用 <a> 打开，必须 tabs.create */}
      <section className="field">
        <label>{t('options.shortcuts.label')}</label>
        <p className="shortcuts-desc">{t('options.shortcuts.desc')}</p>
        <button
          type="button"
          className="shortcuts-open"
          onClick={() => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })}
        >
          {t('options.shortcuts.open')}
        </button>
      </section>

      <section className="field">
        <label>{t('options.feedbackUrl')}</label>
        <input
          type="text"
          value={config.feedbackUrl}
          onChange={(e) => update('feedbackUrl', e.target.value)}
        />
      </section>

      <section className="field checkbox">
        <label>
          <input
            type="checkbox"
            checked={config.diagnosticIncludeSnapshot}
            onChange={(e) => update('diagnosticIncludeSnapshot', e.target.checked)}
          />
          {t('options.diagnosticIncludeSnapshot')}
        </label>
      </section>

      <section className="field checkbox">
        <label>
          <input
            type="checkbox"
            checked={config.analyticsEnabled}
            onChange={(e) => update('analyticsEnabled', e.target.checked)}
          />
          {t('options.analytics')}
        </label>
      </section>

      <h2>{t('options.webcopyTitle')}</h2>

      <section className="field checkbox">
        <label>
          <input
            type="checkbox"
            checked={config.webcopy.autoCopyEnabled}
            onChange={(e) => updateWebcopy('autoCopyEnabled', e.target.checked)}
          />
          {t('options.autoCopyEnabled')}
        </label>
      </section>

      <section className="field">
        <label>{t('options.autoCopyMinChars')}</label>
        <input
          type="number"
          min={1}
          max={100}
          value={config.webcopy.autoCopyMinChars}
          onChange={(e) =>
            updateWebcopy(
              'autoCopyMinChars',
              Math.max(1, Number(e.target.value) || 5)
            )
          }
        />
      </section>

      <section className="field">
        <label>{t('options.autoCopyFormat.label')}</label>
        <select
          value={config.webcopy.autoCopyFormat}
          onChange={(e) =>
            updateWebcopy(
              'autoCopyFormat',
              e.target.value as WebCopyConfig['autoCopyFormat']
            )
          }
        >
          <option value="text">{t('options.autoCopyFormat.text')}</option>
          <option value="markdown">{t('options.autoCopyFormat.markdown')}</option>
        </select>
      </section>

      <section className="field checkbox">
        <label>
          <input
            type="checkbox"
            checked={config.webcopy.frontmatter}
            onChange={(e) => updateWebcopy('frontmatter', e.target.checked)}
          />
          {t('options.frontmatter')}
        </label>
      </section>

      <section className="field">
        <label>{t('options.pageImageMode.label')}</label>
        <select
          value={config.webcopy.pageImageMode}
          onChange={(e) =>
            updateWebcopy(
              'pageImageMode',
              e.target.value as WebCopyConfig['pageImageMode']
            )
          }
        >
          <option value="link">{t('options.pageImageMode.link')}</option>
          <option value="base64">{t('options.pageImageMode.base64')}</option>
        </select>
      </section>

      <section className="field">
        <label>{t('options.tabCopyFormat.label')}</label>
        <select
          value={config.webcopy.tabCopyFormat}
          onChange={(e) =>
            updateWebcopy(
              'tabCopyFormat',
              e.target.value as WebCopyConfig['tabCopyFormat']
            )
          }
        >
          <option value="markdown">{t('options.tabCopyFormat.markdown')}</option>
          <option value="title-url">{t('options.tabCopyFormat.titleUrl')}</option>
          <option value="title">{t('options.tabCopyFormat.title')}</option>
          <option value="url">{t('options.tabCopyFormat.url')}</option>
        </select>
      </section>

      <h2>{t('options.videoProxy.title')}</h2>
      <p className="trusted-empty">{t('options.videoProxy.intro')}</p>

      <section className="field">
        <label>{t('options.videoProxy.scheme')}</label>
        <select
          value={config.videoProxy.scheme}
          onChange={(e) =>
            updateVideoProxy('scheme', e.target.value as VideoProxyConfig['scheme'])
          }
        >
          <option value="http">HTTP</option>
          <option value="https">HTTPS</option>
          <option value="socks5">SOCKS5</option>
        </select>
      </section>

      <section className="field">
        <label>{t('options.videoProxy.host')}</label>
        <input
          type="text"
          value={config.videoProxy.host}
          placeholder={t('options.videoProxy.hostPlaceholder')}
          onChange={(e) => updateVideoProxy('host', e.target.value)}
        />
      </section>

      <section className="field">
        <label>{t('options.videoProxy.port')}</label>
        <input
          type="text"
          value={config.videoProxy.port}
          placeholder={t('options.videoProxy.portPlaceholder')}
          onChange={(e) => updateVideoProxy('port', e.target.value.replace(/[^\d]/g, ''))}
        />
      </section>

      <section className="field">
        <label>{t('options.videoProxy.bypass')}</label>
        <textarea
          rows={5}
          value={config.videoProxy.bypass}
          placeholder={t('options.videoProxy.bypassPlaceholder')}
          onChange={(e) => updateVideoProxy('bypass', e.target.value)}
        />
      </section>

      <section className="field">
        <label>{t('options.videoProxy.proxyOnly')}</label>
        <textarea
          rows={5}
          value={config.videoProxy.proxyOnly}
          placeholder={t('options.videoProxy.proxyOnlyPlaceholder')}
          onChange={(e) => updateVideoProxy('proxyOnly', e.target.value)}
        />
      </section>

      <button className="save-btn" onClick={handleSave}>
        {t('common.save')}
      </button>
      {saved && <span className="saved-hint">{t('common.saved')}</span>}

      <h2>{t('options.ai.title')}</h2>
      <p className="trusted-empty">{t('options.ai.intro')}</p>

      <section className="field">
        <label>{t('options.ai.baseUrl')}</label>
        <input
          type="text"
          placeholder="https://..."
          value={ai.baseUrl}
          onChange={(e) => updateAi('baseUrl', e.target.value)}
        />
      </section>

      <section className="field">
        <label>{t('options.ai.apiKey')}</label>
        <input
          type="password"
          value={ai.apiKey}
          onChange={(e) => updateAi('apiKey', e.target.value)}
        />
      </section>

      <section className="field">
        <label>{t('options.ai.model')}</label>
        <input
          type="text"
          placeholder={t('options.ai.modelPlaceholder')}
          value={ai.model}
          onChange={(e) => updateAi('model', e.target.value)}
        />
      </section>

      <section className="field">
        <label>{t('options.ai.targetLang')}</label>
        <input
          type="text"
          value={ai.targetLang}
          onChange={(e) => updateAi('targetLang', e.target.value)}
        />
      </section>

      <button className="save-btn" onClick={handleSaveAi}>
        {t('options.ai.save')}
      </button>
      {(ai.baseUrl || savedAiOrigin) && (
        <button className="revoke-btn" onClick={handleClearAi}>
          {t('options.ai.clear')}
        </button>
      )}
      {aiMsg && <span className="saved-hint">{aiMsg}</span>}

      <section className="field">
        <label>{t('options.trustedDomains.label')}</label>
        {trusted.length === 0 ? (
          <p className="trusted-empty">{t('options.trustedDomains.empty')}</p>
        ) : (
          <ul className="trusted-list">
            {trusted.map((origin) => (
              <li key={origin}>
                <span className="trusted-origin">{origin}</span>
                <button
                  className="revoke-btn"
                  onClick={() => handleRevoke(origin)}
                >
                  {t('common.revoke')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
