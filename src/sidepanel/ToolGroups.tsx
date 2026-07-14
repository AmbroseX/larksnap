import { useEffect, useState, useCallback, type ReactNode } from 'react';
import type {
  ExportProgress,
  Response,
  ScreenshotFormat,
  UiPrefs,
  WebCopyConfig,
  WebCopyMdResult,
  WebCopyNeedsPermission,
  WebCopyState,
} from '../shared/types';
import { DEFAULT_CONFIG, MSG, STORAGE_KEYS } from '../shared/constants';
import { onBackgroundMessage, sendToBackground } from '../shared/messaging';
import { getConfig, saveConfig } from '../shared/storage';
import { t } from '../shared/i18n';
import { useI18n } from '../shared/i18n/useI18n';

/**
 * 通用工具区（006，US3）：任何页面常驻的四个可折叠分组——
 *   剪藏（整页/选区转 MD + 标签页链接）/ 截图 / AI 总结 / 页面开关。
 * 折叠态持久化到 storage.local 的 ui-prefs；默认剪藏展开、其余折叠。
 * restricted 页整组置灰（由 disabled 属性控制）。
 * 剪藏管线逻辑自 WebCopyView 迁入：手势和焦点都在侧边栏，剪贴板/下载由本组件完成。
 */

type GroupId = 'webcopy' | 'screenshot' | 'summary' | 'pageToggles';

/** 默认折叠态：剪藏展开、其余折叠（spec 澄清已拍板） */
const DEFAULT_COLLAPSED: Record<GroupId, boolean> = {
  webcopy: false,
  screenshot: true,
  summary: true,
  pageToggles: true,
};

async function loadCollapsed(): Promise<Record<GroupId, boolean>> {
  try {
    const got = await chrome.storage.local.get(STORAGE_KEYS.UI_PREFS);
    const prefs = got[STORAGE_KEYS.UI_PREFS] as UiPrefs | undefined;
    return { ...DEFAULT_COLLAPSED, ...(prefs?.collapsedGroups ?? {}) };
  } catch {
    return { ...DEFAULT_COLLAPSED };
  }
}

/** 消息调用 + 权限兜底重试（request 异常不吞：原因直接给状态栏，便于定位授权弹不出的问题） */
async function callWebcopy<T>(type: string, data?: unknown): Promise<Response<T>> {
  const res = await sendToBackground<T | WebCopyNeedsPermission>(type, data);
  const fallback = res.data as WebCopyNeedsPermission | undefined;
  if (!res.success && fallback?.needsPermission) {
    let reqErr = '';
    const granted = await chrome.permissions
      .request({ origins: [fallback.originPattern] })
      .catch((e: unknown) => {
        reqErr = e instanceof Error ? e.message : String(e);
        return false;
      });
    if (!granted) {
      return { success: false, error: reqErr || t('webcopy.notAuthorizedMenu') };
    }
    return (await sendToBackground<T>(type, data)) as Response<T>;
  }
  return res as Response<T>;
}

/**
 * 在用户点击手势里确保截图权限。
 * 浏览器规定 captureVisibleTab 只认两种授权：activeTab（右键/快捷键入口自带）
 * 或字面 <all_urls> 全站权限——站点级 *://host/* 授权对抓屏无效（Chromium 的
 * CanCaptureVisiblePage 只查 match_all_urls 的 pattern）。侧边栏按钮拿不到
 * activeTab，只能在这次点击里一次性申请 <all_urls>。
 * 返回 null = 就绪；否则返回给状态栏显示的失败原因（拒绝/请求异常都要可见）。
 */
