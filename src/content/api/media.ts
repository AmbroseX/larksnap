/** 媒体下载结果（二进制以 base64 回传 SW 打包） */
export interface MediaBlob {
  base64: string;
  mimeType: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ArrayBuffer → base64（分块避免栈溢出） */
function bufToBase64(buf: ArrayBuffer): string {
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

/**
 * 媒体下载回退（content 同源 fetch，按候选 URL 逐个试）。
 *
 * 注意:MV3 下 content 跨子域(drive-stream)受 CORS 限制,多数情况会失败,
 * 真正可靠的是 SW 直发(feishu-proxy)。此处仅作回退,覆盖同源/特殊部署。
 */
export async function downloadMediaByUrls(urls: string[]): Promise<MediaBlob> {
  let lastErr: unknown;
  for (const url of urls) {
    for (let i = 0; i < 2; i++) {
      try {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const mimeType =
          res.headers.get('content-type') || 'application/octet-stream';
        if (/application\/json/i.test(mimeType)) throw new Error('返回 JSON 非二进制');
        const buf = await res.arrayBuffer();
        if (buf.byteLength === 0) throw new Error('空响应');
        return { base64: bufToBase64(buf), mimeType };
      } catch (err) {
        lastErr = err;
        await sleep(300 * (i + 1));
      }
    }
  }
  console.warn('[feishu2md] content 媒体下载失败:', lastErr);
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
