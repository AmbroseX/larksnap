import type {
  Response,
  SummaryNeedsAck,
  SummaryResult,
  WebCopyMdResult,
  WebCopyNeedsPermission,
} from '../../shared/types';
import { getConfig } from '../../shared/storage';
import { t } from '../../shared/i18n';
import { reportProgress } from '../progress';
import { isRestrictedUrl, isYoutubeWatchUrl } from '../../shared/page-kind';
import { webcopyPageMd } from '../webcopy';
import { fetchTranscriptFromTab } from '../exporters/transcript';
import { splitText } from './splitter';
import { chatComplete, LlmError } from './llm';
import { buildRefineMessages, buildSummaryMessages } from './prompts';
import { estimateTokens, PROMPT_RESERVE, refineChunkChars, TOKEN_BUDGET } from './tokens';

/**
 * AI 总结编排（US2/US3，FR-003/004/007/008）：
 *   校验配置与首次告知 → 取材（YouTube 字幕 / webcopy 正文）→ 切块 →
 *   refine 逐块精炼 → 结果推回侧边栏。
 * 未配置端点时不发任何网络请求；内容只发往用户自配的 baseUrl。
 */

/** SUMMARIZE_PAGE 可能的三种响应数据 */
export type SummarizeData = SummaryResult | SummaryNeedsAck | WebCopyNeedsPermission;

/** 取材结果：来源枚举只用于统计与提示，不含 URL（007 起被 chat-port 复用） */
export interface SourceMaterial {
  kind: 'youtube' | 'page';
  title: string;
  text: string;
  /** 降级提示（如「无字幕，用标题+简介总结」），拼进产物开头明示用户 */
  note?: string;
}

/** 总结目标页：由调用方在触发瞬间捕获（006：禁止在此重查活动页） */
export interface SummarizeTarget {
  tabId: number;
  url: string;
}

export async function summarizePage(target: SummarizeTarget): Promise<Response<SummarizeData>> {
  const config = await getConfig();
  const ai = config.ai;

  // ① 未配置端点 → 引导错误，绝不发请求（FR-003）
  if (!ai?.baseUrl || !ai.apiKey || !ai.model) {
    return {
      success: false,
      error: t('bg.aiNotConfigured'),
    };
  }

  // ② 已配置但首次使用未确认 → 返回 needsAck，由侧边栏弹一次性告知（FR-004）
  if (!ai.acknowledged) {
    let endpointOrigin = '';
    try {
      endpointOrigin = new URL(ai.baseUrl).origin;
    } catch {
      return { success: false, error: t('bg.aiInvalidUrl') };
    }
    return { success: true, data: { needsAck: true, endpointOrigin } };
  }

  await reportProgress('summarize', 'running', t('progress.summarize.extracting'));
  try {
    // ③ 取材：YouTube 页走字幕（降级用标题+简介）；普通页复用 webcopy 管线（FR-008）
    const source = await collectSource(ai.targetLang, target);
    if ('needsPermission' in source) {
      await reportProgress('summarize', 'error', t('bg.noPermission'));
      return {
        success: false,
        error: t('bg.noPermission'),
        data: source,
      };
    }

    const text = source.text.trim();
    if (!text) throw new Error(t('bg.nothingToSummarize'));

    // ④ token 预算内整篇直塞；超预算才切块 refine（007，评审阻断项 1）
    const budget = TOKEN_BUDGET - PROMPT_RESERVE;
    let chunks =
      estimateTokens(text) <= budget
        ? [text]
        : splitText(text, { chunkSize: refineChunkChars(), overlap: 500 });
    let summary = '';
    let doneChunks = 0;
    const runChunks = async () => {
      for (let i = doneChunks; i < chunks.length; i++) {
        await reportProgress(
          'summarize',
          'running',
          t('progress.summarize.chunk', { i: i + 1, n: chunks.length }),
          5 + Math.round((i / chunks.length) * 90)
        );
        summary =
          i === 0
            ? await chatComplete(ai, buildSummaryMessages(chunks[i], ai.targetLang))
            : await chatComplete(
                ai,
                buildRefineMessages(summary, chunks[i], ai.targetLang)
              );
        doneChunks = i + 1;
      }
    };
    try {
      try {
        await runChunks();
      } catch (err) {
        // 估算偏低被端点判溢出 → 自动降级切块重试一次，不直接报死
        if (err instanceof LlmError && err.kind === 'overflow' && chunks.length === 1) {
          chunks = splitText(text, { chunkSize: refineChunkChars(), overlap: 500 });
          summary = '';
          doneChunks = 0;
          await runChunks();
        } else {
          throw err;
        }
      }
    } catch (err) {
      // ⑤ 中途失败保留前面块的中间总结，标注不完整，不整体丢弃（宪法 III）
      if (doneChunks > 0 && summary) {
        const msg = err instanceof Error ? err.message : String(err);
        await reportProgress(
          'summarize',
          'error',
          t('progress.summarize.chunkFailed', {
            i: doneChunks + 1,
            n: chunks.length,
            msg,
            done: doneChunks,
          })
        );
        return {
          success: true,
          data: {
            markdown: buildResultMarkdown(source, summary, true),
            chunks: chunks.length,
            partial: true,
            kind: source.kind,
          },
        };
      }
      throw err;
    }

    await reportProgress('summarize', 'success', t('progress.summarize.done'), 100);
    return {
      success: true,
      data: {
        markdown: buildResultMarkdown(source, summary, false),
        chunks: chunks.length,
        kind: source.kind,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reportProgress('summarize', 'error', t('progress.summarize.failed', { msg }));
    return { success: false, error: msg };
  }
}

/** 取材：按页面类型选路。返回 needsPermission 时由侧边栏手势授权后重试（007 起被 chat-port 复用） */
export async function collectSource(
  targetLang: string,
  target: SummarizeTarget
): Promise<SourceMaterial | WebCopyNeedsPermission> {
  const { tabId, url } = target;
  if (isRestrictedUrl(url)) {
    throw new Error(t('bg.summaryRestricted'));
  }

  if (isYoutubeWatchUrl(url)) {
    const tr = await fetchTranscriptFromTab(tabId, targetLang);
    if (tr.degraded) {
      return {
        kind: 'youtube',
        title: tr.title,
        text: `${tr.title}\n\n${tr.description || ''}`.trim(),
        note: t('artifacts.summary.degradedNote'),
      };
    }
    return { kind: 'youtube', title: tr.title, text: tr.transcript || '' };
  }

  // 普通网页：复用现有 webcopy 提取管线（Readability + 兜底），零新提取代码
  const res = await webcopyPageMd(tabId, url);
  const fallback = res.data as WebCopyNeedsPermission | undefined;
  if (!res.success) {
    if (fallback?.needsPermission) return fallback;
    throw new Error(res.error || t('bg.extractFailed'));
  }
  const md = res.data as WebCopyMdResult;
  if (!md?.markdown) throw new Error(t('bg.extractEmpty'));
  return { kind: 'page', title: md.title || t('artifacts.summary.pageDefault'), text: md.markdown };
}

/** 拼最终 Markdown 产物：标题 + 降级/不完整标注 + 总结正文（可直接复制/写回飞书） */
function buildResultMarkdown(
  source: SourceMaterial,
  summary: string,
  partial: boolean
): string {
  const lines = [`# ${source.title} · ${t('artifacts.summary.titleSuffix')}`, ''];
  if (source.note) lines.push(`> ⚠️ ${source.note}`, '');
  if (partial) lines.push(t('artifacts.summary.partialNote'), '');
  lines.push(summary);
  return `${lines.join('\n')}\n`;
}
