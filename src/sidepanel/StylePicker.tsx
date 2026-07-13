import { useEffect, useRef, useState } from 'react';
import { getWechatTheme } from '../shared/themes';
import { t } from '../shared/i18n';
import type { ActionItem } from './actions';

/**
 * 小红书/公众号的样式下拉直选（006，消灭「先展开再选」两段式）：
 * 点按钮展开样式列表（色块 + 样式名，公众号悬浮出排版预览），点样式即执行。
 */

/** 公众号样式的悬浮预览：用主题真实配色渲染一小段标题/正文/引用示例 */
function WechatThemePreview({ themeId }: { themeId: string }) {
  const theme = getWechatTheme(themeId);
  return (
    <div className="wtp">
      <div
        className="wtp-heading"
        style={{
          color: theme.headingColor,
          ...(theme.accentBar
            ? { borderLeft: `3px solid ${theme.accentBar}`, paddingLeft: 8 }
            : {}),
        }}
      >
        {t('sidepanel.themePreview.heading')}
      </div>
      <p className="wtp-body">{t('sidepanel.themePreview.body')}</p>
      <div className="wtp-quote" style={{ borderLeft: `3px solid ${theme.quoteBorder}` }}>
        {t('sidepanel.themePreview.quote')}
      </div>
    </div>
  );
}

interface StylePickerProps {
  item: ActionItem;
  disabled: boolean;
  /** 记忆的上次样式 id（高亮展示） */
  savedThemeId: string;
  /** 点选样式即执行 */
  onPick: (item: ActionItem, themeId: string) => void;
}

export function StylePicker({ item, disabled, savedThemeId, onPick }: StylePickerProps) {
  const [open, setOpen] = useState(false);
  const [hoverTheme, setHoverTheme] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 点组件外部即收起
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <div className="sp" ref={rootRef}>
      <button
        type="button"
        className={`sp-btn${open ? ' open' : ''}`}
        disabled={disabled}
        title={t(item.subtitle)}
        onClick={() => setOpen((v) => !v)}
      >
        {t(item.title)}
        <span className="sp-caret">{open ? '⌄' : '▾'}</span>
      </button>

      {open && (
        <div className="sp-menu" onMouseLeave={() => setHoverTheme(null)}>
          {(item.themes ?? []).map((th) => (
            <button
              key={th.id}
              type="button"
              className={`sp-option${savedThemeId === th.id ? ' selected' : ''}`}
              disabled={disabled}
              onMouseEnter={() => item.key === 'wechat' && setHoverTheme(th.id)}
              onClick={() => {
                setOpen(false);
                onPick(item, th.id);
              }}
            >
              <span className="theme-swatch" style={{ background: th.swatch }} />
              {t(th.name)}
            </button>
          ))}
          {item.key === 'wechat' && hoverTheme && <WechatThemePreview themeId={hoverTheme} />}
        </div>
      )}
    </div>
  );
}
