import type { MediaAsset } from '../shared/types';
import { downloadMedia } from './feishu-proxy';
import { mediaDownloadUrls, mapWithConcurrency } from './media-util';

/**
 * 批量下载图片 → token→dataURL 映射（HTML 导出与小红书卡片共用，§十-5）。
 *
 * 失败项为 null，降级策略由调用方决定：HTML 可退在线 URL；
 * 卡片导出绝不能退在线 URL（会污染 canvas，toDataURL 直接抛错），只能画占位灰块。
 */
export async function downloadImageDataUrls(
  host: string,
  images: MediaAsset[],
  onProgress?: (done: number, total: number) => void
): Promise<Record<string, string | null>> {
  // 同一图片可能在文档里出现多次，按 token 去重后再下
  const unique: MediaAsset[] = [];
  const seen = new Set<string>();
  for (const img of images) {
    if (seen.has(img.token)) continue;
    seen.add(img.token);
    unique.push(img);
  }

  const results = await mapWithConcurrency(
    unique,
    3,
    async (img) => {
      const blob = await downloadMedia(
        mediaDownloadUrls(host, img.token, img.mountToken, {
          isImage: true,
          width: img.width,
          height: img.height,
        })
      );
      return `data:${blob.mimeType || img.mimeType || 'image/png'};base64,${blob.base64}`;
    },
    onProgress
  );

  const map: Record<string, string | null> = {};
  unique.forEach((img, i) => {
    map[img.token] = results[i];
  });
  return map;
}

/**
 * 单趟把正文里所有 `feishu-asset://<token>` 换成 resolve 给的地址，没给的原样保留。
 * 以前是逐图 split/join：每换一张都把整段正文复制一遍，正文又随内联图片越来越大，
 * 几百张图就是几十 GB 的字符串复制，SW 在这段同步里什么都响应不了（issue #9）。
 */
export function replaceAssetRefs(
  body: string,
  resolve: (token: string) => string | undefined
): string {
  // token 实测是 base62（boxcn… / boxrz…），但私有化部署没有保证，所以吃到属性引号 / 空白 / 标签符为止
  return body.replace(/feishu-asset:\/\/([^"'\s<>)]+)/g, (m, token: string) => resolve(token) ?? m);
}
