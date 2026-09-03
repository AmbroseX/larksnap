import { feishuGet } from './request';

/**
 * 批量补拉 client_vars 的被跳过子树 —— **运行在 content script（飞书页面上下文）**。
 *
 * 首屏会把表格等大块的子树列进 skip_blocks 不下发，要按 block_id 用 mode=4 补拉，
 * 每个子树内部还要按 has_more 一页页翻。表格多的文档这里能翻出上百个请求
 * （实测一篇 13 个子树翻出 161 个请求）。
 *
 * 这段整体放在 content 侧、而不是让 SW 逐个请求经 FEISHU_REQUEST 代发，是因为
 * 后者等于上百次 SW ⇄ content 往返，光往返开销就能把 MV3 Service Worker 的
 * 30 秒空闲回收线撞爆（症状：随机报 Failed to fetch / 消息通道关闭 / 打开文档超时）。
 * 详见 docs/plans/2026-09-03-大表格文档抓取超时修复.md。
 *
 * 职责边界：这里**只负责把页拉回来**，不做合并。合并（children 取并集）仍由 SW 的
 * mergeBlockMap 统一做，避免两边各写一份将来走岔。
 */

/** 补拉的总块数上限（与原 SW 串行版语义一致，防止异常文档无限补） */
const MAX_BLOCKS = 50;
/** 单个子树的翻页次数上限 */
const MAX_PAGES_PER_SUBTREE = 50;
/** 子树之间的并发度：§8 风控，media-util 默认上限是 3，这里同量级，别再调高 */
const CONCURRENCY = 4;

export interface SubtreeRequest {
  objToken: string;
  /** wiki 容器参数串（直链 docx 为空串），由 SW 拼好传入 */
  wikiPart: string;
  /** 首屏拿到的 skip_blocks */
  blockIds: string[];
}

export interface SubtreeResult {
  /** 每一页原样的 block_map，按拉回顺序；合并交给 SW */
  pages: Record<string, unknown>[];
  /** 实际发出的请求数（诊断用） */
  requests: number;
  /** 是否撞到 MAX_BLOCKS 上限（撞到说明可能没补全，SW 侧据此提示） */
  truncated: boolean;
}

export async function fetchSubtrees(req: SubtreeRequest): Promise<SubtreeResult> {
  const { objToken, wikiPart } = req;
  const pending = [...(req.blockIds ?? []).map(String)];
  const done = new Set<string>();
  const pages: Record<string, unknown>[] = [];
  let requests = 0;
  let truncated = false;

  /** 取下一个待补块；没有可取或已达上限返回 undefined */
  const nextBlockId = (): string | undefined => {
    while (pending.length) {
      if (done.size >= MAX_BLOCKS) {
        truncated = true;
        return undefined;
      }
      const bid = pending.shift()!;
      if (done.has(bid)) continue;
      done.add(bid);
      return bid;
    }
    return undefined;
  };

  /** 单个子树：内部按 cursor 串行翻页（有前后依赖，并发不了） */
  const drain = async (bid: string): Promise<void> => {
    let cursor = '';
    let more = true;
    let guard = 0;
    while (more && guard < MAX_PAGES_PER_SUBTREE) {
      guard++;
      const page = (await feishuGet(
        `/space/api/docx/pages/client_vars?id=${objToken}&mode=4&block_id=${bid}&cursor=${encodeURIComponent(
          cursor
        )}&limit=239${wikiPart}`
      )) as { data?: Record<string, unknown> };
      requests++;
      const pd = (page.data ?? {}) as Record<string, unknown>;
      pages.push((pd.block_map ?? {}) as Record<string, unknown>);
      // 子树里可能还有下一层被跳过的块，入队继续补（其他 worker 也能取走）
      for (const s of (pd.skip_blocks as string[]) ?? []) {
        if (!done.has(String(s))) pending.push(String(s));
      }
      more = Boolean(pd.has_more);
      cursor = (pd.cursor as string) ?? '';
      if (!cursor) break;
    }
  };

  const worker = async (): Promise<void> => {
    for (let bid = nextBlockId(); bid !== undefined; bid = nextBlockId()) {
      await drain(bid);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  return { pages, requests, truncated };
}
