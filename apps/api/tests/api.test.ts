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
