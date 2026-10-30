import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.ts';

async function withApi(run: (base: string) => Promise<void>) {
  const server = createApp();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected tcp address');
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test('health endpoint declares synthetic data', async () => withApi(async (base) => {
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).source, 'synthetic-demo');
}));

test('screener filters demo stocks and provides reproducible candles', async () => withApi(async (base) => {
  const response = await fetch(`${base}/api/stocks?q=alpha`);
  const body = await response.json();
  assert.equal(body.count, 1);
  assert.equal(body.data[0].symbol, 'DEMO-ALPHA');
  const candleResponse = await fetch(`${base}/api/stocks/DEMO-ALPHA/candles`);
  const candles = (await candleResponse.json()).candles;
  assert.equal(candles.length, 90);
  assert.ok(candles[0].high >= candles[0].close);
  assert.equal((await fetch(`${base}/api/stocks/DEMO-WHATEVER`)).status, 404);
}));

test('candles endpoint returns the latest N sessions for a valid limit', async () => withApi(async (base) => {
  const all = (await (await fetch(`${base}/api/stocks/DEMO-BETA/candles`)).json());
  assert.equal(all.requested, 90);
  assert.equal(all.count, 90);
  for (const limit of [1, 20, 60, 90]) {
    const response = await fetch(`${base}/api/stocks/DEMO-BETA/candles?limit=${limit}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.source, 'synthetic-demo');
    assert.equal(body.requested, limit);
    assert.equal(body.count, limit);
    assert.deepEqual(body.candles, all.candles.slice(-limit), 'window ends at the latest session');
  }
}));

test('candles endpoint rejects invalid limits without returning data', async () => withApi(async (base) => {
  for (const raw of ['0', '-1', '91', '1.5', 'abc', '20abc', '', '1e1', '%2020']) {
    const response = await fetch(`${base}/api/stocks/DEMO-ALPHA/candles?limit=${raw}`);
    assert.equal(response.status, 400, `limit=${raw}`);
    const body = await response.json();
    assert.equal(body.candles, undefined);
    assert.match(body.error, /limit/);
  }
  assert.equal((await fetch(`${base}/api/stocks/DEMO-NOPE/candles?limit=20`)).status, 404);
}));

test('scenario endpoint validates data and computes results', async () => withApi(async (base) => {
  const input = { budget: 10000, entryPrice: 100, movePct: -10, holdingDays: 60, borrowedAmount: 4000, annualInterestPct: 14, estimatedFees: 30 };
  const post = (value: unknown) => fetch(`${base}/api/scenarios`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const valid = await post(input);
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).result.quantity, 100);
  assert.equal((await post({ ...input, borrowedAmount: -1 })).status, 400);
  assert.equal((await post({ ...input, entryPrice: '100' })).status, 400);
}));

test('rejects malformed filters and unknown endpoints', async () => withApi(async (base) => {
  assert.equal((await fetch(`${base}/api/stocks?minRsi=hello`)).status, 400);
  assert.equal((await fetch(`${base}/api/stocks?trend=guess`)).status, 400);
  assert.equal((await fetch(`${base}/api/missing`)).status, 404);
}));

const portfolioRequest = {
  portfolio: {
    capital: 100000,
    positions: [
      { symbol: 'DEMO-ALPHA', sector: 'Industrials', quantity: 100, entryPrice: 200, stopPrice: 180, borrowedAmount: 10000, estimatedFees: 40 },
      { symbol: 'DEMO-BETA', sector: 'Financial Services', quantity: 50, entryPrice: 400, stopPrice: null, borrowedAmount: 0, estimatedFees: 30 }
    ]
  },
  scenarios: [
    { name: 'Flat', marketMovePct: 0, holdingDays: 30, annualInterestPct: 12 },
    { name: 'Industrials shock', marketMovePct: -5, sectorMovesPct: { Industrials: -25 }, holdingDays: 30, annualInterestPct: 12 }
  ],
  limits: { maxPositionPct: 15, maxTotalRiskPct: 5 }
};
const postPortfolio = (base: string, body: unknown, contentType = 'application/json') =>
  fetch(`${base}/api/portfolio-scenarios`, { method: 'POST', headers: { 'content-type': contentType }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('portfolio endpoint returns analysis, scenario comparison and explained limit checks', async () => withApi(async (base) => {
  const response = await postPortfolio(base, portfolioRequest);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.source, 'hypothetical-user-input');
  assert.equal(body.analysis.grossExposure, 40000);
  assert.equal(body.analysis.cashRemaining, 70000);
  assert.deepEqual(body.scenarios.map((s: { name: string }) => s.name), ['Flat', 'Industrials shock']);
  assert.equal(body.worstScenario, 'Industrials shock');
  assert.equal(body.scenarios[1].positions[0].moveSource, 'sector');
  const checks = Object.fromEntries(body.checks.map((c: { id: string }) => [c.id, c]));
  assert.equal(checks.maxPositionPct.status, 'breach');
  assert.equal(checks.maxTotalRiskPct.status, 'not-evaluable');
  assert.equal(body.checks.length, 2, 'unset limits are not reported');
}));

test('portfolio endpoint validates every part of the request', async () => withApi(async (base) => {
  const cases: [unknown, string][] = [
    [[], 'Expected { portfolio, scenarios, limits }'],
    [{ ...portfolioRequest, portfolio: { ...portfolioRequest.portfolio, capital: -1 } }, 'Invalid portfolio'],
    [{ ...portfolioRequest, portfolio: { capital: 1000, positions: [{ ...portfolioRequest.portfolio.positions[0], entryPrice: 0 }] } }, 'Invalid portfolio'],
    [{ ...portfolioRequest, scenarios: [{ name: 'Bad', marketMovePct: -150, holdingDays: 1, annualInterestPct: 1 }] }, 'Invalid scenarios'],
    [{ ...portfolioRequest, scenarios: Array(7).fill(portfolioRequest.scenarios[0]) }, 'Invalid scenarios'],
    [{ ...portfolioRequest, scenarios: [{ ...portfolioRequest.scenarios[0], sectorMovesPct: { Energy: -5 } }] }, 'Invalid scenarios'],
    [{ ...portfolioRequest, limits: { maxLeverage: 0 } }, 'Invalid risk limits']
  ];
  for (const [input, error] of cases) {
    const response = await postPortfolio(base, input);
    assert.equal(response.status, 400, error);
    const body = await response.json();
    assert.equal(body.error, error);
    assert.equal(body.analysis, undefined);
    if (error !== 'Expected { portfolio, scenarios, limits }') assert.ok(body.details.length > 0);
  }
  assert.equal((await postPortfolio(base, '{nope')).status, 400);
  assert.equal((await postPortfolio(base, portfolioRequest, 'text/plain')).status, 415);
  assert.equal((await postPortfolio(base, { padding: 'x'.repeat(70_000) })).status, 400, 'oversized body');
}));

test('existing scenario endpoint keeps its 16 KB body limit', async () => withApi(async (base) => {
  const response = await fetch(`${base}/api/scenarios`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(20_000) }) });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'Invalid or oversized JSON body');
}));
