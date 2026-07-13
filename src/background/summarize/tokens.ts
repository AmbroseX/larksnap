import type { ChatMsg } from '../../shared/types';

/**
 * token 预算估算与历史裁剪（007，全纯函数）。
 * 固定字符阈值不安全：中文接近一字一 token，60k 字符可能远超小上下文端点。
 * 这里统一用「CJK 记 1、其余 4 字符 ≈ 1」的保守估算，故意偏高——
 * 宁可提前切块/裁剪，也不把请求撑爆。
 */

/** 单轮请求（messages 总量）的 token 预算，超出即切块或裁剪历史 */
export const TOKEN_BUDGET = 24_000;

/** 预算里预留给 system 提示、指令模板与结构开销的份额 */
export const PROMPT_RESERVE = 1_000;

/** CJK 与全角标点区段（含日韩，逐字符判断） */
const CJK_RE = /[⺀-鿿豈-﫿가-힯　-〿＀-￯]/;

/** 估算一段文本的 token 数（CJK 一字一 token，其余 4 字符 ≈ 1 token，向上取整） */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}

/** 估算 messages 总 token（每条加 4 的角色/分隔结构开销，与 OpenAI 计法同阶） */
export function estimateMessagesTokens(messages: ReadonlyArray<{ content: string }>): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}

/** 切块 refine 路径的单块字符数：按预算折算（CJK 下 1 字符 ≈ 1 token，取一半留给已有总结与模板） */
export function refineChunkChars(budget: number = TOKEN_BUDGET): number {
  return Math.max(2_000, Math.floor(budget / 2));
}

/**
 * 追问前的历史裁剪。规则（依序执行，直到装进预算）：
 *   ① 首轮取材全文（kind='source'）替换为它后面第一条 assistant 总结（原文已省略），
 *      并删除那条被并入的总结，避免内容重复；
 *   ② 从最旧的追问轮开始成对丢弃；
 *   ③ 首条上下文与最后一条永不丢；system 不在此数组里，天然不受影响。
 * 全部裁完仍超预算时原样返回（照发，溢出由端点错误路径兜底）。
 */
export function trimHistoryToBudget(messages: ChatMsg[], budget: number): ChatMsg[] {
  if (estimateMessagesTokens(messages) <= budget) return messages;

  let out = messages.slice();

  // ① 源全文 → 既有总结
  const srcIdx = out.findIndex((m) => m.kind === 'source');
  if (srcIdx >= 0) {
    const sumIdx = out.findIndex((m, i) => i > srcIdx && m.role === 'assistant');
    if (sumIdx > srcIdx) {
      const replaced: ChatMsg = {
        role: 'user',
        content:
          'The original content is omitted for length. Here is the existing summary of it:\n\n' +
          out[sumIdx].content,
      };
      out = [
        ...out.slice(0, srcIdx),
        replaced,
        ...out.slice(srcIdx + 1, sumIdx),
        ...out.slice(sumIdx + 1),
      ];
    }
  }

  // ② 从最旧追问轮成对丢弃，保住首条上下文与最后一条
  while (estimateMessagesTokens(out) > budget && out.length > 2) {
    out.splice(1, Math.min(2, out.length - 2));
  }
  return out;
}

/**
 * 端点报文是否为「上下文溢出」类错误（4xx + 关键字），命中则自动降级切块。
 * 只看 4xx：5xx 是端点自身问题，重试切块无意义。
 */
export function isContextOverflowError(status: number, body: string): boolean {
  if (status < 400 || status >= 500) return false;
  return /context|maximum|token|length|too\s*long/i.test(body);
}
