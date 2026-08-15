import { describe, expect, it } from 'vitest';
import { anySignal, chatCompletionsUrl, extractDelta, parseSse, type SseState } from './llm';

const data = (obj: unknown) => `data: ${JSON.stringify(obj)}\n`;
const delta = (content: string) => ({ choices: [{ delta: { content } }] });

describe('parseSse', () => {
  it('完整行直接吐载荷，[DONE] 置 done', () => {
    const state: SseState = { buf: '' };
    const r = parseSse(state, data(delta('你好')) + 'data: [DONE]\n');
    expect(r.payloads).toHaveLength(1);
    expect(r.done).toBe(true);
    expect(state.buf).toBe('');
  });

  it('跨 chunk 的半行留在尾部缓冲，下一轮拼回完整行', () => {
    const state: SseState = { buf: '' };
    const line = data(delta('分段'));
    const r1 = parseSse(state, line.slice(0, 10));
    expect(r1.payloads).toHaveLength(0);
    expect(state.buf).toBe(line.slice(0, 10));
    const r2 = parseSse(state, line.slice(10));
    expect(r2.payloads).toHaveLength(1);
    expect(extractDelta(r2.payloads[0])).toBe('分段');
  });

  it('兼容 CRLF 行分隔', () => {
    const state: SseState = { buf: '' };
    const r = parseSse(state, `data: ${JSON.stringify(delta('a'))}\r\ndata: [DONE]\r\n`);
    expect(r.payloads).toHaveLength(1);
    expect(r.done).toBe(true);
  });

  it('非 data 行（注释/事件名/空行）忽略', () => {
    const state: SseState = { buf: '' };
    const r = parseSse(state, ': keep-alive\nevent: ping\n\n' + data(delta('x')));
    expect(r.payloads).toHaveLength(1);
  });
});

describe('extractDelta', () => {
  it('取 choices[0].delta.content', () => {
    expect(extractDelta(JSON.stringify(delta('增量')))).toBe('增量');
  });

  it('无 content（role 帧 / finish 帧）与坏 JSON 返回空串', () => {
    expect(extractDelta(JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] }))).toBe('');
    expect(extractDelta('{oops')).toBe('');
  });
});

describe('chatCompletionsUrl', () => {
  it('已带 /v1 不拼重，末尾斜杠归一', () => {
    expect(chatCompletionsUrl('https://api.x.com/v1/')).toBe(
      'https://api.x.com/v1/chat/completions'
    );
    expect(chatCompletionsUrl('https://api.x.com')).toBe(
      'https://api.x.com/v1/chat/completions'
    );
  });
});

describe('anySignal', () => {
  /** 抹掉原生 AbortSignal.any，专门测旧版 Chrome 走的兜底分支 */
  function withoutNative<T>(fn: () => T): T {
    const native = AbortSignal.any;
    // @ts-expect-error 测试里临时删掉原生实现
    delete AbortSignal.any;
    try {
      // 确认真删掉了：删不掉的话下面测的还是原生实现，等于白测
      expect(AbortSignal.any).toBeUndefined();
      return fn();
    } finally {
      AbortSignal.any = native;
    }
  }

  it('原生可用时交给原生实现', () => {
    const a = new AbortController();
    const merged = anySignal([a.signal, new AbortController().signal]);
    expect(merged.aborted).toBe(false);
    a.abort('停止');
    expect(merged.aborted).toBe(true);
  });

  it('兜底：任一 signal abort，结果跟着 abort 并沿用 reason', () => {
    withoutNative(() => {
      const a = new AbortController();
      const b = new AbortController();
      const merged = anySignal([a.signal, b.signal]);

      expect(merged.aborted).toBe(false);
      b.abort('超时');
      expect(merged.aborted).toBe(true);
      expect(merged.reason).toBe('超时');
    });
  });

  it('兜底：传入的 signal 已经 abort 时，结果立刻是 aborted', () => {
    withoutNative(() => {
      const done = new AbortController();
      done.abort('早就停了');
      const merged = anySignal([done.signal, new AbortController().signal]);

      expect(merged.aborted).toBe(true);
      expect(merged.reason).toBe('早就停了');
    });
  });

  it('兜底：谁都没 abort 就保持未 abort，且只认第一个 abort 的 reason', () => {
    withoutNative(() => {
      const a = new AbortController();
      const b = new AbortController();
      const merged = anySignal([a.signal, b.signal]);

      expect(merged.aborted).toBe(false);
      a.abort('先来的');
      b.abort('后到的');
      expect(merged.reason).toBe('先来的');
    });
  });
});
