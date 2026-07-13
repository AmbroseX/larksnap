import type {
  AiConfig,
  ChatClientMsg,
  ChatMsg,
  ChatServerMsg,
  ChatSession,
  ChatSessionMeta,
  Response,
  SummaryNeedsAck,
  SummaryPrepared,
  WebCopyNeedsPermission,
} from '../../shared/types';
import { CHAT_PORT_NAME, STORAGE_KEYS } from '../../shared/constants';
import { getConfig } from '../../shared/storage';
import { t } from '../../shared/i18n';
import { track } from '../analytics';
import { collectSource, type SourceMaterial, type SummarizeTarget } from './index';
import { chatComplete, chatCompleteStream, LlmError, type ChatMessage } from './llm';
import { buildRefineMessages, buildSummaryMessages, chatSystemPrompt, wrapSourceContent } from './prompts';
import { estimateTokens, PROMPT_RESERVE, refineChunkChars, TOKEN_BUDGET, trimHistoryToBudget } from './tokens';
import { splitText } from './splitter';

/**
 * AI 对话页服务端（007）：
 *   - prepare（普通消息）：配置/首次确认检查 + 取材缓存，权限确认留给 UI 手势；
 *   - Port 流式：requestId 编排，delta/done/error 只发给发起的连接；
 *   - 会话落盘只在终态（done/stop/error），按字节配额裁最旧。
 */

// ==================== prepare：取材缓存 ====================

interface PendingSource {
  material: SourceMaterial;
  target: SummarizeTarget;
  createdAt: number;
}

/** 取材缓存：prepare 与 start-summary 之间的接力（SW 内存，5 分钟过期） */
const pendingSources = new Map<string, PendingSource>();
const SOURCE_TTL_MS = 5 * 60_000;

function pruneSources(): void {
  const now = Date.now();
  for (const [id, p] of pendingSources) {
    if (now - p.createdAt > SOURCE_TTL_MS) pendingSources.delete(id);
  }
}

/** SUMMARIZE_PREPARE：配置检查 → 取材 → 缓存。needsPermission 沿用统一信封由 UI 手势授权后重试 */
export async function prepareSummarize(
  target: SummarizeTarget
): Promise<Response<SummaryPrepared | SummaryNeedsAck | WebCopyNeedsPermission>> {
  const config = await getConfig();
  const ai = config.ai;
  if (!ai?.baseUrl || !ai.apiKey || !ai.model) {
    return { success: false, error: t('bg.aiNotConfigured') };
  }
  if (!ai.acknowledged) {
    let endpointOrigin = '';
    try {
      endpointOrigin = new URL(ai.baseUrl).origin;
    } catch {
      return { success: false, error: t('bg.aiInvalidUrl') };
    }
    return { success: true, data: { needsAck: true, endpointOrigin } };
  }

  try {
    const source = await collectSource(ai.targetLang, target);
    if ('needsPermission' in source) {
      return { success: false, error: t('bg.noPermission'), data: source };
    }
    const text = source.text.trim();
    if (!text) return { success: false, error: t('bg.nothingToSummarize') };

    pruneSources();
    const sourceId = crypto.randomUUID();
    pendingSources.set(sourceId, { material: { ...source, text }, target, createdAt: Date.now() });
    return {
      success: true,
      data: {
        sourceId,
        title: source.title,
        sourceKind: source.kind,
        chars: text.length,
        note: source.note,
      },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ==================== 会话存取（storage.session + 字节配额） ====================

const MAX_SESSIONS = 20;
/** 序列化总字节上限（UTF-16 码元数近似），超出从最旧会话裁 */
const MAX_BYTES = 1_500_000;

async function loadSessions(): Promise<ChatSession[]> {
  try {
    const got = await chrome.storage.session.get(STORAGE_KEYS.CHAT_SESSIONS);
    const list = got[STORAGE_KEYS.CHAT_SESSIONS];
    if (!Array.isArray(list)) return [];
    return list.filter(
      (s): s is ChatSession =>
        !!s && typeof s.id === 'string' && Array.isArray(s.messages)
    );
  } catch {
    return [];
  }
}

/** 落盘：条数上限 → 字节配额裁最旧 → 配额错误再裁一次 → 兜底只留最新 */
async function persistSessions(list: ChatSession[]): Promise<void> {
  let out = [...list].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS);
  while (out.length > 1 && JSON.stringify(out).length > MAX_BYTES) {
    out.pop();
  }
  try {
    await chrome.storage.session.set({ [STORAGE_KEYS.CHAT_SESSIONS]: out });
  } catch {
    out = out.slice(0, Math.max(1, Math.floor(out.length / 2)));
    await chrome.storage.session
      .set({ [STORAGE_KEYS.CHAT_SESSIONS]: out })
      .catch(() =>
        chrome.storage.session
          .set({ [STORAGE_KEYS.CHAT_SESSIONS]: out.slice(0, 1) })
          .catch(() => undefined)
      );
  }
}

async function saveSession(session: ChatSession): Promise<void> {
  const list = await loadSessions();
  const idx = list.findIndex((s) => s.id === session.id);
  if (idx >= 0) list[idx] = session;
  else list.unshift(session);
  await persistSessions(list);
}

export async function listChatSessions(): Promise<Response<ChatSessionMeta[]>> {
  const list = await loadSessions();
  return {
    success: true,
    data: list
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ id, title, sourceKind, updatedAt }) => ({ id, title, sourceKind, updatedAt })),
  };
}

