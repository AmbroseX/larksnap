import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DocInfo,
  PageKindInfo,
  VideoProbeResult,
  VideoQualityOption,
  VideoState,
  VideoTaskInfo,
} from '../shared/types';
import { MSG } from '../shared/constants';
import { onBackgroundMessage, sendToBackground } from '../shared/messaging';
import { t } from '../shared/i18n';
import { useI18n } from '../shared/i18n/useI18n';
import { ACTIONS, type ActionItem } from './actions';
import { StylePicker } from './StylePicker';
import { TranscriptCard } from './TranscriptCard';

/**
 * 侧边栏上下文区（006，US3）：页面识别条 + 按页面类型渲染的动作区。
 *   feishu：4 主导出按钮 + 转发布（样式直选）+ 缓存到本地
 *   youtube：字幕卡（视频下载卡由 VideoSection 承接）
 *   video / generic：仅识别条
 *   restricted：不可操作提示（通用工具区由外层置灰）
 */

interface ContextZoneProps {
  doc: DocInfo | null;
  pageInfo: PageKindInfo | null;
  running: string | null;
  needsAuth: boolean;
  onAction: (item: ActionItem) => void;
  onPickTheme: (item: ActionItem, themeId: string) => void;
  savedTheme: (item: ActionItem) => string;
}

/** 页面识别条：让用户确认「即将操作的是哪个页面」 */
function PageBar({ doc, pageInfo }: { doc: DocInfo | null; pageInfo: PageKindInfo | null }) {
  const kind = pageInfo?.kind ?? 'generic';
  const icon =
    kind === 'feishu' ? '📄' : kind === 'youtube' || kind === 'video' ? '🎬' : kind === 'restricted' ? '🚫' : '🌐';
  const title =
    (kind === 'feishu' ? doc?.title : undefined) || pageInfo?.title || pageInfo?.url || '';
  const typeLabel =
    kind === 'feishu'
      ? `${t('sidepanel.pageKind.feishu')} ${doc?.docType ?? ''}${doc?.isPrivateDeploy ? t('sidepanel.privateSuffix') : ''}`
      : kind === 'youtube'
        ? t('sidepanel.pageKind.youtube')
        : kind === 'video'
          ? t('sidepanel.pageKind.video', { site: pageInfo?.videoSite ?? '' })
          : kind === 'restricted'
            ? t('sidepanel.pageKind.restricted')
            : t('sidepanel.pageKind.generic');
  return (
    <div className="page-bar">
      <span className="page-bar-icon">{icon}</span>
      <span className="page-bar-title" title={pageInfo?.url}>
        {title || typeLabel}
      </span>
      <span className="page-bar-type">{typeLabel}</span>
    </div>
  );
}

export function ContextZone({
  doc,
  pageInfo,
  running,
  needsAuth,
  onAction,
  onPickTheme,
  savedTheme,
}: ContextZoneProps) {
  useI18n();
  const kind = pageInfo?.kind ?? null;
  const exports = ACTIONS.filter((a) => a.group === 'export');
  const publishes = ACTIONS.filter((a) => a.group === 'publish');
  const miscs = ACTIONS.filter((a) => a.group === 'misc');

  return (
    <section className="context-zone">
      <div className="section-title">{t('sidepanel.sectionContext')}</div>
      <PageBar doc={doc} pageInfo={pageInfo} />

      {kind === 'feishu' && doc?.isFeishuDoc && (
        <>
          <div className="fx-grid">
            {exports.map((item) => (
              <button
                key={item.key}
                className={`fx-btn${running === item.key ? ' running' : ''}`}
                title={t(item.subtitle)}
                disabled={!!running || needsAuth}
                onClick={() => onAction(item)}
              >
                {t(item.title)}
              </button>
            ))}
          </div>
          <div className="fx-publish-row">
            <span className="fx-publish-label">{t('sidepanel.publishRow')}</span>
            {publishes.map((item) => (
              <StylePicker
                key={item.key}
                item={item}
                disabled={!!running || needsAuth}
                savedThemeId={savedTheme(item)}
                onPick={onPickTheme}
              />
            ))}
          </div>
          {miscs.map((item) => (
            <button
              key={item.key}
              className={`fx-misc-btn${running === item.key ? ' running' : ''}`}
              title={t(item.subtitle)}
              disabled={!!running || needsAuth}
              onClick={() => onAction(item)}
            >
              {t(item.title)}
            </button>
          ))}
        </>
      )}

      {kind === 'youtube' && <TranscriptCard />}

      {kind === 'restricted' && (
        <div className="wc-card">
          <div className="wc-row-sub">{t('sidepanel.restrictedPage')}</div>
        </div>
      )}
    </section>
  );
}

