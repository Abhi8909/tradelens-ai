import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.ts';
import { mtfQuoteFeedFromEnv, validateMtfQuotes } from '../src/mtfQuotes.ts';

test('MTF quote endpoint reports absent feed honestly, validates input and accepts configured quotes', async () => {
  for (const configured of [false, true]) {
    const server = createApp(undefined, configured ? { mtfQuoteFeed: { async getQuotes(symbols) { return symbols.map(symbol => ({ symbol, priceInr: '110', marketAt: new Date().toISOString(), source: 'Synthetic test adapter', mode: 'DELAYED' as const })); } } } : {});
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
    const post = (body: unknown) => fetch(`http://127.0.0.1:${address.port}/api/mtf/quotes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    try {
      for (const symbols of [[], ['../secret'], ['SYNTHETIC', 'SYNTHETIC'], Array(51).fill('X')]) assert.equal((await post({ symbols })).status, 400);
      const response = await post({ symbols: ['SYNTHETIC'] }); assert.equal(response.status, configured ? 200 : 503);
      const data = await response.json(); if (configured) assert.equal(data.quotes[0].priceInr, '110'); else assert.equal(data.code, 'QUOTE_FEED_NOT_CONFIGURED');
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }
});
test('MTF quote validation rejects wrong symbols, impossible prices, timestamps and unsupported modes', () => {
  const q = { symbol: 'SYNTHETIC', priceInr: '110', marketAt: '2026-01-01T00:00:00Z', source: 'Synthetic fixture', mode: 'LIVE' };
  const now = Date.parse('2026-01-02T00:00:00Z'); assert.equal(validateMtfQuotes([q], ['SYNTHETIC'], now).length, 1);
  for (const bad of [{ ...q, symbol: 'OTHER' }, { ...q, priceInr: '0' }, { ...q, marketAt: '2030-01-01T00:00:00Z' }, { ...q, mode: 'imaginary' }]) assert.throws(() => validateMtfQuotes([bad], ['SYNTHETIC'], now));
  assert.throws(() => validateMtfQuotes([q, q], ['SYNTHETIC'], now));
});
test('MTF quote configuration requires licensed HTTPS credentials and no URL credentials', () => {
  assert.equal(mtfQuoteFeedFromEnv({}), undefined);
  assert.throws(() => mtfQuoteFeedFromEnv({ MTF_QUOTE_URL: 'http://example.com' }));
  assert.throws(() => mtfQuoteFeedFromEnv({ MTF_QUOTE_URL: 'https://user:secret@example.com', MTF_QUOTE_API_KEY: 'secret', MTF_QUOTE_LICENSE: 'test' }));
  assert.ok(mtfQuoteFeedFromEnv({ MTF_QUOTE_URL: 'https://example.com/quotes', MTF_QUOTE_API_KEY: 'secret', MTF_QUOTE_LICENSE: 'Synthetic adapter test configuration' }));
});
