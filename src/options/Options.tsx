import { useEffect, useState } from 'react';
import type { ExtensionConfig, WebCopyConfig } from '../shared/types';
import { DEFAULT_CONFIG, MSG } from '../shared/constants';
import { getConfig, saveConfig } from '../shared/storage';
import { sendToBackground } from '../shared/messaging';

export function Options() {
  const [config, setConfig] = useState<ExtensionConfig>(DEFAULT_CONFIG);
  const [saved, setSaved] = useState(false);
  const [trusted, setTrusted] = useState<string[]>([]);

  const refreshTrusted = () => {
    sendToBackground<string[]>(MSG.LIST_TRUSTED).then((res) => {
      if (res.success) setTrusted(res.data ?? []);
    });
  };

  useEffect(() => {
    getConfig().then(setConfig);
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

  const handleSave = async () => {
    await saveConfig(config);
    setSaved(true);
  };

  return (
    <div className="options">
      <h1>飞书文档导出助手 · 设置</h1>

      <section className="field">
        <label>导出 Markdown 时的图片处理</label>
        <select
          value={config.imageMode}
          onChange={(e) => update('imageMode', e.target.value as ExtensionConfig['imageMode'])}
        >
          <option value="download">下载图片到本地（随 zip 打包）</option>
          <option value="link">保留在线链接</option>
        </select>
      </section>

      <section className="field">
        <label>反馈页面地址</label>
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
          诊断信息中包含页面快照
        </label>
      </section>

      <h2>网页复制</h2>

      <section className="field checkbox">
        <label>
          <input
            type="checkbox"
            checked={config.webcopy.autoCopyEnabled}
            onChange={(e) => updateWebcopy('autoCopyEnabled', e.target.checked)}
          />
          选中文字自动复制（需在页面上激活过网页复制后生效）
        </label>
      </section>

      <section className="field">
        <label>自动复制的最小选中字符数</label>
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
        <label>自动复制格式</label>
        <select
          value={config.webcopy.autoCopyFormat}
          onChange={(e) =>
            updateWebcopy(
              'autoCopyFormat',
              e.target.value as WebCopyConfig['autoCopyFormat']
            )
          }
        >
          <option value="text">纯文本</option>
          <option value="markdown">Markdown（保留格式）</option>
        </select>
      </section>

      <section className="field">
        <label>「复制全部标签页」输出格式</label>
        <select
          value={config.webcopy.tabCopyFormat}
          onChange={(e) =>
            updateWebcopy(
              'tabCopyFormat',
              e.target.value as WebCopyConfig['tabCopyFormat']
            )
          }
        >
          <option value="markdown">Markdown 链接：[标题](URL)</option>
          <option value="title-url">标题 - URL</option>
          <option value="title">仅标题</option>
          <option value="url">仅 URL</option>
        </select>
      </section>

      <button className="save-btn" onClick={handleSave}>
        保存设置
      </button>
      {saved && <span className="saved-hint">已保存 ✓</span>}

      <section className="field">
        <label>已信任的私有化域名</label>
        {trusted.length === 0 ? (
          <p className="trusted-empty">
            暂无。在私有化飞书文档页侧边栏点击「授权访问该域名」后会出现在此。
          </p>
        ) : (
          <ul className="trusted-list">
            {trusted.map((origin) => (
              <li key={origin}>
                <span className="trusted-origin">{origin}</span>
                <button
                  className="revoke-btn"
                  onClick={() => handleRevoke(origin)}
                >
                  撤销
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
