/** chrome.downloads 落盘封装（产物只落本地，绝不外发——宪法原则 V） */

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
