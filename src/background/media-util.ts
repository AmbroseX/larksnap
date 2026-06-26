import { driveStreamHost } from '../shared/feishu-host';

/** base64 → Uint8Array（供 zip 写入二进制） */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** ArrayBuffer → base64（分块，避免栈溢出） */
export function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk))
    );
  }
  return btoa(binary);
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'application/pdf': 'pdf',
};

/** 由 mimeType + 文件名推断扩展名 */
export function extFromMime(mimeType: string, name = ''): string {
  if (MIME_EXT[mimeType]) return MIME_EXT[mimeType];
  const m = name.match(/\.([a-zA-Z0-9]{1,6})$/);
  if (m) return m[1].toLowerCase();
  const sub = mimeType.split('/')[1];
  return sub ? sub.replace(/[^a-z0-9]/gi, '') : 'bin';
}

/**
 * 媒体下载候选 URL（按序尝试,§7 + 真机 HAR 实测）。
 *
 * ⚠️ 关键:`mount_node_token` 是**素材所在块的 id**(dox…),不是文档 obj_token。
 * 图片:先试 download/all(原图),再退 download/v2/cover(页面实测可用,按自然宽高取全分辨率)。
 * 文件:download/all。下载域 `internal-api-drive-stream.{基础域}` 由 host 推导,不写死。
 */
export function mediaDownloadUrls(
  host: string,
  token: string,
  mountToken: string,
  opts: { isImage?: boolean; width?: number; height?: number } = {}
): string[] {
  const ds = driveStreamHost(host);
  const mnt = encodeURIComponent(mountToken);
  const all = `https://${ds}/space/api/box/stream/download/all/${token}/?mount_node_token=${mnt}`;
  if (!opts.isImage) return [all];
  const w = opts.width && opts.width > 0 ? opts.width : 2560;
  const h = opts.height && opts.height > 0 ? opts.height : 2560;
  const cover = `https://${ds}/space/api/box/stream/download/v2/cover/${token}/?fallback_source=1&height=${h}&mount_node_token=${mnt}&mount_point=docx_image&policy=equal&width=${w}`;
  return [all, cover];
}

/** 导出任务产物(file_token)的下载 URL（download/all，mount 用文档 token） */
export function exportFileUrls(
  host: string,
  fileToken: string,
  docToken: string
): string[] {
  return [
    `https://${driveStreamHost(host)}/space/api/box/stream/download/all/${fileToken}/?mount_node_token=${encodeURIComponent(
      docToken
    )}`,
  ];
}

/** 在线媒体 URL（link 模式 / 下载失败降级用）—— 用 cover(已登录浏览器可直接打开) */
export function onlineMediaUrl(
  host: string,
  token: string,
  mountToken: string,
  width?: number,
  height?: number
): string {
  return mediaDownloadUrls(host, token, mountToken, {
    isImage: true,
    width,
    height,
  }).slice(-1)[0];
}

/**
 * 并发执行（上限 limit，默认 3——§8 风控）。
 * 每项独立 try/catch，失败回 null，不拖垮整体（宪法原则 III）。
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void
): Promise<(R | null)[]> {
  const results: (R | null)[] = new Array(items.length).fill(null);
  let cursor = 0;
  let done = 0;
  const workers = new Array(Math.min(limit, items.length || 1))
    .fill(0)
    .map(async () => {
      while (cursor < items.length) {
        const i = cursor++;
        try {
          results[i] = await fn(items[i], i);
        } catch {
          results[i] = null;
        }
        done++;
        onProgress?.(done, items.length);
      }
    });
  await Promise.all(workers);
  return results;
}
