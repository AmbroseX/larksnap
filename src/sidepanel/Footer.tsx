import { MSG } from '../shared/constants';
import { sendToBackground } from '../shared/messaging';
import { getConfig } from '../shared/storage';
import { t } from '../shared/i18n';
import { useI18n } from '../shared/i18n/useI18n';

/**
 * 页脚小字链接（006：诊断/反馈从动作卡片降级到这里，与版本号并列）。
 * 诊断结果经 PROGRESS 推送到状态栏展示，本组件不自带状态。
 */
export function Footer() {
  useI18n();
  const version = chrome.runtime.getManifest().version;

  const openFeedback = async () => {
    const config = await getConfig();
    void chrome.tabs.create({ url: config.feedbackUrl });
  };

  return (
    <div className="panel-footer">
      <button type="button" className="pf-link" onClick={() => void openFeedback()}>
        {t('actions.feedback.title')}
      </button>
      <span className="pf-sep">·</span>
      <button
        type="button"
        className="pf-link"
        onClick={() => void sendToBackground(MSG.EXPORT_DIAGNOSTIC)}
      >
        {t('actions.diagnostic.title')}
      </button>
      <span className="pf-sep">·</span>
      <span className="pf-ver">v{version}</span>
    </div>
  );
}
