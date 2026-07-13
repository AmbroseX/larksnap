import { useEffect, useState, useCallback, useRef } from 'react';
import type {
  ExportProgress,
  Response,
  ScreenshotFormat,
  VideoProbeResult,
  VideoQualityOption,
  VideoState,
  VideoTaskInfo,
  WebCopyConfig,
  WebCopyMdResult,
  WebCopyNeedsPermission,
  WebCopyState,
} from '../shared/types';
import { DEFAULT_CONFIG, MSG } from '../shared/constants';
import { onBackgroundMessage, sendToBackground } from '../shared/messaging';
import { getConfig, saveConfig } from '../shared/storage';
import { t } from '../shared/i18n';
import { useI18n } from '../shared/i18n/useI18n';

/**
 * 网页复制区块（非飞书页面的侧边栏主入口）。
 * 手势和焦点都在侧边栏，剪贴板/下载统一由本组件完成（技术方案 §3.5）；
 * 注入失败时在同一手势里 permissions.request 兜底后重试（§2.1 辅路径）。
 */

/** 消息调用 + 权限兜底重试 */
async function callWebcopy<T>(type: string, data?: unknown): Promise<Response<T>> {
  const res = await sendToBackground<T | WebCopyNeedsPermission>(type, data);
  const fallback = res.data as WebCopyNeedsPermission | undefined;
  if (!res.success && fallback?.needsPermission) {
    const granted = await chrome.permissions
      .request({ origins: [fallback.originPattern] })
      .catch(() => false);
    if (!granted) {
      return { success: false, error: t('webcopy.notAuthorizedMenu') };
    }
    return (await sendToBackground<T>(type, data)) as Response<T>;
  }
  return res as Response<T>;
}

