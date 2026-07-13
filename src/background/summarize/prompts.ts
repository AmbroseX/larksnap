import type { ChatMessage } from './llm';

/**
 * 总结 prompt（plan §5.7，通用版照抄研究文档 §三 的 Glarity 逆向结论）。
 * 输出语言跟随用户设置的 targetLang；视频章节时间戳版留 P2（YAGNI）。
 */

/** 系统提示：定角色 + 定输出语言与格式 */
function systemPrompt(targetLang: string): ChatMessage {
  return {
    role: 'system',
    content:
      'You are a helpful assistant that summarizes web articles and video transcripts. ' +
      `Always reply in ${targetLang} using Markdown.`,
  };
}

/** 首块 / 短内容：直接总结（简述 + emoji 要点列表） */
export function buildSummaryMessages(content: string, targetLang: string): ChatMessage[] {
  return [
    systemPrompt(targetLang),
    {
      role: 'user',
      content:
        'Summarize the following CONTENT into brief sentences of key points, ' +
        'then provide complete highlighted information in a list, ' +
        'choosing an appropriate emoji for each highlight.\n\n' +
        `CONTENT:\n${content}`,
    },
  ];
}

/** 后续块：refine 累进精炼——拿「已有总结 + 新块」更新总结，不是简单 map-reduce */
export function buildRefineMessages(
  existingSummary: string,
  newChunk: string,
  targetLang: string
): ChatMessage[] {
  return [
    systemPrompt(targetLang),
    {
      role: 'user',
      content:
        'We have an existing summary of the earlier part of the content:\n\n' +
        `${existingSummary}\n\n` +
        'Below is the next part of the content. Refine the existing summary with it: ' +
        'keep the same structure (brief key points, then a highlight list with an emoji per item), ' +
        'merge new information, and drop nothing important. ' +
        'If the new part adds nothing useful, return the existing summary unchanged.\n\n' +
        `NEW CONTENT:\n${newChunk}`,
    },
  ];
}
