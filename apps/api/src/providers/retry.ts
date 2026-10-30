import { ProviderError } from './types.ts';

export type RetryPolicy = { maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 8000 };
export type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };

/**
 * Retry only errors marked retryable. Waits `Retry-After` when the provider sends one, otherwise
 * exponential backoff with full jitter: random() * min(maxDelay, base * 2^attempt).
 * A `Retry-After` longer than maxDelayMs fails immediately rather than blocking the request.
 */
export async function withRetry<T>(run: () => Promise<T>, policy: RetryPolicy, deps: { sleep: Clock['sleep']; random: () => number }): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      error.attempts = attempt + 1;
      if (!error.retryable || attempt + 1 >= policy.maxAttempts) throw error;
      if (error.retryAfterMs !== null && error.retryAfterMs > policy.maxDelayMs) throw error;
      const delay = error.retryAfterMs ?? deps.random() * Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
      await deps.sleep(delay);
    }
  }
}

/** Serializes request starts so consecutive calls are at least `minIntervalMs` apart. */
export function createRateLimiter(minIntervalMs: number, clock: Clock) {
  let chain: Promise<void> = Promise.resolve();
  let lastStart = -Infinity;
  return {
    schedule<T>(run: () => Promise<T>): Promise<T> {
      const slot = chain.then(async () => {
        const wait = lastStart + minIntervalMs - clock.now();
        if (wait > 0) await clock.sleep(wait);
        lastStart = clock.now();
      });
      chain = slot;
      return slot.then(run);
    }
  };
}

/** Parse an HTTP Retry-After header (delta-seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null || value.trim() === '') return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}
