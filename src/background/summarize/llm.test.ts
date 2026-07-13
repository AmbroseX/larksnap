import { describe, expect, it } from 'vitest';
import { chatCompletionsUrl, extractDelta, parseSse, type SseState } from './llm';

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