async function ensureShotPermission(): Promise<string | null> {
  try {
    if (await chrome.permissions.contains({ origins: ['<all_urls>'] })) return null;
    const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
    return granted ? null : t('webcopy.screenshot.denied');
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function sanitizeFilename(name: string): string {
  const n = (name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 100)
    .trim();
  return n || t('webcopy.defaultFilename');
}

/**
 * 侧边栏内锚点下载：blob 是本页面创建的同源资源，download 属性命名稳定生效。
 * 不走 chrome.downloads —— 扩展页 + blob URL 下 filename 参数会被忽略（实测踩坑）。
 */
function downloadMarkdown(markdown: string, title: string): void {
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sanitizeFilename(title)}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 可折叠分组外壳 */
function Group({
  id,
  title,
  collapsed,
  onToggle,
  children,
}: {
  id: GroupId;
  title: string;
  collapsed: boolean;
  onToggle: (id: GroupId) => void;
  children: ReactNode;
}) {
  return (
    <div className={`tool-group${collapsed ? ' collapsed' : ''}`}>
      <button type="button" className="tool-group-head" onClick={() => onToggle(id)}>
        <span className="tool-group-caret">{collapsed ? '▸' : '▾'}</span>
        <span className="tool-group-title">{title}</span>
      </button>
      {!collapsed && <div className="tool-group-body">{children}</div>}
    </div>
  );
}

export function ToolGroups({
  disabled,
  onOpenChat,
}: {
  disabled: boolean;
  /** 「AI 总结」组的入口：跳到对话页（007，SummaryView 已由 ChatView 取代） */
  onOpenChat: () => void;
}) {
  useI18n();
  const [collapsed, setCollapsed] = useState<Record<GroupId, boolean>>(DEFAULT_COLLAPSED);
  /** null = 空闲态，渲染时取当前语言的默认提示 */
  const [status, setStatus] = useState<string | null>(null);
  const [statusKind, setStatusKind] = useState<'idle' | 'success' | 'error'>('idle');
  const [busy, setBusy] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [webcopyCfg, setWebcopyCfg] = useState<WebCopyConfig>(DEFAULT_CONFIG.webcopy);
  /** 剪贴板写入失败时展示结果，让用户手动复制 */
  const [preview, setPreview] = useState<string | null>(null);
  const [shotBusy, setShotBusy] = useState(false);
  /** 截取时长上限（秒）输入值；空串 = 自动（内置兜底 2 分钟），无限滚动页手动指定 */
  const [shotSecs, setShotSecs] = useState('');
  /** 每屏最少停顿（秒）输入值；空串 = 纯自适应，重动画/背景图页手动加大 */
  const [shotStep, setShotStep] = useState('');

  useEffect(() => {
    void loadCollapsed().then(setCollapsed);
    getConfig().then((cfg) => setWebcopyCfg(cfg.webcopy));
    // 只查状态不注入，保持零侵入
    sendToBackground<WebCopyState>(MSG.WEBCOPY_GET_STATE).then((res) => {
      if (res.success && res.data) setUnlocked(res.data.unlocked);
    });
  }, []);

  const toggleGroup = useCallback((id: GroupId) => {
    setCollapsed((cur) => {
      const next = { ...cur, [id]: !cur[id] };
      void chrome.storage.local.set({
        [STORAGE_KEYS.UI_PREFS]: { collapsedGroups: next } satisfies UiPrefs,
      });
      return next;
    });
  }, []);

  const report = useCallback((ok: boolean, msg: string) => {
    setStatus(msg);
    setStatusKind(ok ? 'success' : 'error');
  }, []);

  // 整页截图的逐屏/拼接进度经 PROGRESS 推送，映射到本区块状态栏
  useEffect(() => {
    return onBackgroundMessage((msg) => {
      if (msg.type !== MSG.PROGRESS) return;
      const p = msg.data as ExportProgress | undefined;
      if (!p || p.action !== 'screenshot') return;
      setStatus(p.message);
      setStatusKind(p.status === 'error' ? 'error' : p.status === 'success' ? 'success' : 'idle');
    });
  }, []);

  /**
   * 侧边栏自己写剪贴板：navigator.clipboard 的激活窗口可能过期，
   * 失败降级临时 textarea + execCommand，都失败才给手动复制预览。
   */
  const copyText = useCallback(
    async (text: string, okMsg: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setPreview(null);
        report(true, okMsg);
        return;
      } catch {
        // 降级 execCommand
      }
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      ta.remove();
      if (ok) {
        setPreview(null);
        report(true, okMsg);
      } else {
        setPreview(text);
        report(false, t('webcopy.clipboardFailed'));
      }
    },
    [report]
  );

  const run = useCallback(
    async (key: string, task: () => Promise<void>) => {
      if (busy) return;
      setBusy(key);
      setStatusKind('idle');
      setStatus(t('webcopy.executing'));
      try {
        await task();
      } catch (e) {
        report(false, e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [busy, report]
  );

  const handlePageMd = (mode: 'copy' | 'download') =>
    run(`page-${mode}`, async () => {
      const res = await callWebcopy<WebCopyMdResult>(MSG.WEBCOPY_PAGE_MD, { mode });
      if (!res.success || !res.data) {
        report(false, res.error || t('webcopy.convertFailed'));
        return;
      }
      const { markdown, title, degraded } = res.data;
      const hint = degraded ? t('webcopy.pageMd.degradedHint') : '';
      if (mode === 'copy') {
        await copyText(
          markdown,
          t('webcopy.pageMd.copiedPage', { count: markdown.length, hint })
        );
      } else {
        downloadMarkdown(markdown, title);
        report(
          true,
          t('webcopy.pageMd.downloaded', { name: `${sanitizeFilename(title)}.md`, hint })
        );
      }
    });

  const handleSelectionMd = () =>
    run('selection', async () => {
      const res = await callWebcopy<WebCopyMdResult>(MSG.WEBCOPY_SELECTION_MD);
      if (!res.success || !res.data) {
        report(false, res.error || t('webcopy.convertFailed'));
        return;
      }
      await copyText(res.data.markdown, t('webcopy.pageMd.copiedSelection'));
    });

  const handleCopyTabs = (scope: 'current' | 'all') =>
    run(`tabs-${scope}`, async () => {
      const res = await sendToBackground<{ text: string; count: number }>(MSG.COPY_TABS, {
        scope,
        format: scope === 'current' ? 'markdown' : webcopyCfg.tabCopyFormat,
      });
      if (!res.success || !res.data) {
        report(false, res.error || t('webcopy.copyFailed'));
        return;
      }
      await copyText(
        res.data.text,
        scope === 'current'
          ? t('webcopy.tabs.copiedCurrent')
          : t('webcopy.tabs.copiedAll', { count: res.data.count })
      );
    });

  /** 整页截图：滚动逐屏抓取在 SW 完成，产物直接落盘到下载目录 */
  const handleScreenshot = async (format: ScreenshotFormat) => {
    if (shotBusy || busy) return;
    setShotBusy(true);
    setStatusKind('idle');
    setStatus(t('webcopy.screenshot.preparing'));
    try {
      // 先在本次点击手势里把全站权限要到手，弹框才弹得出来（SW 抓图失败再弹就晚了）
      const permErr = await ensureShotPermission();
      if (permErr) {
        report(false, permErr);
        return;
      }
      const secs = Number(shotSecs);
      const step = Number(shotStep);
      const res = await callWebcopy<{ truncated?: boolean }>(MSG.EXPORT_SCREENSHOT, {
        format,
        maxSeconds: Number.isFinite(secs) && secs > 0 ? secs : undefined,
        stepSeconds: Number.isFinite(step) && step > 0 ? step : undefined,
      });
      if (!res.success) report(false, res.error || t('webcopy.screenshot.failed'));
      // 成功文案由 PROGRESS 的 success 消息给出（含截断提示），此处不覆盖
    } catch (e) {
      report(false, e instanceof Error ? e.message : String(e));
    } finally {
      setShotBusy(false);
    }
  };

  const handleToggleUnlock = () =>
    run('unlock', async () => {
      const next = !unlocked;
      const res = await callWebcopy<{ enabled: boolean }>(MSG.WEBCOPY_TOGGLE_UNLOCK, {
        enabled: next,
      });
      if (!res.success || !res.data) {
        report(false, res.error || t('webcopy.actionFailed'));
        return;
      }
      setUnlocked(res.data.enabled);
      report(true, res.data.enabled ? t('webcopy.unlock.on') : t('webcopy.unlock.off'));
    });

  const handleToggleAutoCopy = () =>
    run('autocopy', async () => {
      const next = { ...webcopyCfg, autoCopyEnabled: !webcopyCfg.autoCopyEnabled };
      await saveConfig({ webcopy: next });
      setWebcopyCfg(next);
      if (next.autoCopyEnabled) {
        const res = await callWebcopy<WebCopyState>(MSG.WEBCOPY_ENSURE);
        report(
          true,
          res.success
            ? t('webcopy.autoCopy.on')
            : t('webcopy.autoCopy.onNotActive', { err: res.error || '' })
        );
      } else {
        report(true, t('webcopy.autoCopy.off'));
      }
    });

  return (
    <section className={`tool-groups${disabled ? ' disabled' : ''}`}>
      <div className="section-title">{t('sidepanel.sectionTools')}</div>

      <Group
        id="webcopy"
        title={t('sidepanel.groupWebcopy')}
        collapsed={collapsed.webcopy}
        onToggle={toggleGroup}
      >
        <div className="wc-btn-row">
          <button
            className="wc-btn primary"
            disabled={disabled || !!busy}
            onClick={() => handlePageMd('copy')}
          >
            {t('webcopy.pageMd.copy')}
          </button>
          <button
            className="wc-btn"
            disabled={disabled || !!busy}
            onClick={() => handlePageMd('download')}
          >
            {t('webcopy.pageMd.download')}
          </button>
          <button
            className="wc-btn"
            disabled={disabled || !!busy}
            onClick={handleSelectionMd}
          >
            {t('webcopy.pageMd.selectionOnly')}
          </button>
        </div>
        <div className="wc-btn-row">
          <button
            className="wc-btn"
            disabled={disabled || !!busy}
            onClick={() => handleCopyTabs('current')}
          >
            {t('webcopy.tabs.copyCurrent')}
          </button>
          <button
            className="wc-btn"
            disabled={disabled || !!busy}
            onClick={() => handleCopyTabs('all')}
          >
            {t('webcopy.tabs.copyAll')}
          </button>
        </div>
      </Group>

      <Group
        id="screenshot"
        title={t('sidepanel.groupScreenshot')}
        collapsed={collapsed.screenshot}
        onToggle={toggleGroup}
      >
        <div className="wc-btn-row">
          <button
            className="wc-btn primary"
            disabled={disabled || shotBusy || !!busy}
            onClick={() => handleScreenshot('png')}
          >
            {shotBusy ? t('webcopy.screenshot.shooting') : t('webcopy.screenshot.png')}
          </button>
          <button
            className="wc-btn"
            disabled={disabled || shotBusy || !!busy}
            onClick={() => handleScreenshot('pdf')}
          >
            {t('webcopy.screenshot.pdf')}
          </button>
        </div>
        <label className="wc-shot-time">
          <span>{t('webcopy.screenshot.stepLabel')}</span>
          <input
            type="number"
            min={0.1}
            max={10}
            step={0.5}
            value={shotStep}
            placeholder={t('webcopy.screenshot.timeAuto')}
            disabled={disabled || shotBusy}
            onChange={(e) => setShotStep(e.target.value)}
          />
          <span>{t('webcopy.screenshot.timeUnit')}</span>
        </label>
        <label className="wc-shot-time">
          <span>{t('webcopy.screenshot.timeLabel')}</span>
          <input
            type="number"
            min={5}
            max={600}
            value={shotSecs}
            placeholder={t('webcopy.screenshot.timeAuto')}
            disabled={disabled || shotBusy}
            onChange={(e) => setShotSecs(e.target.value)}
          />
          <span>{t('webcopy.screenshot.timeUnit')}</span>
        </label>
        <div className="wc-row-sub">{t('webcopy.screenshot.sub')}</div>
      </Group>

      <Group
        id="summary"
        title={t('sidepanel.groupSummary')}
        collapsed={collapsed.summary}
        onToggle={toggleGroup}
      >
        <div className="wc-btn-row">
          <button className="wc-btn primary" disabled={disabled} onClick={onOpenChat}>
            {t('chat.entry')}
          </button>
        </div>
        <div className="wc-row-sub">{t('chat.entrySub')}</div>
      </Group>

      <Group
        id="pageToggles"
        title={t('sidepanel.groupToggles')}
        collapsed={collapsed.pageToggles}
        onToggle={toggleGroup}
      >
        <label className="wc-toggle-row">
          <span>
            <span className="wc-row-title">{t('webcopy.unlock.title')}</span>
            <span className="wc-row-sub">{t('webcopy.unlock.sub')}</span>
          </span>
          <input
            type="checkbox"
            checked={unlocked}
            disabled={disabled || !!busy}
            onChange={handleToggleUnlock}
          />
        </label>
        <label className="wc-toggle-row">
          <span>
            <span className="wc-row-title">{t('webcopy.autoCopy.title')}</span>
            <span className="wc-row-sub">
              {t('webcopy.autoCopy.sub', { n: webcopyCfg.autoCopyMinChars })}
            </span>
          </span>
          <input
            type="checkbox"
            checked={webcopyCfg.autoCopyEnabled}
            disabled={disabled || !!busy}
            onChange={handleToggleAutoCopy}
          />
        </label>
      </Group>

      {(status || preview != null) && (
        <div className={`wc-status wc-status-${statusKind}`}>
          {status ?? t('webcopy.idle')}
        </div>
      )}

      {preview != null && (
        <div className="wc-card">
          <div className="wc-card-title">{t('webcopy.resultTitle')}</div>
          <textarea
            className="wc-preview"
            readOnly
            value={preview}
            onFocus={(e) => e.currentTarget.select()}
          />
        </div>
      )}
    </section>
  );
}
