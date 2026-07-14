import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChatClientMsg,
  ChatServerMsg,
  ChatSession,
  ChatSessionMeta,
  SelectionPrompt,
  SummaryNeedsAck,
  SummaryPrepared,
} from '../shared/types';
import { CHAT_PORT_NAME, MSG } from '../shared/constants';
import { sendToBackground } from '../shared/messaging';
import { getConfig, saveConfig } from '../shared/storage';
import { callWithPermission, copyToClipboard } from './permission-call';
import { Markdown } from '../shared/markdown/Markdown';
import { t } from '../shared/i18n';
import { useI18n } from '../shared/i18n/useI18n';

/**
 * AI 对话页（007）：
 *   prepare（普通消息，含 needsAck/授权手势）→ Port 流式（requestId 守卫）。
 * 会话真身由 SW 持有并在终态落盘；本组件只保留渲染态副本。
 * 注意：组件卸载会断开 Port → SW 自动 abort 进行中的生成（省 token 的既定行为）。
 */

type TargetRef = { tabId: number; url: string };
type Phase = 'idle' | 'preparing' | 'streaming';

/** SidePanel 消费导航意图后传入；ts 用于区分两次相同页面的触发 */
export interface ChatAutoStart extends TargetRef {
  ts: number;
  /** 右键「问 AI」带来的选中文字：走纯聊天通路，不抓页面（008） */
  selectionText?: string;
  selPrompt?: SelectionPrompt;
}

/** 推荐指令 → 发送给模型的指令文案 key（选中文字通路共用） */
const SEL_INS = {
  summarize: 'chat.selInsSummarize',
  translate: 'chat.selInsTranslate',
  explain: 'chat.selInsExplain',
  rewrite: 'chat.selInsRewrite',
} as const;

/** 选区推荐按钮：[按钮文案 key, 指令文案 key] */
const SEL_ACTIONS = [
  ['chat.selSummarize', 'chat.selInsSummarize'],
  ['chat.selTranslate', 'chat.selInsTranslate'],
  ['chat.selExplain', 'chat.selInsExplain'],
  ['chat.selRewrite', 'chat.selInsRewrite'],
] as const;

/** 选中文字 + 指令 → 一条用户消息（内容即所见，模型与气泡看到同一份） */
function composeSelectionMessage(instruction: string, selection: string): string {
  return `${instruction}\n\n${selection}`;
}