// ==================== 视频下载区块（自 WebCopyView 迁入，006） ====================

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

/**
 * 视频下载卡 + 任务列表：当前页是视频站点时显示下载卡（daemon 就绪才可下载），
 * 有任务时显示任务列表（与当前页无关）。自查 GET_VIDEO_STATE，自带状态行。
 */
export function VideoSection() {
  useI18n();
  const [video, setVideo] = useState<VideoState | null>(null);
  const [videoBusy, setVideoBusy] = useState(false);
  const [quality, setQuality] = useState('best');
  const [probed, setProbed] = useState<VideoQualityOption[] | null>(null);
  const [probeFailed, setProbeFailed] = useState(false);
  const [videoTasks, setVideoTasks] = useState<VideoTaskInfo[]>([]);
  const [routeChoice, setRouteChoice] = useState<'auto' | 'direct' | 'proxy'>('auto');
  const [note, setNote] = useState<string | null>(null);

  /** 上次探测的视频地址：同一视频不重复探测；也用于丢弃换页后才回来的旧结果 */
  const probeUrlRef = useRef<string | null>(null);

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
    if (url === probeUrlRef.current) return;
    probeUrlRef.current = url;
    setProbed(null);
    setProbeFailed(false);
    setQuality('best');
    const p = await sendToBackground<VideoProbeResult>(MSG.PROBE_VIDEO);
    if (probeUrlRef.current !== url) return;
    if (p.success && p.data?.options.length) {
      const opts = p.data.options;
      setProbed(opts);
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
    void refreshVideo();
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

  const handleDownloadVideo = async () => {
    if (videoBusy) return;
    setVideoBusy(true);
    setNote(null);
    try {
      const res = await sendToBackground<{ taskId: string }>(MSG.DOWNLOAD_VIDEO, {
        quality,
        route: routeChoice,
      });
      setNote(res.success ? t('webcopy.video.queued') : res.error || t('webcopy.video.failed'));
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setVideoBusy(false);
    }
  };

  const handleClearTasks = async () => {
    await sendToBackground(MSG.CLEAR_VIDEO_TASKS);
  };

  const handleRevealTask = async (taskId?: string) => {
    const res = await sendToBackground(MSG.REVEAL_VIDEO_FILE, { taskId });
    if (!res.success && res.error) setNote(res.error);
  };

  if (!video?.supported && videoTasks.length === 0) return null;

  return (
    <>
      {video?.supported && (
        <div className="wc-card">
          <div className="wc-card-title">{t('webcopy.video.title')}</div>
          <div className="theme-picker">
            {[
              { value: 'best', label: t('webcopy.video.best') },
              ...(probed ?? FALLBACK_QUALITIES).map((o) => ({
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
          {note && <div className="wc-row-sub">{note}</div>}
        </div>
      )}

      {videoTasks.length > 0 && (
        <div className="wc-card">
          <div className="wc-card-title wc-task-head-row">
            {t('webcopy.video.tasksTitle')}
            <span className="wc-task-actions">
              <button className="wc-task-clear open" onClick={() => handleRevealTask()}>
                {t('webcopy.video.openFolder')}
              </button>
              {videoTasks.some((x) => x.status === 'success' || x.status === 'error') && (
                <button className="wc-task-clear" onClick={handleClearTasks}>
                  {t('webcopy.video.clearDone')}
                </button>
              )}
            </span>
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
                {task.status === 'success' && (
                  <button className="wc-task-open" onClick={() => handleRevealTask(task.id)}>
                    {t('webcopy.video.revealFile')}
                  </button>
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
    </>
  );
}
