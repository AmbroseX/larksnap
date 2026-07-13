import type { AiConfig } from '../../shared/types';
import { t } from '../../shared/i18n';

/**
 * OpenAI 兼容客户端（FR-003/FR-005）：
 *   - 只 fetch 用户在设置页自填的 baseUrl，零硬编码第三方端点（宪法 V）。
 *   - 发请求前先 permissions.contains 校验端点 origin 的运行时授权（plan §5.8）。
 *   - 错误分类：Key 无效 / 超时 / 网络失败 / 响应不兼容，UI 按类给可读提示。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type LlmErrorKind = 'no-permission' | 'auth' | 'timeout' | 'network' | 'bad-response';

/** 带分类的 LLM 错误，UI 据 kind 给不同引导文案 */
export class LlmError extends Error {
  constructor(
    message: string,
    public readonly kind: LlmErrorKind
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** 单次请求超时（毫秒）：总结单块通常几十秒内，2 分钟兜底 */
const REQUEST_TIMEOUT_MS = 120_000;

/** 端点根地址 → /v1/chat/completions 完整地址（用户可能已带 /v1，别拼重） */
export function chatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

/** 调一次 chat/completions，返回首个 choice 的文本 */
export async function chatComplete(ai: AiConfig, messages: ChatMessage[]): Promise<string> {
  let origin: string;
  try {
    origin = new URL(ai.baseUrl).origin;
  } catch {
    throw new LlmError(t('bg.aiInvalidUrl'), 'bad-response');
  }

  // 端点 origin 必须已经过用户手势运行时授权（保存设置时授的，FR-005）
  const granted = await chrome.permissions
    .contains({ origins: [`${origin}/*`] })
    .catch(() => false);
  if (!granted) {
    throw new LlmError(t('bg.llmNotAuthorized'), 'no-permission');
  }

  let res: globalThis.Response;
  try {
    res = await fetch(chatCompletionsUrl(ai.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ai.apiKey}`,
      },
      body: JSON.stringify({
        model: ai.model,
        messages,
        temperature: 0.3,
        stream: false,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'TimeoutError') {
      throw new LlmError(t('bg.llmTimeout'), 'timeout');
    }
    throw new LlmError(t('bg.llmNetwork'), 'network');
  }

  if (res.status === 401 || res.status === 403) {
    throw new LlmError(t('bg.llmAuth'), 'auth');
  }
  if (!res.ok) {
    throw new LlmError(t('bg.llmBadStatus', { status: res.status }), 'bad-response');
  }

  const data = (await res.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>;
  } | null;
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new LlmError(t('bg.llmEmpty'), 'bad-response');
  }
  return content.trim();
}
