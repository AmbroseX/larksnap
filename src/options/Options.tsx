import { useEffect, useState } from 'react';
import type { ExtensionConfig } from '../shared/types';
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