export function ChatView({ autoStart }: { autoStart: ChatAutoStart | null }) {
  useI18n();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [session, setSession] = useState<ChatSession | null>(null);
  const [sessions, setSessions] = useState<ChatSessionMeta[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [streamText, setStreamText] = useState('');
  const [chunkProgress, setChunkProgress] = useState<{ current: number; total: number } | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [ack, setAck] = useState<{ origin: string; target?: TargetRef } | null>(null);
  const [input, setInput] = useState('');
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  /** 纯聊天开场时先行渲染的首条用户消息（accepted 回来后由会话真身接管） */
  const [pendingFirst, setPendingFirst] = useState<string | null>(null);
  /** 当前页选中文字（activeTab 读取；读不到即 null，绝不弹授权） */
  const [selection, setSelection] = useState<string | null>(null);

  const portRef = useRef<chrome.runtime.Port | null>(null);
  const reqIdRef = useRef(0);
  /** 当前生成的 requestId：Port 事件只认它，迟到的旧流直接丢（评审 P2） */
  const currentReqRef = useRef<number | null>(null);
  const phaseRef = useRef<Phase>('idle');
  phaseRef.current = phase;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const consumedTsRef = useRef(0);

  // ---------- Port ----------

  const msgHandlerRef = useRef<(msg: ChatServerMsg) => void>(() => {});
  msgHandlerRef.current = (msg) => {
    if (msg.requestId !== currentReqRef.current) return;
    switch (msg.type) {
      case 'accepted':
        setSession(msg.session);
        setPendingFirst(null);
        break;
      case 'progress':
        setChunkProgress({ current: msg.current, total: msg.total });
        break;
      case 'delta':
        setChunkProgress(null);
        setStreamText((s) => s + msg.text);
        break;
      case 'done':
        // 不清 currentReqRef：done 之后可能还跟一条 error（部分结果 + 失败原因）
        setSession((s) =>
          s ? { ...s, messages: [...s.messages, msg.message], updatedAt: Date.now() } : s
        );
        setStreamText('');
        setChunkProgress(null);
        setPhase('idle');
        void refreshSessions();
        break;
      case 'error':
        currentReqRef.current = null;
        setStreamText('');
        setChunkProgress(null);
        setPhase('idle');
        // 纯聊天开场失败：首条消息还没进会话，捞回输入框，用户不用重打
        if (!session && pendingFirst) setInput((v) => v || pendingFirst);
        setPendingFirst(null);
        if (msg.kind !== 'aborted' && msg.message) setError(msg.message);
        break;
    }
  };

  const getPort = useCallback((): chrome.runtime.Port => {
    if (portRef.current) return portRef.current;
    const port = chrome.runtime.connect({ name: CHAT_PORT_NAME });
    port.onMessage.addListener((raw) => msgHandlerRef.current(raw as ChatServerMsg));
    port.onDisconnect.addListener(() => {
      portRef.current = null;
    });
    portRef.current = port;
    return port;
  }, []);

  useEffect(
    () => () => {
      portRef.current?.disconnect();
      portRef.current = null;
    },
    []
  );

  // ---------- 配置与会话列表 ----------

  const refreshConfigured = useCallback(
    () =>
      getConfig().then((cfg) =>
        setConfigured(!!(cfg.ai?.baseUrl && cfg.ai.apiKey && cfg.ai.model))
      ),
    []
  );

  const refreshSessions = useCallback(async () => {
    const res = await sendToBackground<ChatSessionMeta[]>(MSG.CHAT_LIST_SESSIONS);
    if (res.success) setSessions(res.data ?? []);
  }, []);

  useEffect(() => {
    void refreshConfigured();
    void refreshSessions();
  }, [refreshConfigured, refreshSessions]);

  // ---------- 发起总结 / 追问 / 停止 ----------

  const startSummary = useCallback(
    async (explicit?: TargetRef) => {
      if (phaseRef.current !== 'idle') return;
      setError(null);
      setPhase('preparing');
      const res = await callWithPermission<SummaryPrepared | SummaryNeedsAck>(
        MSG.SUMMARIZE_PREPARE,
        explicit
      );
      if (!res.success || !res.data) {
        setPhase('idle');
        setError(res.error || t('summary.failed'));
        return;
      }
      if ('needsAck' in res.data) {
        setAck({ origin: res.data.endpointOrigin, target: explicit });
        setPhase('idle');
        return;
      }
      const prepared = res.data;
      reqIdRef.current += 1;
      const requestId = reqIdRef.current;
      currentReqRef.current = requestId;
      setSession(null);
      setStreamText('');
      setChunkProgress(null);
      setPhase('streaming');
      getPort().postMessage({
        type: 'start-summary',
        requestId,
        sourceId: prepared.sourceId,
      } satisfies ChatClientMsg);
    },
    [getPort]
  );

  /** 纯聊天开场（008）：不取页面、零授权，首条就是普通用户消息 */
  const startChat = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text || phaseRef.current !== 'idle') return;
      setError(null);
      setSession(null);
      setPendingFirst(text);
      reqIdRef.current += 1;
      const requestId = reqIdRef.current;
      currentReqRef.current = requestId;
      setStreamText('');
      setChunkProgress(null);
      setPhase('streaming');
      getPort().postMessage({
        type: 'start-chat',
        requestId,
        text,
      } satisfies ChatClientMsg);
    },
    [getPort]
  );

  /** 发送一条消息（输入框与推荐 chips 共用）：无会话时开纯聊天，有会话则追问 */
  const sendText = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text || phaseRef.current !== 'idle') return;
      if (!session) {
        startChat(text);
        return;
      }
      setError(null);
      // 渲染态先行追加；SW 侧以 sessionId 从存储取真身再追加，终态落盘
      setSession((s) =>
        s ? { ...s, messages: [...s.messages, { role: 'user', content: text }] } : s
      );
      reqIdRef.current += 1;
      const requestId = reqIdRef.current;
      currentReqRef.current = requestId;
      setStreamText('');
      setPhase('streaming');
      getPort().postMessage({
        type: 'ask',
        requestId,
        sessionId: session.id,
        text,
      } satisfies ChatClientMsg);
    },
    [session, getPort, startChat]
  );

  const send = useCallback(() => {
    sendText(input);
    setInput('');
    if (taRef.current) taRef.current.style.height = 'auto';
  }, [input, sendText]);

  /** 输入框随内容自增高（上限 120px） */
  const autoGrow = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, []);

  const stop = useCallback(() => {
    if (phaseRef.current !== 'streaming' || currentReqRef.current == null) return;
    // 不立即收 phase：等 SW 的 done(stopped)/error(aborted) 回来，保证部分结果入会话
    getPort().postMessage({
      type: 'stop',
      requestId: currentReqRef.current,
    } satisfies ChatClientMsg);
  }, [getPort]);

  /** 首次使用确认：写回 acknowledged 后按原目标重新发起 */
  const confirmAck = useCallback(async () => {
    const cfg = await getConfig();
    if (cfg.ai) await saveConfig({ ai: { ...cfg.ai, acknowledged: true } });
    const target = ack?.target;
    setAck(null);
    await startSummary(target);
  }, [ack, startSummary]);

  // 导航意图（右键/快捷键）：SidePanel 消费后传入，按 ts 去重。
  // 带选中文字的走纯聊天通路（零授权）；否则是「AI 总结」抓整页
  useEffect(() => {
    if (!autoStart || autoStart.ts === consumedTsRef.current) return;
    consumedTsRef.current = autoStart.ts;
    const sel = autoStart.selectionText?.trim();
    if (sel) {
      const ins = t(SEL_INS[autoStart.selPrompt ?? 'summarize']);
      startChat(composeSelectionMessage(ins, sel));
    } else {
      void startSummary({ tabId: autoStart.tabId, url: autoStart.url });
    }
  }, [autoStart, startSummary, startChat]);

  // 当前页选区探测（008 主通路）：面板可见/获得焦点时读一次，读不到就当没选中。
  // 只用 activeTab，绝不触发授权弹窗；不可用时右键菜单「问 AI」是兜底
  useEffect(() => {
    let alive = true;
    const fetchSelection = async () => {
      const res = await sendToBackground<{ text: string }>(MSG.GET_SELECTION);
      if (alive && res.success) setSelection(res.data?.text?.trim() || null);
    };
    void fetchSelection();
    const onFocus = () => void fetchSelection();
    const onVisible = () => {
      if (!document.hidden) void fetchSelection();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const loadSession = useCallback(async (id: string) => {
    if (phaseRef.current !== 'idle') return;
    const res = await sendToBackground<ChatSession | null>(MSG.CHAT_GET_SESSION, { id });
    if (res.success && res.data) {
      setSession(res.data);
      setError(null);
    }
  }, []);

  // 新消息 / 流式增量时自动滚到底
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session?.messages.length, streamText, chunkProgress]);

  const handleCopy = useCallback(async (content: string, idx: number) => {
    if (await copyToClipboard(content)) {
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 1200);
    }
  }, []);

  // ---------- 渲染 ----------

  if (configured === false) {
    return (
      <div className="chat-page">
        <div className="wc-card">
          <div className="wc-card-title">{t('summary.title')}</div>
          <div className="wc-row-sub">{t('summary.notConfigured')}</div>
          <div className="wc-btn-row">
            <button
              className="wc-btn primary"
              onClick={() => {
                chrome.runtime.openOptionsPage();
                setTimeout(() => void refreshConfigured(), 3000);
              }}
            >
              {t('summary.goConfig')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const busy = phase !== 'idle';
  const [ackPre, ackPost] = t('summary.ackIntro').split('{origin}');
  /** 推荐追问（chips 行）：文案即发送内容 */
  const quickPrompts = ['qpKeyPoints', 'qpOneLiner', 'qpActions', 'qpExplain'] as const;

  return (
    <div className="chat-page">
      {(session || sessions.length > 0) && (
        <div className="chat-session-bar">
          <button
            className="chat-ghost-btn"
            disabled={busy || configured == null}
            onClick={() => {
              // 回到空状态：可直接打字纯聊天，也可点「总结当前页」
              setSession(null);
              setError(null);
            }}
            title={t('chat.newSession')}
          >
            ＋ {t('chat.newSession')}
          </button>
          <span className="chat-bar-spacer" />
          {sessions.length > 0 && (
            <select
              className="chat-history-select"
              disabled={busy}
              value={session?.id ?? ''}
              onChange={(e) => e.target.value && void loadSession(e.target.value)}
              title={t('chat.history')}
            >
              <option value="">{t('chat.history')}</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {ack ? (
        <div className="wc-card">
          <div className="wc-row-sub">
            {ackPre}
            <strong>{ack.origin}</strong>
            {ackPost}
          </div>
          <div className="wc-btn-row">
            <button className="wc-btn primary" onClick={() => void confirmAck()}>
              {t('summary.confirm')}
            </button>
            <button className="wc-btn" onClick={() => setAck(null)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="chat-msgs" ref={scrollRef}>
          {!session && !busy && !pendingFirst && (
            <div className="chat-empty">
              <div className="chat-empty-icon">✨</div>
              <p>{t('chat.emptyHint')}</p>
              <button
                className="wc-btn primary chat-empty-btn"
                disabled={configured == null}
                onClick={() => void startSummary()}
              >
                {t('chat.summarizeNow')}
              </button>
              <p className="chat-empty-sub">{t('chat.summarizeNote')}</p>
            </div>
          )}

          {session?.note && <div className="chat-note">⚠️ {session.note}</div>}

          {/* 纯聊天开场：会话真身（accepted）回来前先渲染首条用户消息 */}
          {!session && pendingFirst && <div className="chat-bubble user">{pendingFirst}</div>}

          {session?.messages.map((m, i) =>
            m.kind === 'source' ? (
              <div key={i} className="chat-source-chip" title={session.title}>
                📄 {session.title} · {t('chat.sourceChip', { chars: m.content.length })}
              </div>
            ) : (
              <div key={i} className={`chat-bubble ${m.role}`}>
                {m.role === 'assistant' ? <Markdown text={m.content} /> : m.content}
                {m.stopped && <div className="chat-stopped-note">{t('chat.stopped')}</div>}
                {m.role === 'assistant' && (
                  <button
                    type="button"
                    className="chat-copy-btn"
                    onClick={() => void handleCopy(m.content, i)}
                  >
                    {copiedIdx === i ? t('summary.copied') : t('common.copy')}
                  </button>
                )}
              </div>
            )
          )}

          {phase === 'streaming' && (
            <>
              {chunkProgress && (
                <div className="chat-hint">
                  {t('chat.chunkProgress', {
                    current: chunkProgress.current,
                    total: chunkProgress.total,
                  })}
                </div>
              )}
              {streamText ? (
                <div className="chat-bubble assistant streaming">
                  <Markdown text={streamText} streaming />
                </div>
              ) : (
                !chunkProgress && <div className="chat-hint">{t('chat.thinking')}</div>
              )}
            </>
          )}
          {phase === 'preparing' && <div className="chat-hint">{t('chat.preparing')}</div>}

          {error && <div className="wc-status wc-status-error">{error}</div>}
        </div>
      )}

      <div className="chat-composer">
        {/* 选中文本 chip + 推荐按钮（008）：点按钮 = 选中文字 + 指令走纯聊天，零授权 */}
        {selection && phase === 'idle' && !ack && (
          <div className="chat-sel-zone">
            <div className="chat-sel-chip" title={selection}>
              <span className="chat-sel-label">✂️ {t('chat.selChip', { chars: selection.length })}</span>
              <span className="chat-sel-preview">{selection}</span>
              <button
                type="button"
                className="chat-sel-clear"
                title={t('common.cancel')}
                onClick={() => setSelection(null)}
              >
                ✕
              </button>
            </div>
            <div className="chat-quick-row">
              {SEL_ACTIONS.map(([labelKey, insKey]) => (
                <button
                  key={labelKey}
                  className="chat-chip"
                  onClick={() => sendText(composeSelectionMessage(t(insKey), selection))}
                >
                  {t(labelKey)}
                </button>
              ))}
            </div>
          </div>
        )}
        {session && !selection && phase === 'idle' && !ack && (
          <div className="chat-quick-row">
            {quickPrompts.map((k) => (
              <button key={k} className="chat-chip" onClick={() => sendText(t(`chat.${k}`))}>
                {t(`chat.${k}`)}
              </button>
            ))}
          </div>
        )}
        <div className="chat-input-shell">
          <textarea
            ref={taRef}
            className="chat-input"
            value={input}
            placeholder={session ? t('chat.placeholder') : t('chat.placeholderNew')}
            disabled={busy}
            rows={1}
            onChange={(e) => {
              setInput(e.target.value);
              autoGrow();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          {phase === 'streaming' ? (
            <button
              type="button"
              className="chat-round-btn stop"
              title={t('chat.stop')}
              onClick={stop}
            >
              ◼
            </button>
          ) : (
            <button
              type="button"
              className="chat-round-btn"
              title={t('chat.send')}
              disabled={busy || !input.trim()}
              onClick={send}
            >
              ➤
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
