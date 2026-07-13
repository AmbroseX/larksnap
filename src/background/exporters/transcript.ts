import type {
  CaptionTrackInfo,
  Response,
  TranscriptResult,
  WebCopyNeedsPermission,
} from '../../shared/types';
import { VIDEO_SITES, YT_MSG } from '../../shared/constants';
import { reportProgress } from '../progress';
import { downloadDataUrl, safeName } from '../download';
import { getActiveTab } from '../doc-detect';
import { isRestrictedUrl, sendToTab } from '../webcopy';
import { t as i18n } from '../../shared/i18n';

/**
 * YouTube 字幕导出（US1，SW 编排）：注入 youtube.js → 取字幕 → 拼 Markdown →
 * 落盘或回传文本给侧边栏复制。全程只有 YouTube 同源请求，产物只落本地（宪法 V）。
 */

/** 是否 YouTube 视频观看页：host 复用 VIDEO_SITES 的 youtube 列表，仅 /watch 路径算 */
export function isYoutubeWatchUrl(url: string): boolean {
  if (!url || isRestrictedUrl(url)) return false;
  try {
    const u = new URL(url);
    const hosts = VIDEO_SITES.find((s) => s.site === 'youtube')?.hosts ?? [];
    const hit = hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
    return hit && u.pathname === '/watch' && !!u.searchParams.get('v');
  } catch {
    return false;
  }
}

/** 注入 youtube.js（脚本自身有幂等标记，重复注入无副作用） */
async function injectYoutube(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['youtube.js'] });
}

/**
 * 公共前置：拿活跃的 YouTube 视频页并注入。
 * 注入失败（无 host 权限）→ 回 needsPermission，由侧边栏在用户手势里
 * chrome.permissions.request 后重试（同 webcopy 辅路径模式）。
 */
async function withYoutubeTab<T>(
  run: (tab: chrome.tabs.Tab) => Promise<Response<T>>
): Promise<Response<T | WebCopyNeedsPermission>> {
  const tab = await getActiveTab();
  if (!tab?.id || !tab.url) return { success: false, error: i18n('bg.noActiveTab') };
  if (!isYoutubeWatchUrl(tab.url)) {
    return { success: false, error: i18n('bg.transcriptNotWatch') };
  }
  try {
    await injectYoutube(tab.id);
  } catch {
    const host = new URL(tab.url).hostname;
    return {
      success: false,
      error: i18n('bg.noPermission'),
      data: { needsPermission: true, originPattern: `*://${host}/*` },
    };
  }
  return run(tab);
}

/** 列出当前视频的字幕轨（侧边栏语言选择用） */
export function listCaptionTracks(): Promise<
  Response<CaptionTrackInfo[] | WebCopyNeedsPermission>
> {
  return withYoutubeTab<CaptionTrackInfo[]>((tab) =>
    sendToTab<CaptionTrackInfo[]>(tab.id!, YT_MSG.LIST_TRACKS)
  );
}

/** 从指定标签页抓字幕（US2 的 AI 总结取材也复用这条路，DRY） */
export async function fetchTranscriptFromTab(
  tabId: number,
  lang?: string
): Promise<TranscriptResult> {
  await injectYoutube(tabId);
  const res = await sendToTab<TranscriptResult>(tabId, YT_MSG.GET_TRANSCRIPT, { lang });
  if (!res.success || !res.data) throw new Error(res.error || i18n('bg.transcriptFetchFailed'));
  return res.data;
}

/** 拼导出 Markdown：标题 / 来源 URL / 字幕正文；降级时明确标注（FR-002） */
function buildMarkdown(t: TranscriptResult, url: string): string {
  const lines = [
    `# ${t.title || i18n('artifacts.transcript.defaultTitle')}`,
    '',
    i18n('artifacts.transcript.source', { url }),
  ];
  if (t.track && (t.track.name || t.track.languageCode)) {
    lines.push(
      i18n('artifacts.transcript.lang', { name: t.track.name || t.track.languageCode })
    );
  }
  lines.push('');
  if (t.degraded) {
    lines.push(i18n('artifacts.transcript.degradedNote'), '');
    if (t.description) lines.push(t.description);
  } else {
    lines.push(t.transcript || '');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 导出当前视频字幕。
 * mode='download'：safeName(标题).md 落盘；mode='copy'：Markdown 回传侧边栏写剪贴板
 * （剪贴板手势在侧边栏，SW 不碰）。降级产物同样回传并明确提示。
 */
export function exportTranscript(
  lang: string | undefined,
  mode: 'download' | 'copy'
): Promise<
  Response<
    { markdown: string; title: string; degraded: boolean } | WebCopyNeedsPermission
  >
> {
  return withYoutubeTab(async (tab) => {
    await reportProgress('transcript', 'running', i18n('progress.transcript.fetching'));
    try {
      const t = await fetchTranscriptFromTab(tab.id!, lang);
      const markdown = buildMarkdown(t, tab.url!);
      if (mode === 'download') {
        const dataUrl =
          'data:text/markdown;charset=utf-8,' + encodeURIComponent(markdown);
        await downloadDataUrl(
          dataUrl,
          `${safeName(t.title || i18n('artifacts.transcript.fileDefault'))}.md`
        );
      }
      const doneMsg = t.degraded
        ? i18n('progress.transcript.degraded')
        : mode === 'download'
          ? i18n('progress.transcript.saved')
          : i18n('progress.transcript.fetched');
      await reportProgress('transcript', 'success', doneMsg, 100);
      return {
        success: true,
        data: { markdown, title: t.title, degraded: t.degraded },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await reportProgress('transcript', 'error', i18n('progress.transcript.failed', { msg }));
      return { success: false, error: msg };
    }
  });
}
