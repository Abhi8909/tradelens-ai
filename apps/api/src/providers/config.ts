import { createDemoProvider } from './demo.ts';
import { DEFAULT_FIXTURE_PATH, loadFixtureProvider } from './fixture.ts';
import { DEFAULT_HTTP_SETTINGS, createHttpProvider, type HttpProviderDeps } from './http.ts';
import { ProviderError, type MarketDataProvider } from './types.ts';

type Env = Record<string, string | undefined>;
const defaultDeps: HttpProviderDeps = {
  fetch: (...args) => fetch(...args), now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), random: Math.random
};

function integer(env: Env, key: string, fallback: number, errors: string[]): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) { errors.push(`${key} must be a whole number`); return fallback; }
  return Number(raw);
}

/**
 * MARKET_DATA_PROVIDER = demo (default) | fixture | http. Misconfiguration fails at startup with every
 * problem listed, and the API key value is never echoed.
 */
export function createProviderFromEnv(env: Env, deps: HttpProviderDeps = defaultDeps): MarketDataProvider {
  const kind = env.MARKET_DATA_PROVIDER ?? 'demo';
  if (kind === 'demo') return createDemoProvider(deps.now);
  if (kind === 'fixture') return loadFixtureProvider(env.MARKET_DATA_FIXTURE || DEFAULT_FIXTURE_PATH, deps.now);
  if (kind !== 'http') throw new ProviderError('config', `MARKET_DATA_PROVIDER must be demo, fixture or http (got "${kind}")`);

  const errors: string[] = [];
  const required = ['MARKET_DATA_BASE_URL', 'MARKET_DATA_API_KEY', 'MARKET_DATA_LICENSE', 'MARKET_DATA_EXCHANGE'];
  for (const key of required) if (!env[key]?.trim()) errors.push(`${key} is required`);
  const settings = {
    maxStaleSessions: integer(env, 'MARKET_DATA_MAX_STALE_SESSIONS', DEFAULT_HTTP_SETTINGS.maxStaleSessions, errors),
    timeoutMs: integer(env, 'MARKET_DATA_TIMEOUT_MS', DEFAULT_HTTP_SETTINGS.timeoutMs, errors),
    minIntervalMs: integer(env, 'MARKET_DATA_MIN_INTERVAL_MS', DEFAULT_HTTP_SETTINGS.minIntervalMs, errors),
    cacheTtlMs: integer(env, 'MARKET_DATA_CACHE_TTL_MS', DEFAULT_HTTP_SETTINGS.cacheTtlMs, errors),
    retry: { ...DEFAULT_HTTP_SETTINGS.retry, maxAttempts: integer(env, 'MARKET_DATA_MAX_ATTEMPTS', DEFAULT_HTTP_SETTINGS.retry.maxAttempts, errors) }
  };
  if (errors.length) throw new ProviderError('config', `Market data config: ${errors.join('; ')}`);
  return createHttpProvider({
    id: env.MARKET_DATA_PROVIDER_ID || 'http',
    name: env.MARKET_DATA_PROVIDER_NAME || 'Licensed market data',
    baseUrl: env.MARKET_DATA_BASE_URL!, apiKey: env.MARKET_DATA_API_KEY!, license: env.MARKET_DATA_LICENSE!,
    exchange: env.MARKET_DATA_EXCHANGE!, currency: env.MARKET_DATA_CURRENCY || 'INR',
    holidays: (env.MARKET_DATA_HOLIDAYS ?? '').split(',').map((d) => d.trim()).filter(Boolean),
    ...settings
  }, deps);
}
