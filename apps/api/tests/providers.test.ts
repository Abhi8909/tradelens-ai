import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.ts';
import { createProviderFromEnv } from '../src/providers/config.ts';
import { createFixtureProvider, loadFixtureProvider } from '../src/providers/fixture.ts';
import { DEFAULT_HTTP_SETTINGS, createHttpProvider, validateHttpConfig, type HttpProviderConfig } from '../src/providers/http.ts';
import { createRateLimiter, parseRetryAfter, withRetry } from '../src/providers/retry.ts';
import { ProviderError, type MarketDataProvider } from '../src/providers/types.ts';

const NOW = Date.parse('2026-10-30T04:00:00.000Z'); // Friday morning IST
const KEY = 'test-key-not-real-123';

function fakeClock(start = NOW) {
  let t = start;
  const sleeps: number[] = [];
  return { now: () => new Date(t), nowMs: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, advance: (ms: number) => { t += ms; }, sleeps };
}
type Call = { url: string; headers: Record<string, string> };
function fakeFetch(handler: (url: string, call: number) => Response | Error) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: init?.headers as Record<string, string> });
    const result = handler(String(input), calls.length);
    if (result instanceof Error) throw result;
    return result;
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const candle = (date: string, close = 100) => ({ date, open: close, high: close + 1, low: close - 1, close, volume: 1000 });
const config = (overrides: Partial<HttpProviderConfig> = {}): HttpProviderConfig => ({
  id: 'test-vendor', name: 'Test vendor', baseUrl: 'https://data.example.test/', apiKey: KEY, license: 'Test licence',
  exchange: 'NSE', currency: 'INR', holidays: [], ...DEFAULT_HTTP_SETTINGS, ...overrides
});
const instrumentsBody = { instruments: [{ symbol: 'M&M', name: 'Fixture Motors', sector: 'Auto', exchange: 'NSE', currency: 'INR' }] };
const candlesBody = (dates = ['2026-10-28', '2026-10-29']) => ({ symbol: 'M&M', exchange: 'NSE', currency: 'INR', candles: dates.map((d) => candle(d)) });
function provider(handler: (url: string, call: number) => Response | Error, overrides: Partial<HttpProviderConfig> = {}) {
  const clock = fakeClock();
  const f = fakeFetch(handler);
  return { p: createHttpProvider(config(overrides), { fetch: f.fetch, now: clock.now, sleep: clock.sleep, random: () => 1 }), calls: f.calls, clock };
}
async function rejectsWith(promise: Promise<unknown>, code: string): Promise<ProviderError> {
  try { await promise; } catch (error) {
    assert.ok(error instanceof ProviderError, `expected ProviderError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.message.includes(KEY), false, 'API key must never appear in error messages');
    return error;
  }
  assert.fail(`expected rejection with ${code}`);
}

// ---------- retry and rate limiting ----------

test('withRetry backs off exponentially with jitter and reports attempts', async () => {
  const clock = fakeClock();
  let calls = 0;
  const error = await rejectsWith(withRetry(async () => { calls++; throw new ProviderError('unavailable', 'down', { retryable: true }); },
    { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 1500 }, { sleep: clock.sleep, random: () => 1 }), 'unavailable');
  assert.equal(calls, 4);
  assert.equal(error.attempts, 4);
  assert.deepEqual(clock.sleeps, [500, 1000, 1500], 'capped at maxDelayMs');
  const half = fakeClock();
  await withRetry(async () => { if (half.sleeps.length < 1) throw new ProviderError('unavailable', 'x', { retryable: true }); return 'ok'; },
    { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8000 }, { sleep: half.sleep, random: () => 0.5 });
  assert.deepEqual(half.sleeps, [250], 'full jitter scales the delay');
});

test('withRetry does not retry non-retryable or unexpected errors', async () => {
  const clock = fakeClock();
  let calls = 0;
  await rejectsWith(withRetry(async () => { calls++; throw new ProviderError('auth', 'no'); }, DEFAULT_HTTP_SETTINGS.retry, { sleep: clock.sleep, random: () => 1 }), 'auth');
  await assert.rejects(withRetry(async () => { calls++; throw new TypeError('bug'); }, DEFAULT_HTTP_SETTINGS.retry, { sleep: clock.sleep, random: () => 1 }), TypeError);
  assert.equal(calls, 2);
  assert.deepEqual(clock.sleeps, []);
});

test('withRetry honours Retry-After, and fails fast when it exceeds the maximum delay', async () => {
  const clock = fakeClock();
  let calls = 0;
  const result = await withRetry(async () => { if (calls++ === 0) throw new ProviderError('rate-limited', '429', { retryable: true, retryAfterMs: 2000 }); return 'ok'; },
    DEFAULT_HTTP_SETTINGS.retry, { sleep: clock.sleep, random: () => 1 });
  assert.equal(result, 'ok');
  assert.deepEqual(clock.sleeps, [2000]);
  await rejectsWith(withRetry(async () => { throw new ProviderError('rate-limited', '429', { retryable: true, retryAfterMs: 60_000 }); },
    DEFAULT_HTTP_SETTINGS.retry, { sleep: clock.sleep, random: () => 1 }), 'rate-limited');
  assert.deepEqual(clock.sleeps, [2000], 'no long wait');
});

test('parseRetryAfter reads seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('3', NOW), 3000);
  assert.equal(parseRetryAfter(new Date(NOW + 5000).toUTCString(), NOW), 5000);
  assert.equal(parseRetryAfter(new Date(NOW - 5000).toUTCString(), NOW), 0);
  assert.equal(parseRetryAfter('soon', NOW), null);
  assert.equal(parseRetryAfter(null, NOW), null);
});

test('rate limiter spaces request starts by the minimum interval', async () => {
  const clock = fakeClock();
  const starts: number[] = [];
  const limiter = createRateLimiter(250, { now: clock.nowMs, sleep: clock.sleep });
  await Promise.all([1, 2, 3].map(() => limiter.schedule(async () => { starts.push(clock.nowMs() - NOW); })));
  assert.deepEqual(starts, [0, 250, 500]);
  clock.advance(1000);
  await limiter.schedule(async () => { starts.push(clock.nowMs() - NOW); });
  assert.equal(starts[3], 1500, 'no wait once the interval has passed');
});

// ---------- HTTP provider ----------

test('HTTP provider sends the bearer key, encodes symbols and returns licensed provenance', async () => {
  const { p, calls } = provider((url) => url.endsWith('/v1/instruments') ? json(instrumentsBody) : json(candlesBody()));
  assert.equal(p.info.kind, 'licensed');
  assert.deepEqual((await p.listInstruments()).map((i) => i.symbol), ['M&M']);
  const result = await p.getCandles('M&M');
  assert.equal(calls[1].url, 'https://data.example.test/v1/candles/M%26M?limit=250');
  assert.equal(calls[1].headers.authorization, `Bearer ${KEY}`);
  assert.equal(result.candles.length, 2);
  assert.deepEqual({ ...result.provenance }, {
    providerId: 'test-vendor', kind: 'licensed', exchange: 'NSE', currency: 'INR', license: 'Test licence',
    // The second request starts 250 ms later because of rate-limit spacing.
    observedAt: '2026-10-29', ingestedAt: '2026-10-30T04:00:00.250Z', freshness: 'fresh', missingDates: [], rejected: []
  });
});

test('HTTP provider retries 5xx and network errors, then succeeds', async () => {
  const { p, calls, clock } = provider((_, n) => n === 1 ? json({}, 503) : n === 2 ? new TypeError('fetch failed') : json(candlesBody()));
  assert.equal((await p.getCandles('M&M')).candles.length, 2);
  assert.equal(calls.length, 3);
  assert.deepEqual(clock.sleeps.filter((ms) => ms !== 250), [500, 1000], 'backoff between attempts (250 ms entries are rate-limit spacing)');
});

test('HTTP provider waits for Retry-After on 429', async () => {
  const { p, clock } = provider((_, n) => n === 1 ? json({}, 429, { 'retry-after': '2' }) : json(candlesBody()));
  await p.getCandles('M&M');
  assert.ok(clock.sleeps.includes(2000));
});

test('HTTP provider surfaces auth, not-found, timeouts and exhausted retries without leaking the key', async () => {
  const auth = provider(() => json({ error: `bad key ${KEY}` }, 401));
  await rejectsWith(auth.p.getCandles('M&M'), 'auth');
  assert.equal(auth.calls.length, 1, 'no retry on 401');
  await rejectsWith(provider(() => json({}, 404)).p.getCandles('M&M'), 'not-found');
  const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  const slow = provider(() => timeout);
  const error = await rejectsWith(slow.p.getCandles('M&M'), 'unavailable');
  assert.match(error.message, /timed out after 10000 ms/);
  assert.equal(error.attempts, 4);
  assert.equal(slow.calls.length, 4);
  await rejectsWith(provider(() => json({}, 418)).p.getCandles('M&M'), 'invalid-response');
});

test('HTTP provider rejects malformed or mismatched responses instead of guessing', async () => {
  const cases: [Response, string][] = [
    [new Response('{nope', { status: 200 }), 'not valid JSON'],
    [json({ ...candlesBody(), symbol: 'TCS' }), 'expected M&M'],
    [json({ ...candlesBody(), currency: 'USD' }), 'expected NSE/INR'],
    [json({ symbol: 'M&M', exchange: 'NSE', currency: 'INR' }), 'candles list']
  ];
  for (const [response, message] of cases) {
    const { p, calls } = provider(() => response.clone());
    const error = await rejectsWith(p.getCandles('M&M'), 'invalid-response');
    assert.match(error.message, new RegExp(message));
    assert.equal(calls.length, 1, 'schema errors are not retried');
  }
  const badList = provider(() => json({ instruments: [{ ...instrumentsBody.instruments[0], exchange: 'BSE' }] }));
  await rejectsWith(badList.p.listInstruments(), 'invalid-response');
  const dupes = provider(() => json({ instruments: [instrumentsBody.instruments[0], instrumentsBody.instruments[0]] }));
  await rejectsWith(dupes.p.listInstruments(), 'invalid-response');
  await rejectsWith(provider(() => json({})).p.getCandles('bad symbol'), 'not-found');
});

test('HTTP provider flags stale data, gaps and rejected rows', async () => {
  const rows = { ...candlesBody(['2026-10-21', '2026-10-23']), candles: [candle('2026-10-21'), candle('2026-10-23'), { ...candle('2026-10-22'), low: 500 }] };
  const { p } = provider(() => json(rows), { holidays: ['2026-10-26'] });
  const { provenance } = await p.getCandles('M&M');
  assert.equal(provenance.freshness, 'stale', '27th-29th are completed sessions after the 23rd');
  assert.deepEqual(provenance.missingDates, ['2026-10-22']);
  assert.deepEqual(provenance.rejected.map((r) => r.date), ['2026-10-22']);
  const tolerant = provider(() => json(rows), { holidays: ['2026-10-26'], maxStaleSessions: 3 });
  assert.equal((await tolerant.p.getCandles('M&M')).provenance.freshness, 'fresh');
});

test('HTTP provider caches responses for the TTL and keeps the original ingestion time', async () => {
  const { p, calls, clock } = provider(() => json(candlesBody()), { cacheTtlMs: 60_000 });
  const first = await p.getCandles('M&M');
  clock.advance(30_000);
  const second = await p.getCandles('M&M');
  assert.equal(calls.length, 1);
  assert.equal(second.provenance.ingestedAt, first.provenance.ingestedAt);
  clock.advance(31_000);
  await p.getCandles('M&M');
  assert.equal(calls.length, 2, 'refetched after expiry');
  const uncached = provider(() => json(candlesBody()), { cacheTtlMs: 0 });
  await uncached.p.getCandles('M&M'); await uncached.p.getCandles('M&M');
  assert.equal(uncached.calls.length, 2);
});

test('validateHttpConfig enforces https, no URL credentials and a declared licence', () => {
  assert.deepEqual(validateHttpConfig(config()), []);
  assert.deepEqual(validateHttpConfig(config({ baseUrl: 'http://127.0.0.1:9000' })), [], 'local adapter allowed over http');
  const problems = (o: Partial<HttpProviderConfig>) => validateHttpConfig(config(o)).join(' | ');
  assert.match(problems({ baseUrl: 'http://data.example.test' }), /https/);
  assert.match(problems({ baseUrl: 'https://user:pass@data.example.test' }), /credentials/);
  assert.match(problems({ baseUrl: 'https://data.example.test/?token=x' }), /query string/);
  assert.match(problems({ baseUrl: 'not a url' }), /absolute URL/);
  assert.match(problems({ apiKey: 'short' }), /apiKey/);
  assert.match(problems({ license: ' ' }), /license/);
  assert.match(problems({ exchange: 'nse' }), /exchange/);
  assert.match(problems({ holidays: ['2026-13-01'] }), /holidays/);
  assert.throws(() => createHttpProvider(config({ license: '' }), { fetch, now: () => new Date(), sleep: async () => {}, random: Math.random }), /license is required/);
});

// ---------- configuration ----------

test('createProviderFromEnv defaults to demo and validates every http setting', () => {
  assert.equal(createProviderFromEnv({}).info.kind, 'demo');
  assert.equal(createProviderFromEnv({ MARKET_DATA_PROVIDER: 'fixture' }).info.kind, 'fixture');
  assert.throws(() => createProviderFromEnv({ MARKET_DATA_PROVIDER: 'scrape' }), /demo, fixture or http/);
  try {
    createProviderFromEnv({ MARKET_DATA_PROVIDER: 'http', MARKET_DATA_API_KEY: KEY, MARKET_DATA_TIMEOUT_MS: 'fast' });
    assert.fail('expected config error');
  } catch (error) {
    assert.ok(error instanceof ProviderError && error.code === 'config');
    for (const key of ['MARKET_DATA_BASE_URL', 'MARKET_DATA_LICENSE', 'MARKET_DATA_EXCHANGE', 'MARKET_DATA_TIMEOUT_MS']) assert.match(error.message, new RegExp(key));
    assert.equal(error.message.includes(KEY), false);
  }
  const http = createProviderFromEnv({
    MARKET_DATA_PROVIDER: 'http', MARKET_DATA_BASE_URL: 'https://data.example.test', MARKET_DATA_API_KEY: KEY,
    MARKET_DATA_LICENSE: 'Test licence', MARKET_DATA_EXCHANGE: 'NSE', MARKET_DATA_HOLIDAYS: '2026-10-02, 2026-10-30'
  });
  assert.deepEqual({ kind: http.info.kind, exchange: http.info.exchange, currency: http.info.currency }, { kind: 'licensed', exchange: 'NSE', currency: 'INR' });
  assert.throws(() => createProviderFromEnv({ MARKET_DATA_PROVIDER: 'fixture', MARKET_DATA_FIXTURE: '/nonexistent/fixture.json' }), /cannot read JSON/);
});

// ---------- fixture provider ----------

test('the committed fixture exercises fresh, stale, gappy and empty series', async () => {
  const fixture = loadFixtureProvider(undefined, () => new Date(NOW));
  assert.equal(fixture.info.kind, 'fixture');
  assert.match(fixture.info.license, /Synthetic/);
  const steady = await fixture.getCandles('FIX-STEADY');
  assert.equal(steady.provenance.freshness, 'fresh');
  assert.deepEqual(steady.provenance.missingDates, [], 'fixture holiday 2026-10-02 is not a gap');
  assert.equal((await fixture.getCandles('FIX-STALE')).provenance.freshness, 'stale');
  assert.equal((await fixture.getCandles('FIX-EMPTY')).provenance.freshness, 'unknown');
  const gappy = await fixture.getCandles('FIX-GAPPY');
  assert.deepEqual(gappy.provenance.rejected.map((r) => [r.date, r.reason.split(' ')[0]]), [
    ['2026-10-20', 'inconsistent'], ['2026-10-22', 'duplicate'], ['2026-10-22', 'duplicate'], ['2099-01-01', 'dated']
  ]);
  assert.deepEqual(gappy.provenance.missingDates, ['2026-10-13', '2026-10-14', '2026-10-20', '2026-10-22']);
  assert.ok(gappy.candles.every((c, i) => i === 0 || c.date > gappy.candles[i - 1].date), 'sorted ascending');
  await rejectsWith(fixture.getCandles('FIX-NOPE'), 'not-found');
});

test('fixture structure problems fail at load time', () => {
  const base = {
    schema: 'tradelens-market-fixture/v1', provider: { id: 'f', name: 'F', license: 'synthetic' },
    instruments: [{ symbol: 'FIX-A', name: 'A', sector: 'S', exchange: 'TEST', currency: 'INR' }], candles: {}
  };
  assert.equal(createFixtureProvider(base).info.exchange, 'TEST');
  const cases: [unknown, RegExp][] = [
    [{ ...base, schema: 'v0' }, /schema/],
    [{ ...base, provider: { id: 'f', name: 'F' } }, /license/],
    [{ ...base, instruments: [] }, /non-empty/],
    [{ ...base, instruments: [...base.instruments, { ...base.instruments[0], symbol: 'FIX-B', currency: 'USD' }] }, /one exchange and currency/],
    [{ ...base, instruments: [base.instruments[0], base.instruments[0]] }, /duplicate/],
    [{ ...base, candles: { 'FIX-Z': [] } }, /no instrument/],
    [{ ...base, holidays: ['soon'] }, /holidays/]
  ];
  for (const [data, expected] of cases) assert.throws(() => createFixtureProvider(data), expected);
});

// ---------- API wiring ----------

async function withApi(provider: MarketDataProvider, run: (base: string) => Promise<void>) {
  const server = createApp(provider);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected tcp address');
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test('API labels fixture data and reports provenance and unavailable instruments', async () => withApi(loadFixtureProvider(undefined, () => new Date(NOW)), async (base) => {
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.source, 'synthetic-fixture');
  assert.equal(health.provider.kind, 'fixture');
  const stocks = await (await fetch(`${base}/api/stocks`)).json();
  assert.deepEqual(stocks.data.map((s: { symbol: string }) => s.symbol).sort(), ['FIX-GAPPY', 'FIX-STALE', 'FIX-STEADY']);
  assert.deepEqual(stocks.unavailable, [{ symbol: 'FIX-EMPTY', reason: 'insufficient-data' }]);
  const stale = stocks.data.find((s: { symbol: string }) => s.symbol === 'FIX-STALE');
  assert.equal(stale.provenance.freshness, 'stale');
  assert.equal(stale.provenance.observedAt, '2026-09-15');
  const candles = await (await fetch(`${base}/api/stocks/FIX-GAPPY/candles?limit=5`)).json();
  assert.equal(candles.count, 5);
  assert.equal(candles.provenance.rejected.length, 4);
  assert.equal(candles.candles.at(-1).date, '2026-10-29', 'future-dated row never served');
  const unknown = await fetch(`${base}/api/stocks/DEMO-ALPHA`);
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error, 'Unknown symbol');
}));

test('API returns 502 with an error code when the provider fails, and lists per-symbol failures', async () => {
  const instruments = [{ symbol: 'FIX-A', name: 'A', sector: 'S', description: '', exchange: 'NSE', currency: 'INR' }, { symbol: 'M&M', name: 'M', sector: 'S', description: '', exchange: 'NSE', currency: 'INR' }];
  const info = { id: 'broken', name: 'Broken', kind: 'licensed' as const, exchange: 'NSE', currency: 'INR', license: 'test', timezone: 'Asia/Kolkata' as const };
  const listFails: MarketDataProvider = { info, listInstruments: async () => { throw new ProviderError('auth', 'rejected'); }, getCandles: async () => { throw new Error('unused'); } };
  await withApi(listFails, async (base) => {
    const response = await fetch(`${base}/api/stocks`);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'Market data provider unavailable', code: 'auth' });
    assert.equal((await fetch(`${base}/api/stocks/FIX-A/candles`)).status, 502);
  });
  const candlesFail: MarketDataProvider = {
    info, listInstruments: async () => instruments,
    getCandles: async (symbol) => { throw symbol === 'M&M' ? new ProviderError('rate-limited', '429', { retryable: true }) : new ProviderError('unavailable', 'down'); }
  };
  await withApi(candlesFail, async (base) => {
    const body = await (await fetch(`${base}/api/stocks`)).json();
    assert.equal(body.count, 0);
    assert.deepEqual(body.unavailable, [{ symbol: 'FIX-A', reason: 'unavailable' }, { symbol: 'M&M', reason: 'rate-limited' }]);
    const encoded = await fetch(`${base}/api/stocks/M%26M/candles`);
    assert.equal(encoded.status, 502, 'URL-encoded & symbol is routed to the provider');
    assert.equal((await encoded.json()).code, 'rate-limited');
    assert.equal((await fetch(`${base}/api/stocks/%E0%A4%A/candles`)).status, 404, 'malformed encoding');
  });
  const crashes: MarketDataProvider = { info, listInstruments: async () => { throw new TypeError('bug'); }, getCandles: async () => { throw new TypeError('bug'); } };
  await withApi(crashes, async (base) => assert.equal((await fetch(`${base}/api/stocks`)).status, 500));
});

test('demo provider keeps existing responses and adds not-applicable freshness', async () => withApi(createProviderFromEnv({}), async (base) => {
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.deepEqual({ status: health.status, source: health.source, warning: health.warning }, { status: 'ok', source: 'synthetic-demo', warning: 'No real market data is served' });
  const detail = await (await fetch(`${base}/api/stocks/DEMO-ALPHA`)).json();
  assert.equal(detail.stock.symbol, 'DEMO-ALPHA');
  assert.equal(detail.provenance.freshness, 'not-applicable');
  assert.equal(detail.provenance.exchange, 'DEMO');
  assert.equal((await (await fetch(`${base}/api/stocks/DEMO-NOPE`)).json()).error, 'Unknown demo symbol');
}));
