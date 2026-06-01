import { logger } from './logger.js';

export interface RetryOptions {
  attempts?: number;
  initialDelayMs?: number;
  factor?: number;
  label?: string;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const initial = opts.initialDelayMs ?? 200;
  const factor = opts.factor ?? 2;
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i === attempts - 1) break;
      const delay = initial * Math.pow(factor, i);
      logger.debug(
        { attempt: i + 1, nextDelayMs: delay, label: opts.label, err: (err as Error).message },
        'retry-after-error',
      );
      await sleep(delay);
    }
  }
  throw lastError;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
