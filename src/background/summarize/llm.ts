import type { AiConfig } from '../../shared/types';
import { t } from '../../shared/i18n';
import { isContextOverflowError } from './tokens';

/**
 * OpenAI 兼容客户端（FR-003/FR-005，007 增加流式）：
 *   - 只 fetch 用户在设置页自填的 baseUrl，零硬编码第三方端点（宪法 V）。
 *   - 发请求前先 permissions.contains 校验端点 origin 的运行时授权（plan §5.8）。
 *   - 错误分类：Key 无效 / 超时 / 网络失败 / 上下文溢出 / 用户停止 / 响应不兼容。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type LlmErrorKind =
  | 'no-permission'
  | 'auth'
  | 'timeout'
  | 'network'
  | 'bad-response'
  /** 上下文溢出（4xx + 关键字）：首轮可自动降级切块 */
  | 'overflow'
  /** 调用方主动 abort（用户停止 / 关侧边栏），不是故障 */
  | 'aborted';

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

/** 请求超时（毫秒）。流式下作「空闲超时」：每收到一段数据就重新计时 */
const REQUEST_TIMEOUT_MS = 120_000;

/** 端点根地址 → /v1/chat/completions 完整地址（用户可能已带 /v1，别拼重） */
export function chatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

// ==================== SSE 解析（纯函数，配单测） ====================

/** 跨 chunk 的解析状态：reader 可能把一行 `data:` 切成两半，尾巴留到下一轮拼 */
export interface SseState {
  buf: string;
}

/**
 * 喂入一段已解码文本，吐出完整行里的 data 载荷。
 * 兼容 \n 与 \r\n；`data: [DONE]` 置 done；未完整的尾行留在 state.buf。
 */
export function parseSse(
  state: SseState,
  text: string
): { payloads: string[]; done: boolean } {
  state.buf += text;
  const lines = state.buf.split(/\r?\n/);
  state.buf = lines.pop() ?? '';
  const payloads: string[] = [];
  let done = false;
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === '[DONE]') {
      done = true;
      break;
    }
    payloads.push(payload);
  }
  return { payloads, done };
}

/** 从一条 data 载荷里取增量文本；解析失败或无内容返回空串 */
export function extractDelta(payload: string): string {
  try {
    const obj = JSON.parse(payload) as {
      choices?: Array<{ delta?: { content?: string } }>;
    };
    return obj.choices?.[0]?.delta?.content ?? '';
  } catch {
    return '';
  }
}

// ==================== 请求公共部分 ====================

/** 端点 origin 必须已经过用户手势运行时授权（保存设置时授的，FR-005） */
async function ensurePermission(ai: AiConfig): Promise<void> {
  let origin: string;
  try {
    origin = new URL(ai.baseUrl).origin;
  } catch {
    throw new LlmError(t('bg.aiInvalidUrl'), 'bad-response');
  }
  const granted = await chrome.permissions
    .contains({ origins: [`${origin}/*`] })
    .catch(() => false);
  if (!granted) {
    throw new LlmError(t('bg.llmNotAuthorized'), 'no-permission');
  }
}

/** 非 2xx 响应 → 分类错误（读一次报文文本判上下文溢出） */
async function badResponseError(res: globalThis.Response): Promise<LlmError> {
  if (res.status === 401 || res.status === 403) {
    return new LlmError(t('bg.llmAuth'), 'auth');
  }
  const body = await res.text().catch(() => '');
  if (isContextOverflowError(res.status, body)) {
    return new LlmError(t('bg.llmOverflow'), 'overflow');
  }
  return new LlmError(t('bg.llmBadStatus', { status: res.status }), 'bad-response');
}

/** fetch/reader 抛出的异常 → 分类：调用方 abort / 超时 / 网络 */
function throwAsLlmError(e: unknown, external?: AbortSignal, timedOut?: boolean): never {
  if (e instanceof LlmError) throw e;
  if (external?.aborted) throw new LlmError(t('bg.llmAborted'), 'aborted');
  if (timedOut || (e instanceof DOMException && e.name === 'TimeoutError')) {
    throw new LlmError(t('bg.llmTimeout'), 'timeout');
  }
  throw new LlmError(t('bg.llmNetwork'), 'network');
}

function requestInit(ai: AiConfig, stream: boolean, messages: ChatMessage[]): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ai.apiKey}`,
    },
    body: JSON.stringify({
      model: ai.model,
      messages,
      temperature: 0.3,
      stream,
    }),
  };
}

// ==================== 非流式（切块 refine 的中间块用） ====================

/** 调一次 chat/completions，返回首个 choice 的文本 */
export async function chatComplete(
  ai: AiConfig,
  messages: ChatMessage[],
  signal?: AbortSignal
): Promise<string> {
  await ensurePermission(ai);

  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let res: globalThis.Response;
  try {
    res = await fetch(chatCompletionsUrl(ai.baseUrl), {
      ...requestInit(ai, false, messages),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
  } catch (e) {
    throwAsLlmError(e, signal);
  }

  if (!res.ok) throw await badResponseError(res);

  const data = (await res.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>;
  } | null;
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new LlmError(t('bg.llmEmpty'), 'bad-response');
  }
  return content.trim();
}

// ==================== 流式（007，对话页主路径） ====================

/**
 * 流式调用：SSE 逐段回调 onDelta，返回完整文本。
 * signal 由调用方传入（用户停止 / Port 断连），与空闲超时合并到同一个内部 controller。
 */
export async function chatCompleteStream(
  ai: AiConfig,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  signal?: AbortSignal
): Promise<string> {
  await ensurePermission(ai);

  const ctrl = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const armIdle = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, REQUEST_TIMEOUT_MS);
  };
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  if (signal?.aborted) ctrl.abort();
  armIdle();

  try {
    let res: globalThis.Response;
    try {
      res = await fetch(chatCompletionsUrl(ai.baseUrl), {
        ...requestInit(ai, true, messages),
        signal: ctrl.signal,
      });
    } catch (e) {
      throwAsLlmError(e, signal, timedOut);
    }

    if (!res.ok) throw await badResponseError(res);
    if (!res.body) throw new LlmError(t('bg.llmEmpty'), 'bad-response');

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const state: SseState = { buf: '' };
    let full = '';
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (e) {
        throwAsLlmError(e, signal, timedOut);
      }
      if (chunk.done) break;
      armIdle();
      const { payloads, done } = parseSse(state, decoder.decode(chunk.value, { stream: true }));
      for (const p of payloads) {
        const delta = extractDelta(p);
        if (delta) {
          full += delta;
          onDelta(delta);
        }
      }
      if (done) break;
    }

    if (!full.trim()) throw new LlmError(t('bg.llmEmpty'), 'bad-response');
    return full.trim();
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
