import { assessCandles, isCalendarDate, makeProvenance, MARKET_SYMBOL, validateInstrument, type Instrument, type ProviderInfo } from '../../../../packages/core/src/marketData.ts';
import { DEFAULT_RETRY, createRateLimiter, parseRetryAfter, withRetry, type RetryPolicy } from './retry.ts';
import { ProviderError, type CandleResult, type MarketDataProvider } from './types.ts';

/**
 * Client for the documented TradeLens provider contract (README, "Market data providers"):
 *   GET {baseUrl}/v1/instruments          -> { instruments: Instrument[] }
 *   GET {baseUrl}/v1/candles/{symbol}?limit=N -> { symbol, exchange, currency, candles: Candle[] }
 * A licensed vendor is connected through a small adapter that serves this contract. No vendor
 * endpoints are hard-coded here, and nothing is scraped.
 */
export type HttpProviderConfig = {
  id: string; name: string; baseUrl: string; apiKey: string; license: string; exchange: string; currency: string;
  holidays: string[]; maxStaleSessions: number; timeoutMs: number; minIntervalMs: number; cacheTtlMs: number; retry: RetryPolicy;
};
export type HttpProviderDeps = {
  fetch: typeof fetch; now: () => Date; sleep: (ms: number) => Promise<void>; random: () => number;
};
export const CANDLE_LOOKBACK = 250;
const MAX_RESPONSE_CHARS = 5_000_000;
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);

export function validateHttpConfig(config: HttpProviderConfig): string[] {
  const errors: string[] = [];
  let url: URL | null = null;
  try { url = new URL(config.baseUrl); } catch { errors.push('baseUrl must be an absolute URL'); }
  if (url) {
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) errors.push('baseUrl must use https (http is allowed only for localhost)');
    if (url.username || url.password) errors.push('baseUrl must not contain credentials; use the API key setting');
    if (url.search || url.hash) errors.push('baseUrl must not contain a query string or fragment');
  }
  if (config.apiKey.length < 8) errors.push('apiKey is missing or too short');
  if (!/^[a-z0-9-]{1,40}$/.test(config.id)) errors.push('id must be 1-40 lowercase letters, digits or hyphens');
  if (!config.name.trim()) errors.push('name is required');
  if (!config.license.trim()) errors.push('license is required: state the data licence or terms you are using this data under');
  if (!/^[A-Z]{2,10}$/.test(config.exchange)) errors.push('exchange must be 2-10 capital letters, e.g. NSE');
  if (!/^[A-Z]{3}$/.test(config.currency)) errors.push('currency must be a 3-letter code, e.g. INR');
  if (!config.holidays.every(isCalendarDate)) errors.push('holidays must be YYYY-MM-DD dates');
  for (const [key, value] of Object.entries({ maxStaleSessions: config.maxStaleSessions, timeoutMs: config.timeoutMs, minIntervalMs: config.minIntervalMs, cacheTtlMs: config.cacheTtlMs })) {
    if (!Number.isInteger(value) || value < 0) errors.push(`${key} must be a whole number ≥ 0`);
  }
  if (config.timeoutMs < 1) errors.push('timeoutMs must be at least 1');
  if (!Number.isInteger(config.retry.maxAttempts) || config.retry.maxAttempts < 1 || config.retry.maxAttempts > 10) errors.push('retry.maxAttempts must be 1-10');
  return errors;
}

