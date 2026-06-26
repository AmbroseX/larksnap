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
    zip.file(f.path, f.content as string | ArrayBuffer | Uint8Array);
  }
  const base64 = await zip.generateAsync({
    type: 'base64',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  return `data:application/zip;base64,${base64}`;
}
