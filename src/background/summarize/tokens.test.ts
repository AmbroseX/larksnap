import { describe, expect, it } from 'vitest';
import type { ChatMsg } from '../../shared/types';
import {
  estimateTokens,
  estimateMessagesTokens,
  isContextOverflowError,
  refineChunkChars,
  trimHistoryToBudget,
} from './tokens';

describe('estimateTokens', () => {
  it('中文一字一 token', () => {
    expect(estimateTokens('飞书文档')).toBe(4);
  });

  it('英文按 4 字符折一 token（向上取整）', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('中英混排各算各的', () => {
    // 4 个中文 + 8 个 ASCII → 4 + 2
    expect(estimateTokens('测试文本abcdefgh')).toBe(6);
  });

  it('空串为 0', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('estimateMessagesTokens / refineChunkChars', () => {
  it('messages 总量含每条 4 的结构开销', () => {
    const msgs = [{ content: '飞书' }, { content: 'abcd' }];
    expect(estimateMessagesTokens(msgs)).toBe(2 + 4 + 1 + 4);
  });

  it('切块字符数为预算一半且有下限', () => {
    expect(refineChunkChars(24_000)).toBe(12_000);
    expect(refineChunkChars(1_000)).toBe(2_000);
  });
});

describe('trimHistoryToBudget', () => {
  const src = (chars: number): ChatMsg => ({
    role: 'user',
    content: '文'.repeat(chars),
    kind: 'source',
  });
  const a = (content: string): ChatMsg => ({ role: 'assistant', content });
  const u = (content: string): ChatMsg => ({ role: 'user', content });

  it('预算内原样返回（同一引用）', () => {
    const msgs = [src(10), a('总结')];
    expect(trimHistoryToBudget(msgs, 1_000)).toBe(msgs);
  });

  it('超预算时源全文替换为既有总结，且总结条被并入不重复', () => {
    const msgs = [src(5_000), a('这是总结'), u('追问'), a('回答')];
    const out = trimHistoryToBudget(msgs, 500);
    expect(out.some((m) => m.kind === 'source')).toBe(false);
    expect(out[0].role).toBe('user');
    expect(out[0].content).toContain('这是总结');
    // 原 assistant 总结条已被并入首条，不再单独出现
    expect(out.filter((m) => m.content === '这是总结')).toHaveLength(0);
    expect(out).toHaveLength(3);
  });

  it('仍超预算时从最旧追问轮成对丢弃，最后一条永不丢', () => {
    const msgs = [
      src(100),
      a('总'.repeat(200)),
      u('旧问'.repeat(100)),
      a('旧答'.repeat(100)),
      u('新问'),
    ];
    const out = trimHistoryToBudget(msgs, 300);
    expect(out[out.length - 1].content).toBe('新问');
    expect(out.some((m) => m.content.startsWith('旧问'))).toBe(false);
  });

  it('裁无可裁时原样照发（不抛错、不丢最后一条）', () => {
    const msgs = [src(9_000), a('短总结但源仍大'.repeat(300)), u('问')];
    const out = trimHistoryToBudget(msgs, 10);
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out[out.length - 1].content).toBe('问');
  });
});

describe('isContextOverflowError', () => {
  it('4xx + 关键字命中', () => {
    expect(isContextOverflowError(400, 'maximum context length exceeded')).toBe(true);
    expect(isContextOverflowError(413, 'too many tokens')).toBe(true);
  });

  it('5xx 或无关键字不命中', () => {
    expect(isContextOverflowError(500, 'context length')).toBe(false);
    expect(isContextOverflowError(400, 'invalid api key')).toBe(false);
  });
});