export function createHttpProvider(config: HttpProviderConfig, deps: HttpProviderDeps): MarketDataProvider {
  const errors = validateHttpConfig(config);
  if (errors.length) throw new ProviderError('config', `Invalid HTTP market data config: ${errors.join('; ')}`);
  const info: ProviderInfo = { id: config.id, name: config.name, kind: 'licensed', exchange: config.exchange, currency: config.currency, license: config.license, timezone: 'Asia/Kolkata' };
  const base = config.baseUrl.replace(/\/+$/, '');
  const clock = { now: () => deps.now().getTime(), sleep: deps.sleep };
  const limiter = createRateLimiter(config.minIntervalMs, clock);
  const cache = new Map<string, { value: unknown; fetchedAt: number }>();

  async function attempt(path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await deps.fetch(`${base}${path}`, {
        headers: { authorization: `Bearer ${config.apiKey}`, accept: 'application/json' },
        signal: AbortSignal.timeout(config.timeoutMs)
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new ProviderError('unavailable', timedOut ? `request timed out after ${config.timeoutMs} ms` : 'network error contacting provider', { retryable: true });
    }
    if (response.status === 401 || response.status === 403) throw new ProviderError('auth', `provider rejected credentials (HTTP ${response.status})`);
    if (response.status === 404) throw new ProviderError('not-found', 'provider has no data for this request');
    if (response.status === 429) {
      throw new ProviderError('rate-limited', 'provider rate limit reached (HTTP 429)', { retryable: true, retryAfterMs: parseRetryAfter(response.headers.get('retry-after'), clock.now()) });
    }
    if (RETRYABLE_STATUS.has(response.status)) throw new ProviderError('unavailable', `provider error (HTTP ${response.status})`, { retryable: true });
    if (!response.ok) throw new ProviderError('invalid-response', `unexpected HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > MAX_RESPONSE_CHARS) throw new ProviderError('invalid-response', 'response too large');
    try { return JSON.parse(text); } catch { throw new ProviderError('invalid-response', 'response is not valid JSON'); }
  }

  async function get(path: string): Promise<{ value: unknown; fetchedAt: number }> {
    const cached = cache.get(path);
    if (cached && clock.now() - cached.fetchedAt < config.cacheTtlMs) return cached;
    const value = await withRetry(() => limiter.schedule(() => attempt(path)), config.retry, { sleep: deps.sleep, random: deps.random });
    const entry = { value, fetchedAt: clock.now() };
    if (config.cacheTtlMs > 0) cache.set(path, entry);
    return entry;
  }

  const invalid = (message: string) => new ProviderError('invalid-response', message);
  return {
    info,
    async listInstruments(): Promise<Instrument[]> {
      const { value } = await get('/v1/instruments');
      const list = (value as { instruments?: unknown })?.instruments;
      if (!Array.isArray(list)) throw invalid('instruments response must be { instruments: [...] }');
      const instruments = list.map((raw) => {
        const result = validateInstrument(raw);
        if (typeof result === 'string') throw invalid(`instrument rejected: ${result}`);
        if (result.exchange !== info.exchange || result.currency !== info.currency) throw invalid(`${result.symbol} is ${result.exchange}/${result.currency}, expected ${info.exchange}/${info.currency}`);
        return result;
      });
      if (new Set(instruments.map((i) => i.symbol)).size !== instruments.length) throw invalid('duplicate instrument symbol');
      return instruments;
    },
    async getCandles(symbol: string): Promise<CandleResult> {
      if (!MARKET_SYMBOL.test(symbol)) throw new ProviderError('not-found', 'invalid symbol');
      const { value, fetchedAt } = await get(`/v1/candles/${encodeURIComponent(symbol)}?limit=${CANDLE_LOOKBACK}`);
      const body = value as Record<string, unknown> | null;
      if (!body || typeof body !== 'object' || !Array.isArray(body.candles)) throw invalid('candles response must include a candles list');
      if (body.symbol !== symbol) throw invalid(`response is for ${String(body.symbol)}, expected ${symbol}`);
      if (body.exchange !== info.exchange || body.currency !== info.currency) throw invalid(`response is ${String(body.exchange)}/${String(body.currency)}, expected ${info.exchange}/${info.currency}`);
      const assessed = assessCandles(body.candles, { now: deps.now(), holidays: config.holidays, maxStaleSessions: config.maxStaleSessions });
      return { candles: assessed.candles, provenance: makeProvenance(info, assessed, new Date(fetchedAt).toISOString()) };
    }
  };
}

export const DEFAULT_HTTP_SETTINGS = { maxStaleSessions: 0, timeoutMs: 10_000, minIntervalMs: 250, cacheTtlMs: 60_000, retry: DEFAULT_RETRY };
