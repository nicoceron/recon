import { describe, expect, it, vi } from 'vitest';
import { sleep, withRetry } from './retry.js';

describe('sleep', () => {
  it('resolves after roughly the given delay', async () => {
    const start = Date.now();
    await sleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});

describe('withRetry', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { attempts: 3 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries until success', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail-1'))
      .mockRejectedValueOnce(new Error('fail-2'))
      .mockResolvedValueOnce('ok');
    const result = await withRetry(fn, { attempts: 3, initialDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws the last error after max attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always-fails'));
    await expect(withRetry(fn, { attempts: 2, initialDelayMs: 1 })).rejects.toThrow('always-fails');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('honours initial delay × factor between attempts', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('1'))
      .mockResolvedValueOnce('ok');
    const start = Date.now();
    await withRetry(fn, { attempts: 2, initialDelayMs: 30, factor: 2 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(25);
  });
});