function sanitizeFilename(name: string): string {
  let n = (name ?? '')
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
 * 不走 chrome.downloads —— 扩展页 + blob URL 下 filename 参数会被忽略，
 * 落下来变成 blob UUID 名（实测踩坑）。
 */
/** 档位 → 展示名（2160→4K、1440→2K，60 帧档加标注）与 quality 参数值（如 '2160@60'） */
function qualityLabel(o: VideoQualityOption): string {
  const res = o.height >= 2160 ? '4K' : o.height >= 1440 ? '2K' : `${o.height}P`;
  return o.fps ? `${res} ${t('webcopy.fps', { fps: o.fps })}` : res;
}
function qualityValue(o: VideoQualityOption): string {
  return `${o.height}@${o.fps ?? 30}`;
}

/** 探测失败时的静态兜底档位 */
const FALLBACK_QUALITIES: VideoQualityOption[] = [
  { height: 1080, fps: null },
  { height: 720, fps: null },
  { height: 480, fps: null },
];

function downloadMarkdown(markdown: string, title: string): void {
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sanitizeFilename(title)}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 给下载留足启动时间再释放
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function WebCopyView() {
  useI18n(); // 订阅语言切换，切换时整块重渲染
  /** null = 空闲态，渲染时取当前语言的默认提示 */
  const [status, setStatus] = useState<string | null>(null);
  const [statusKind, setStatusKind] = useState<'idle' | 'success' | 'error'>('idle');
  const [busy, setBusy] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [webcopyCfg, setWebcopyCfg] = useState<WebCopyConfig>(DEFAULT_CONFIG.webcopy);
  /** 剪贴板写入失败时展示结果，让用户手动复制 */
  const [preview, setPreview] = useState<string | null>(null);
  /** 当前页是视频站点时非 null（含桥接就绪与否） */
  const [video, setVideo] = useState<VideoState | null>(null);
  /** 下载可能持续几分钟，用独立 busy，不锁其他按钮 */
  const [videoBusy, setVideoBusy] = useState(false);
  /** 画质封顶（'best' 或 '1080@60' 形态；探测结果变化时若失效会重置回 best） */
  const [quality, setQuality] = useState('best');
  /** 探测出的真实档位；null=探测中或未探测，失败用 FALLBACK_QUALITIES */
  const [probed, setProbed] = useState<VideoQualityOption[] | null>(null);
  const [probeFailed, setProbeFailed] = useState(false);
  /** 整页截图进行中（滚动逐屏可能几秒到几十秒，独立 busy） */
  const [shotBusy, setShotBusy] = useState(false);
  /** 视频下载任务列表（SW 推送全量；有任务就显示，与当前页是否视频站无关） */
  const [videoTasks, setVideoTasks] = useState<VideoTaskInfo[]>([]);
  /** 本次下载线路：auto=名单/记忆自动决定；direct/proxy=强制。按站点记住上次选择 */
  const [routeChoice, setRouteChoice] = useState<'auto' | 'direct' | 'proxy'>('auto');

  /** 上次探测的视频地址：同一视频不重复探测；也用于丢弃换页后才回来的旧结果 */
  const probeUrlRef = useRef<string | null>(null);

  /** 查视频入口状态 + 需要时探测清晰度（面板打开、切标签页、页内跳转都会调） */
  const refreshVideo = useCallback(async () => {
    const res = await sendToBackground<VideoState>(MSG.GET_VIDEO_STATE);
    if (!res.success || !res.data?.supported) {
      setVideo(null);
      probeUrlRef.current = null;
      return;
    }
    setVideo(res.data);
    if (!res.data.bridgeReady) return;
    const url = res.data.url ?? '';
    if (url === probeUrlRef.current) return; // 还是这个视频，沿用已探测档位
    probeUrlRef.current = url;
    setProbed(null);
    setProbeFailed(false);
    setQuality('best');
    // 探测真实档位（yt-dlp -J，几秒）；失败退静态档位
    const p = await sendToBackground<VideoProbeResult>(MSG.PROBE_VIDEO);
    if (probeUrlRef.current !== url) return; // 期间又换页了，丢弃旧结果
    if (p.success && p.data?.options.length) {
      const opts = p.data.options;
      setProbed(opts);
      // 探测期间用户可能已在静态档位上选了分辨率：映射到真实档位里同高度的
      // （优先普通帧率档），真实档位里没有这个高度则回到最高画质
      setQuality((q) => {
        if (q === 'best' || opts.some((o) => qualityValue(o) === q)) return q;
        const h = Number(q.split('@')[0]);
        const same = opts.filter((o) => o.height === h);
        return same.length ? qualityValue(same.find((o) => !o.fps) ?? same[0]) : 'best';
      });
    } else {
      setProbeFailed(true);
    }
  }, []);

  useEffect(() => {
    getConfig().then((cfg) => setWebcopyCfg(cfg.webcopy));
    // 只查状态不注入，保持零侵入
    sendToBackground<WebCopyState>(MSG.WEBCOPY_GET_STATE).then((res) => {
      if (res.success && res.data) setUnlocked(res.data.unlocked);
    });
    void refreshVideo();
    // 切标签页 / 当前页地址变化（B 站是 SPA，换视频不刷新页面）→ 重新识别并探测
    const onActivated = () => void refreshVideo();
    const onUpdated = (
      _tabId: number,
      info: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab
    ) => {
      if (tab.active && (info.url || info.status === 'complete')) void refreshVideo();
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [refreshVideo]);

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

  // 线路选择按站点记忆（localStorage）；换站点时恢复上次选择
  useEffect(() => {
    const site = video?.site;
    if (!site) return;
    const saved = localStorage.getItem(`larksnap:video-route-choice:${site}`);
    setRouteChoice(saved === 'direct' || saved === 'proxy' ? saved : 'auto');
  }, [video?.site]);

  const pickRoute = (r: 'auto' | 'direct' | 'proxy') => {
    setRouteChoice(r);
    if (video?.site) localStorage.setItem(`larksnap:video-route-choice:${video.site}`, r);
  };

  // 下载任务列表：打开时拉一次全量，之后靠 SW 推送保持同步
  useEffect(() => {
    sendToBackground<VideoTaskInfo[]>(MSG.LIST_VIDEO_TASKS).then((res) => {
      if (res.success && res.data) setVideoTasks(res.data);
    });
    return onBackgroundMessage((msg) => {
      if (msg.type !== MSG.VIDEO_TASKS) return;
      setVideoTasks((msg.data as VideoTaskInfo[]) ?? []);
    });
  }, []);

  /** 整页截图：滚动逐屏抓取在 SW 完成，产物直接落盘到下载目录 */
  const handleScreenshot = async (format: ScreenshotFormat) => {
    if (shotBusy || busy) return;
    setShotBusy(true);
    setStatusKind('idle');
    setStatus(t('webcopy.screenshot.preparing'));
    try {
      const res = await sendToBackground<{ truncated?: boolean }>(MSG.EXPORT_SCREENSHOT, {
        format,
      });
      if (!res.success) report(false, res.error || t('webcopy.screenshot.failed'));
      // 成功文案由 PROGRESS 的 success 消息给出（含截断提示），此处不覆盖
    } catch (e) {
      report(false, e instanceof Error ? e.message : String(e));
    } finally {
      setShotBusy(false);
    }
  };

  /**
   * 侧边栏自己写剪贴板。
   * navigator.clipboard 依赖「用户激活」窗口——站点适配器抓取是异步的（要 fetch
   * 多页数据），等抓完再写时点击的激活窗口可能已过期而被拒。故失败降级为临时
   * textarea + execCommand（只要侧边栏有焦点即可，不吃激活窗口），都失败才给预览。
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
      // 提取器没命中、走了兜底链：产物可用但可能混入页面噪音，提示一句
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

  const handleToggleUnlock = () =>
    run('unlock', async () => {
      const next = !unlocked;
      const res = await callWebcopy<{ enabled: boolean }>(
        MSG.WEBCOPY_TOGGLE_UNLOCK,
        { enabled: next }
      );
      if (!res.success || !res.data) {
        report(false, res.error || t('webcopy.actionFailed'));
        return;
      }
      setUnlocked(res.data.enabled);
      report(true, res.data.enabled ? t('webcopy.unlock.on') : t('webcopy.unlock.off'));
    });

  const handleCopyTabs = (scope: 'current' | 'all') =>
    run(`tabs-${scope}`, async () => {
      const res = await sendToBackground<{ text: string; count: number }>(
        MSG.COPY_TABS,
        {
          scope,
          format: scope === 'current' ? 'markdown' : webcopyCfg.tabCopyFormat,
        }
      );
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

  /**
   * 下载视频：入队即返回（SW 排队、daemon 最多 2 个并发），
   * 进度看下方任务列表（VIDEO_TASKS 推送），按钮不再锁到下载结束。
   */
  const handleDownloadVideo = async () => {
    if (videoBusy) return;
    setVideoBusy(true);
    setStatusKind('idle');
    try {
      const res = await sendToBackground<{ taskId: string }>(MSG.DOWNLOAD_VIDEO, {
        quality,
        route: routeChoice,
      });
      if (res.success) {
        report(true, t('webcopy.video.queued'));
      } else {
        report(false, res.error || t('webcopy.video.failed'));
      }
    } catch (e) {
      report(false, e instanceof Error ? e.message : String(e));
    } finally {
      setVideoBusy(false);
    }
  };

  const handleClearTasks = async () => {
    await sendToBackground(MSG.CLEAR_VIDEO_TASKS);
  };

  const handleToggleAutoCopy = () =>
    run('autocopy', async () => {
      const next = { ...webcopyCfg, autoCopyEnabled: !webcopyCfg.autoCopyEnabled };
      await saveConfig({ webcopy: next });
      setWebcopyCfg(next);
      if (next.autoCopyEnabled) {
        // 注入当前标签页让开关立即生效；其他页面需再次手动激活（P0 会话级）
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
    <div className="webcopy">
      {video?.supported && (
        <div className="wc-card">
          <div className="wc-card-title">{t('webcopy.video.title')}</div>
          {/* 选择器常显：探测中先给静态档位可选，真实档位回来后无缝替换（已选高度会自动映射） */}
          <div className="theme-picker">
            {[
              { value: 'best', label: t('webcopy.video.best') },
              ...(probed ?? FALLBACK_QUALITIES).map((o) => ({
                // 探测档带 @fps 精确封顶；兜底档只封分辨率（不知道有没有 60 帧变体）
                value: probed ? qualityValue(o) : String(o.height),
                label: qualityLabel(o),
              })),
            ].map((q) => (
              <button
                key={q.value}
                className={`theme-chip${quality === q.value ? ' selected' : ''}`}
                disabled={videoBusy}
                onClick={() => setQuality(q.value)}
              >
                {q.label}
              </button>
            ))}
          </div>
          {video.bridgeReady && probed == null && !probeFailed && (
            <div className="wc-row-sub">{t('webcopy.video.probing')}</div>
          )}
          <div className="wc-btn-row">
            <button
              className="wc-btn primary"
              disabled={videoBusy || !video.bridgeReady}
              onClick={handleDownloadVideo}
            >
              {videoBusy ? t('webcopy.video.downloading') : t('webcopy.video.download')}
            </button>
            <div className="wc-route-picker">
              {(
                [
                  { value: 'auto', label: t('webcopy.video.routeAuto') },
                  { value: 'proxy', label: t('webcopy.video.routeProxy') },
                  { value: 'direct', label: t('webcopy.video.routeDirect') },
                ] as const
              ).map((r) => (
                <button
                  key={r.value}
                  className={`theme-chip${routeChoice === r.value ? ' selected' : ''}`}
                  title={t('webcopy.video.routeTitle')}
                  onClick={() => pickRoute(r.value)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
          <div className="wc-row-sub">
            {video.bridgeReady
              ? t('webcopy.video.savedTo')
              : video.reason || t('webcopy.video.daemonNotReady')}
          </div>
        </div>
      )}

      {videoTasks.length > 0 && (
        <div className="wc-card">
          <div className="wc-card-title wc-task-head-row">
            {t('webcopy.video.tasksTitle')}
            {videoTasks.some((x) => x.status === 'success' || x.status === 'error') && (
              <button className="wc-task-clear" onClick={handleClearTasks}>
                {t('webcopy.video.clearDone')}
              </button>
            )}
          </div>
          {videoTasks.map((task) => (
            <div key={task.id} className="wc-task">
              <div className="wc-task-line">
                <span className={`wc-task-status ${task.status}`}>
                  {
                    {
                      queued: t('webcopy.video.statusQueued'),
                      running: t('webcopy.video.statusRunning'),
                      success: t('webcopy.video.statusSuccess'),
                      error: t('webcopy.video.statusError'),
                    }[task.status]
                  }
                </span>
                <span className="wc-task-title" title={task.url}>
                  {task.title}
                </span>
                {task.status === 'running' && (
                  <span className="wc-task-pct">{task.percent ?? 0}%</span>
                )}
              </div>
              {task.message && (
                <div className={`wc-task-msg${task.status === 'error' ? ' error' : ''}`}>
                  {task.message}
                </div>
              )}
            </div>
          ))}
          <div className="wc-row-sub">{t('webcopy.video.logHint')}</div>
        </div>
      )}

      <div className="wc-card">
        <div className="wc-card-title">{t('webcopy.pageMd.title')}</div>
        <div className="wc-btn-row">
          <button
            className="wc-btn primary"
            disabled={!!busy}
            onClick={() => handlePageMd('copy')}
          >
            {t('webcopy.pageMd.copy')}
          </button>
          <button
            className="wc-btn"
            disabled={!!busy}
            onClick={() => handlePageMd('download')}
          >
            {t('webcopy.pageMd.download')}
          </button>
          <button className="wc-btn" disabled={!!busy} onClick={handleSelectionMd}>
            {t('webcopy.pageMd.selectionOnly')}
          </button>
        </div>
      </div>

      <div className="wc-card">
        <div className="wc-card-title">{t('webcopy.screenshot.title')}</div>
        <div className="wc-btn-row">
          <button
            className="wc-btn primary"
            disabled={shotBusy || !!busy}
            onClick={() => handleScreenshot('png')}
          >
            {shotBusy ? t('webcopy.screenshot.shooting') : t('webcopy.screenshot.png')}
          </button>
          <button
            className="wc-btn"
            disabled={shotBusy || !!busy}
            onClick={() => handleScreenshot('pdf')}
          >
            {t('webcopy.screenshot.pdf')}
          </button>
        </div>
        <div className="wc-row-sub">{t('webcopy.screenshot.sub')}</div>
      </div>

      <div className="wc-card">
        <label className="wc-toggle-row">
          <span>
            <span className="wc-row-title">{t('webcopy.unlock.title')}</span>
            <span className="wc-row-sub">{t('webcopy.unlock.sub')}</span>
          </span>
          <input
            type="checkbox"
            checked={unlocked}
            disabled={!!busy}
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
            disabled={!!busy}
            onChange={handleToggleAutoCopy}
          />
        </label>
      </div>

      <div className="wc-card">
        <div className="wc-card-title">{t('webcopy.tabs.title')}</div>
        <div className="wc-btn-row">
          <button
            className="wc-btn"
            disabled={!!busy}
            onClick={() => handleCopyTabs('current')}
          >
            {t('webcopy.tabs.copyCurrent')}
          </button>
          <button
            className="wc-btn"
            disabled={!!busy}
            onClick={() => handleCopyTabs('all')}
          >
            {t('webcopy.tabs.copyAll')}
          </button>
        </div>
      </div>

      <div className={`wc-status wc-status-${statusKind}`}>
        {status ?? t('webcopy.idle')}
      </div>

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
    </div>
  );
}