export async function getChatSession(id: string): Promise<Response<ChatSession | null>> {
  const list = await loadSessions();
  return { success: true, data: list.find((s) => s.id === id) ?? null };
}

// ==================== Port 流式编排 ====================

interface PortState {
  current?: { requestId: number; ctrl: AbortController };
}

export function setupChatPort(): void {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== CHAT_PORT_NAME) return;
    const state: PortState = {};
    port.onMessage.addListener((raw) => {
      void handleClientMsg(port, state, raw as ChatClientMsg);
    });
    // 侧边栏关闭：停掉进行中的请求，不白烧 token
    port.onDisconnect.addListener(() => {
      state.current?.ctrl.abort();
      state.current = undefined;
    });
  });
}

function post(port: chrome.runtime.Port, msg: ChatServerMsg): void {
  try {
    port.postMessage(msg);
  } catch {
    /* 已断连，静默 */
  }
}

async function handleClientMsg(
  port: chrome.runtime.Port,
  state: PortState,
  msg: ChatClientMsg
): Promise<void> {
  if (msg.type === 'stop') {
    if (state.current?.requestId === msg.requestId) state.current.ctrl.abort();
    return;
  }

  // 同连接每次只允许一个进行中的生成：新请求先停旧的
  state.current?.ctrl.abort();

  const config = await getConfig();
  const ai = config.ai;
  if (!ai?.baseUrl || !ai.apiKey || !ai.model || !ai.acknowledged) {
    post(port, {
      type: 'error',
      requestId: msg.requestId,
      kind: 'not-configured',
      message: t('bg.aiNotConfigured'),
    });
    return;
  }

  if (msg.type === 'start-summary') {
    pruneSources();
    const pending = pendingSources.get(msg.sourceId);
    pendingSources.delete(msg.sourceId);
    if (!pending) {
      post(port, {
        type: 'error',
        requestId: msg.requestId,
        kind: 'source-expired',
        message: t('bg.chatSourceExpired'),
      });
      return;
    }
    const now = Date.now();
    const session: ChatSession = {
      id: crypto.randomUUID(),
      title: pending.material.title,
      target: pending.target,
      sourceKind: pending.material.kind,
      note: pending.material.note,
      messages: [{ role: 'user', content: pending.material.text, kind: 'source' }],
      createdAt: now,
      updatedAt: now,
    };
    post(port, { type: 'accepted', requestId: msg.requestId, session });
    await runGeneration(port, state, msg.requestId, session, ai, true);
    return;
  }

  // ask：追问既有会话
  const got = await getChatSession(msg.sessionId);
  const session = got.data;
  if (!session) {
    post(port, {
      type: 'error',
      requestId: msg.requestId,
      kind: 'session-gone',
      message: t('bg.chatSessionGone'),
    });
    return;
  }
  const text = msg.text.trim();
  if (!text) return;
  session.messages.push({ role: 'user', content: text });
  await runGeneration(port, state, msg.requestId, session, ai, false);
}

/** 存储消息 → 发送消息：source 条包上总结指令，其余原样 */
function toWire(m: ChatMsg): ChatMessage {
  return {
    role: m.role,
    content: m.kind === 'source' ? wrapSourceContent(m.content) : m.content,
  };
}

