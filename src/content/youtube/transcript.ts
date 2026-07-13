import type {
  CaptionTrackInfo,
  TranscriptResult,
  TranscriptSegment,
} from '../../shared/types';

/**
 * YouTube 字幕抓取（US1，纯本地）：
 *   解析 ytInitialPlayerResponse → captionTracks 选轨 → baseUrl+fmt=json3 同源 fetch → 拼全文。
 * 全程只请求 YouTube 同源接口，零外发（宪法 V / FR-001）。
 */

// ---- ytInitialPlayerResponse 里用得到的字段（只声明用到的） ----

interface YtCaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  name?: { simpleText?: string; runs?: Array<{ text?: string }> };
}

interface YtPlayerResponse {
  videoDetails?: { videoId?: string; title?: string; shortDescription?: string };
  captions?: {
    playerCaptionsTracklistRenderer?: { captionTracks?: YtCaptionTrack[] };
  };
}

/** json3 字幕响应：{events:[{tStartMs, segs:[{utf8}]}]} */
interface Json3Response {
  events?: Array<{ tStartMs?: number; segs?: Array<{ utf8?: string }> }>;
}

const PLAYER_RE = /var ytInitialPlayerResponse\s*=\s*(\{.+?\});/s;

/** 从一段 HTML / script 文本里正则抠出 playerResponse */
function parsePlayerResponse(text: string): YtPlayerResponse | null {
  const m = text.match(PLAYER_RE);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as YtPlayerResponse;
  } catch {
    return null;
  }
}

/**
 * 遍历页面 <script> 抠数据。
 * 注意：content script 在隔离世界，读不到页面的 window.ytInitialPlayerResponse，
 * 但 DOM 是两个世界共享的，所以只能走 <script> 文本正则（plan §5.1）。
 */
function extractFromDom(): YtPlayerResponse | null {
  for (const s of Array.from(document.querySelectorAll('script'))) {
    const pr = parsePlayerResponse(s.textContent || '');
    if (pr) return pr;
  }
  return null;
}

/** 当前 URL 的视频 ID（/watch?v=xxx） */
function currentVideoId(): string {
  try {
    return new URL(location.href).searchParams.get('v') || '';
  } catch {
    return '';
  }
}

/**
 * 拿「当前」视频的 playerResponse。
 * YouTube 站内点击切视频是 SPA 导航，页面不整刷，<script> 里可能还是上一个视频的数据：
 * 校验 videoDetails.videoId 与 URL 的 v 参数，不一致就同源 fetch(location.href)
 * 重新拿当前页 HTML 再正则一次（content script 同源无 CORS，plan §5.2）。
 * 两条路都失败返回 null，绝不拿旧视频数据充数。
 */
export async function getPlayerResponse(): Promise<YtPlayerResponse | null> {
  const wantId = currentVideoId();
  const fromDom = extractFromDom();
  if (fromDom && (!wantId || fromDom.videoDetails?.videoId === wantId)) {
    return fromDom;
  }
  try {
    const html = await (await fetch(location.href, { credentials: 'include' })).text();
    const pr = parsePlayerResponse(html);
    if (pr) return pr;
  } catch {
    // 走降级链
  }
  return null;
}

/** 轨道展示名：simpleText 或 runs 拼接，都没有就用语言码 */
function trackName(t: YtCaptionTrack): string {
  return (
    t.name?.simpleText ||
    (t.name?.runs || []).map((r) => r.text || '').join('') ||
    t.languageCode ||
    ''
  );
}

/** 列出当前视频所有字幕轨（UI 语言选择用） */
export async function listTracks(): Promise<CaptionTrackInfo[]> {
  const pr = await getPlayerResponse();
  const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  return tracks
    .filter((t) => !!t.baseUrl)
    .map((t) => ({ languageCode: t.languageCode || '', name: trackName(t) }));
}

/** 三级选轨：精确匹配 → 语言码前缀匹配（zh-Hans 命中 zh）→ 首条（plan §5.3） */
function pickTrack(tracks: YtCaptionTrack[], lang: string): YtCaptionTrack {
  const want = lang.toLowerCase();
  const prefix = want.split('-')[0];
  return (
    tracks.find((t) => t.languageCode?.toLowerCase() === want) ||
    tracks.find((t) => t.languageCode?.toLowerCase().startsWith(prefix)) ||
    tracks[0]
  );
}

/**
 * 抓当前视频字幕。
 * 无字幕轨 / fetch 失败 / 401 → 统一降级为 {degraded:true, title, description}
 * （标题+简介，plan §5.5），由 UI 明确提示，不静默失败。
 */
export async function getTranscript(lang = 'zh'): Promise<TranscriptResult> {
  const pr = await getPlayerResponse();
  const videoId = pr?.videoDetails?.videoId || currentVideoId();
  const title = pr?.videoDetails?.title || document.title;
  const degraded: TranscriptResult = {
    degraded: true,
    title,
    videoId,
    description: pr?.videoDetails?.shortDescription || '',
  };

  const tracks = (
    pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || []
  ).filter((t) => !!t.baseUrl);
  if (!tracks.length) return degraded; // 无字幕

  const track = pickTrack(tracks, lang);
  let data: Json3Response | null = null;
  try {
    const url = new URL(track.baseUrl!, location.origin);
    url.searchParams.set('fmt', 'json3');
    const res = await fetch(url.toString(), { credentials: 'include' });
    if (res.ok) data = (await res.json()) as Json3Response;
  } catch {
    data = null;
  }
  if (!data?.events?.length) return degraded; // 401 / 网络失败 / 格式不对

  // 拼 events[].segs[].utf8，保留 tStartMs 结构（plan §5.4），过滤空段、合并空白
  const segments: TranscriptSegment[] = data.events
    .map((e) => ({
      tStartMs: e.tStartMs ?? 0,
      text: (e.segs || [])
        .map((s) => s.utf8 || '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim(),
    }))
    .filter((s) => s.text.length > 0);
  const transcript = segments.map((s) => s.text).join(' ').trim();
  if (!transcript) return degraded;

  return {
    degraded: false,
    title,
    videoId,
    transcript,
    segments,
    track: { languageCode: track.languageCode || '', name: trackName(track) },
  };
}
