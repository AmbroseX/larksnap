import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withKeepAlive } from './keepalive';

/** 守住两件事：任务期间每 20 秒 ping 一次；任务结束（含抛错）后定时器清掉，不让 SW 常驻 */
describe('withKeepAlive', () => {
  const getPlatformInfo = vi.fn(async () => ({}));

  beforeEach(() => {
    vi.useFakeTimers();
    getPlatformInfo.mockClear();
    (globalThis as { chrome?: unknown }).chrome = { runtime: { getPlatformInfo } };
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it('任务跑 50 秒会 ping 两次，结束后不再 ping', async () => {
    let finish!: () => void;
    const p = withKeepAlive(() => new Promise<void>((r) => (finish = r)));
    await vi.advanceTimersByTimeAsync(50_000);
    expect(getPlatformInfo).toHaveBeenCalledTimes(2);
    finish();
    await p;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getPlatformInfo).toHaveBeenCalledTimes(2);
  });

  it('任务抛错也会清掉定时器，并把错误原样抛出', async () => {
    await expect(withKeepAlive(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getPlatformInfo).not.toHaveBeenCalled();
  });
});