/**
 * 执行一次生成（首轮总结或追问），流式推给 Port，终态落盘。
 * 首轮超预算 / 被端点判溢出 → 切块 refine（中间块非流式，最后一块流式）。
 */
async function runGeneration(
  port: chrome.runtime.Port,
  state: PortState,
  requestId: number,
  session: ChatSession,
  ai: AiConfig,
  isFirst: boolean
): Promise<void> {
  const ctrl = new AbortController();
  state.current = { requestId, ctrl };
  const startedAt = Date.now();
  /** 首轮统计（只报枚举/数值，绝不含内容/URL/端点，FR-006） */
  const trackFirst = (ok: boolean) => {
    if (!isFirst) return;
    void track({
      name: 'summarize',
      url: '/summarize',
      data: {
        kind: session.sourceKind,
        ok,
        secs: Math.round((Date.now() - startedAt) / 1000),
        chat: true,
      },
    });
  };
  let partial = '';
  const onDelta = (text: string) => {
    partial += text;
    if (state.current?.requestId === requestId) {
      post(port, { type: 'delta', requestId, text });
    }
  };

  const finishWith = async (message: ChatMsg) => {
    session.messages.push(message);
    session.updatedAt = Date.now();
    await saveSession(session);
    post(port, { type: 'done', requestId, message });
  };

  try {
    let full: string;
    const budget = TOKEN_BUDGET - PROMPT_RESERVE;
    const sourceText = session.messages[0]?.kind === 'source' ? session.messages[0].content : '';

    if (isFirst && estimateTokens(sourceText) > budget) {
      full = await refineStream(ai, sourceText, requestId, port, onDelta, ctrl.signal);
    } else {
      const trimmed = trimHistoryToBudget(session.messages, budget);
      const send = [chatSystemPrompt(ai.targetLang), ...trimmed.map(toWire)];
      try {
        full = await chatCompleteStream(ai, send, onDelta, ctrl.signal);
      } catch (err) {
        // 直塞被端点判溢出：仅首轮可降级切块重试一次
        if (isFirst && err instanceof LlmError && err.kind === 'overflow') {
          partial = '';
          full = await refineStream(ai, sourceText, requestId, port, onDelta, ctrl.signal);
        } else {
          throw err;
        }
      }
    }
    await finishWith({ role: 'assistant', content: full });
    trackFirst(true);
  } catch (err) {
    const aborted = err instanceof LlmError && err.kind === 'aborted';
    if (!aborted) trackFirst(false);
    if (partial.trim()) {
      // 停止/中断但已有内容：保留部分回答并标注（宪法 III 的部分结果语义）
      await finishWith({ role: 'assistant', content: partial, stopped: true });
    } else if (aborted) {
      post(port, { type: 'error', requestId, kind: 'aborted', message: '' });
    }
    if (!aborted) {
      const kind = err instanceof LlmError ? err.kind : 'unknown';
      const message = err instanceof Error ? err.message : String(err);
      if (!partial.trim() && session.messages.some((m) => m.role === 'assistant')) {
        // 追问失败：用户消息也保住，重开侧边栏还能接着问
        session.updatedAt = Date.now();
        await saveSession(session);
      }
      post(port, { type: 'error', requestId, kind, message });
    }
  } finally {
    if (state.current?.requestId === requestId) state.current = undefined;
  }
}

/** 切块 refine：中间块非流式并推 progress，最后一块流式吐 delta */
async function refineStream(
  ai: AiConfig,
  text: string,
  requestId: number,
  port: chrome.runtime.Port,
  onDelta: (text: string) => void,
  signal: AbortSignal
): Promise<string> {
  const chunks = splitText(text, { chunkSize: refineChunkChars(), overlap: 500 });
  let summary = '';
  try {
    for (let i = 0; i < chunks.length; i++) {
      post(port, { type: 'progress', requestId, current: i + 1, total: chunks.length });
      const messages =
        i === 0
          ? buildSummaryMessages(chunks[i], ai.targetLang)
          : buildRefineMessages(summary, chunks[i], ai.targetLang);
      if (i === chunks.length - 1) {
        return await chatCompleteStream(ai, messages, onDelta, signal);
      }
      summary = await chatComplete(ai, messages, signal);
    }
    return summary;
  } catch (err) {
    // 中间块失败但前面已有累积总结：整段吐给 UI 再抛，保住部分结果（宪法 III）
    if (summary) onDelta(summary);
    throw err;
  }
}
