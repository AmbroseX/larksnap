/** chrome.downloads 落盘封装（产物只落本地，绝不外发——宪法原则 V） */

/**
 * 下载拦截 sink —— 桥接模式（CC 经原生宿主拉取）下，不落 chrome.downloads，
 * 而是把产物（data URL + 文件名）交给桥接回传给 CC。设为 null 即恢复正常落盘。
 * 所有导出器都经 downloadDataUrl/downloadBase64 出口，故此处单点拦截即可覆盖
 * markdown / pdf / html / attachments 四类。
 */
type DownloadSink = (artifact: { url: string; filename: string }) => void;
let _sink: DownloadSink | null = null;
export function setDownloadSink(sink: DownloadSink | null): void {
  _sink = sink;
}

// 控制字符（U+0000–U+001F 与 U+007F）：文件名里出现会被判非法
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');
const ILLEGAL_CHARS = /[\\/:*?"<>|]/g;

/**
 * 文件名清洗 —— chrome.downloads 对文件名很挑剔：控制字符、首尾空格/点、
 * 保留符号都会被判 "Invalid filename"。这里逐项剔除并兜底非空。
 */
export function safeName(name: string): string {
  let n = (name ?? '').toString();
  n = n.replace(CONTROL_CHARS, '');
  n = n.replace(ILLEGAL_CHARS, '_');
  n = n.replace(/\s+/g, ' '); // 合并空白
  n = n.replace(/^[.\s]+|[.\s]+$/g, ''); // 去首尾的点与空格
  n = n.slice(0, 100).trim();
  return n || 'feishu-doc';
}

/** 下载 data URL（文件名非法时兜底为时间戳名，保证一定能落盘） */
export async function downloadDataUrl(
  url: string,
  filename: string
): Promise<void> {
  if (_sink) {
    // 桥接模式：拦截产物交给 CC，不落本地下载目录
    _sink({ url, filename });
    return;
  }
  try {
    await chrome.downloads.download({ url, filename, saveAs: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/filename/i.test(msg)) {
      const ext = (filename.match(/\.[A-Za-z0-9]+$/) || [''])[0];
      await chrome.downloads.download({
        url,
        filename: `feishu-export-${Date.now()}${ext}`,
        saveAs: false,
      });
      return;
    }
    throw err;
  }
}

/** 下载 base64 二进制 */
export async function downloadBase64(
  base64: string,
  mimeType: string,
  filename: string
): Promise<void> {
  await downloadDataUrl(`data:${mimeType};base64,${base64}`, filename);
}
