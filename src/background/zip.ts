import JSZip from 'jszip';

/** zip 内单个文件项 */
export interface ZipFile {
  /** zip 内相对路径，如 `assets/boxxx.png` 或 `文档.md` */
  path: string;
  /** 文本内容或二进制内容 */
  content: string | Uint8Array | ArrayBuffer;
}

/**
 * 打包为 zip，返回 data URL（供 chrome.downloads.download）。
 *
 * 封装隔离 zip 实现：当前用 JSZip；若日后离线无法依赖，可替换为自研
 * store-zip 而不影响调用方（见 research §8）。
 */
export async function createZipDataUrl(files: ZipFile[]): Promise<string> {
  const zip = new JSZip();
  for (const f of files) {
    zip.file(f.path, f.content as string | ArrayBuffer | Uint8Array, {
      compression: compressionFor(f.path),
    });
  }
  const base64 = await zip.generateAsync({
    type: 'base64',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  return `data:application/zip;base64,${base64}`;
}

/** 本身已经是压缩格式的文件：再 DEFLATE 一遍只费 CPU 不省空间 */
const ALREADY_COMPRESSED = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'heic',
  'pdf', 'zip', 'rar', '7z', 'gz',
  'mp4', 'mov', 'mp3', 'm4a',
  'docx', 'xlsx', 'pptx',
]);

/**
 * 按文件后缀选 zip 内的压缩方式：图片/PDF/视频/Office 文档本身已压缩，用 STORE 直接存；
 * 文本类（md、txt、svg、csv…）和不认识的后缀仍用 DEFLATE。
 * 几百张图的文档打包时间从几十秒降到算一遍 CRC32 的时间，见 issue #9。
 */
export function compressionFor(path: string): 'STORE' | 'DEFLATE' {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return 'DEFLATE';
  const ext = path.slice(dot + 1).toLowerCase();
  return ALREADY_COMPRESSED.has(ext) ? 'STORE' : 'DEFLATE';
}

/** 进度文案用的 MB 数（一位小数） */
export function megabytesOf(files: ZipFile[]): string {
  return (totalBytes(files) / 1048576).toFixed(1);
}

/** zip 内文件总字节数（字符串按 UTF-16 粗估，每字符两字节），只用于进度文案 */
export function totalBytes(files: ZipFile[]): number {
  let n = 0;
  for (const f of files) {
    const c = f.content;
    if (typeof c === 'string') n += c.length * 2;
    else n += c.byteLength;
  }
  return n;
}
