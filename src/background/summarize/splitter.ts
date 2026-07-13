/**
 * 轻量递归字符切块（FR-007）：段落 → 句子 → 字符逐级降切，
 * 相邻块之间带 overlap 保住跨块上下文。纯函数零依赖，
 * 不引 langchain 全家桶（KISS/YAGNI，plan §4）。
 */

export interface SplitOptions {
  /** 单块最大字符数，默认 1000 */
  chunkSize?: number;
  /** 相邻块重叠字符数，默认 100 */
  overlap?: number;
}

/** 把长文切成不超过 chunkSize 的块；短文（≤chunkSize）原样返回单块 */
export function splitText(text: string, options: SplitOptions = {}): string[] {
  const chunkSize = options.chunkSize ?? 1000;
  const overlap = Math.min(options.overlap ?? 100, Math.floor(chunkSize / 2));
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  if (clean.length <= chunkSize) return [clean];

  const chunks: string[] = [];
  let buf = '';
  for (const piece of atomicPieces(clean, chunkSize)) {
    if (buf && buf.length + piece.length > chunkSize) {
      chunks.push(buf.trim());
      // 尾部 overlap 带进下一块，避免句子在块边界被腰斩后语义丢失
      buf = buf.slice(Math.max(0, buf.length - overlap));
    }
    buf += piece;
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks.filter((c) => c.length > 0);
}

/**
 * 把全文拆成都不超过 chunkSize 的最小片段：
 * 先按段落（空行）切，段落太长再按句子切，句子还太长按字符硬切。
 * 分隔符保留在片段尾部，拼块后仍是原文。
 */
function atomicPieces(text: string, chunkSize: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/(?<=\n\n)/)) {
    if (para.length <= chunkSize) {
      out.push(para);
      continue;
    }
    for (const sentence of para.split(/(?<=[。！？!?.;；\n])/)) {
      if (sentence.length <= chunkSize) {
        out.push(sentence);
        continue;
      }
      for (let i = 0; i < sentence.length; i += chunkSize) {
        out.push(sentence.slice(i, i + chunkSize));
      }
    }
  }
  return out;
}
