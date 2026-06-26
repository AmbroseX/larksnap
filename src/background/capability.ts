import type { MarkdownCapability } from '../shared/types';
import {
  getMarkdownCapability,
  setMarkdownCapability,
  clearMarkdownCapability,
} from '../shared/storage';

/**
 * Markdown 导出能力（按 host）—— 决定走 P-official 还是 P-decode（§5.1）。
 *
 * 探测采用"乐观尝试 + 失败降级"：真正的探测发生在 exporters/markdown.ts 第一次
 * 尝试官方导出时；这里只负责按 host 读/写/失效结论，避免每次重复一次失败往返。
 */

/** 读缓存结论（未探测过返回 null） */
export async function getCapability(
  host: string
): Promise<MarkdownCapability | null> {
  return getMarkdownCapability(host);
}

/** 记录：本 host 支持官方 md 导出 */
export async function recordSupported(host: string): Promise<void> {
  await setMarkdownCapability({
    host,
    mdExportSupported: true,
    checkedAt: Date.now(),
  });
}

/** 记录：本 host 不支持官方 md 导出（回退 P-decode） */
export async function recordUnsupported(host: string): Promise<void> {
  await setMarkdownCapability({
    host,
    mdExportSupported: false,
    checkedAt: Date.now(),
  });
}

/** 失效结论（P-official 运行期再次失败时重测） */
export async function invalidate(host: string): Promise<void> {
  await clearMarkdownCapability(host);
}
