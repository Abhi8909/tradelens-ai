import test from 'node:test';
import assert from 'node:assert/strict';
import { createNseMcpQuoteFeed, NSE_MCP_URL, parseNseMcpStock } from '../src/nseMcpQuotes.ts';

// Fabricated values and symbol only; no captured exchange datasets.
const now = Date.parse('2026-10-30T06:30:00Z');
const stock = (symbol = 'SYNTHETIC') => ({ content: [{ type: 'text', text: JSON.stringify({ updatedAt: '2026-10-30T06:30:00Z', stock: { symbol, type: 'CM', lastTradedPrice: '110.25', latestTimestamp: '2026-10-30 11:58:00' } }) }] });
function fakeServer(config: { notification404?: boolean; expiredOnce?: boolean; invalid?: string; oversize?: boolean; sse?: boolean } = {}) {
  const calls: { method: string; params?: { arguments?: { symbol: string } }; headers: Headers }[] = [];
  let expired = false; let sessions = 0;
  const fetch: typeof globalThis.fetch = async (url, options) => {
    assert.equal(String(url), NSE_MCP_URL); assert.equal(options?.redirect, 'error'); assert.ok(options?.signal);
    const body = JSON.parse(String(options?.body)); const headers = new Headers(options?.headers);
    assert.equal(headers.get('authorization'), null);
    calls.push({ ...body, headers });
    if (body.method === 'initialize') {
      sessions++; return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } }, { headers: { 'mcp-session-id': `synthetic-session-${sessions}` } });
    }
    assert.equal(headers.get('mcp-session-id'), `synthetic-session-${sessions}`);
    if (body.method === 'notifications/initialized') return new Response(null, { status: config.notification404 ? 404 : 202 });
    assert.equal(body.params.name, 'cm_get_stock_quote');
    if (config.expiredOnce && !expired) { expired = true; return new Response(null, { status: 404 }); }
    if (config.oversize) return new Response('x'.repeat(262_145));
    const symbol = body.params.arguments.symbol;
    const result = symbol === config.invalid ? { isError: true, content: [{ type: 'text', text: 'Synthetic missing stock' }] } : stock(symbol);
    const envelope = { jsonrpc: '2.0', id: body.id, result };
    if (config.sse !== false) return new Response(`: heartbeat\r\n\r\nevent:message\r\ndata:${JSON.stringify(envelope)}\r\n\r\n`, { headers: { 'content-type': 'text/event-stream' } });
    return Response.json(envelope);
  };
  return { fetch, calls };
}

test('NSE quotes parse exchange timestamp as IST, preserve actual observation and label delayed/EOD', () => {
  const quote = parseNseMcpStock(stock(), 'SYNTHETIC', now);
  assert.equal(quote.priceInr, '110.25'); assert.equal(quote.marketAt, '2026-10-30T06:28:00.000Z'); assert.equal(quote.mode, 'DELAYED');
  assert.match(quote.source, /NSE official MCP/);
  assert.equal(parseNseMcpStock(stock(), 'SYNTHETIC', Date.parse('2026-10-31T06:30:00Z')).mode, 'EOD');
});

test('NSE refuses mismatched symbols, missing observation dates, impossible prices and tool errors', () => {
  assert.throws(() => parseNseMcpStock(stock('OTHER'), 'SYNTHETIC', now));
  assert.throws(() => parseNseMcpStock({ isError: true, content: [] }, 'SYNTHETIC', now));
  for (const changes of [{ latestTimestamp: undefined }, { latestTimestamp: '2026-02-30 11:58:00' }, { lastTradedPrice: 0 }, { lastTradedPrice: 'NaN' }, { latestTimestamp: '2026-10-31 11:58:00' }]) {
    const raw = JSON.parse(stock().content[0].text); Object.assign(raw.stock, changes);
    assert.throws(() => parseNseMcpStock({ content: [{ type: 'text', text: JSON.stringify(raw) }] }, 'SYNTHETIC', now));
  }
});

test('NSE official handshake supports JSON/SSE, no API key and the service notification quirk', async () => {
  for (const sse of [true, false]) {
    const server = fakeServer({ notification404: true, sse });
    const feed = createNseMcpQuoteFeed({ fetch: server.fetch, now: () => now });
    const quotes = await feed.getQuotes(['SYNTHETIC']); assert.equal(quotes.length, 1);
    assert.deepEqual(server.calls.map(c => c.method), ['initialize', 'notifications/initialized', 'tools/call']);
  }
});

test('NSE caches 150 seconds without changing market timestamp or sharing mutable cache objects', async () => {
  const server = fakeServer(); let clock = now;
  const feed = createNseMcpQuoteFeed({ fetch: server.fetch, now: () => clock });
  const first = await feed.getQuotes(['SYNTHETIC']); const timestamp = first[0].marketAt; first[0].priceInr = '888';
  clock += 149_999; const cached = await feed.getQuotes(['SYNTHETIC']); cached[0].priceInr = '999';
  const second = await feed.getQuotes(['SYNTHETIC']); assert.equal(second[0].priceInr, '110.25'); assert.equal(second[0].marketAt, timestamp);
  assert.equal(server.calls.filter(c => c.method === 'tools/call').length, 1);
  clock++; await feed.getQuotes(['SYNTHETIC']); assert.equal(server.calls.filter(c => c.method === 'tools/call').length, 2);
});

test('NSE reinitializes one expired session and retries once', async () => {
  const server = fakeServer({ expiredOnce: true });
  const quotes = await createNseMcpQuoteFeed({ fetch: server.fetch, now: () => now }).getQuotes(['SYNTHETIC']);
  assert.equal(quotes.length, 1); assert.equal(server.calls.filter(c => c.method === 'initialize').length, 2);
});

test('NSE preserves partial successes, deduplicates in-flight symbols and bounds responses', async () => {
  const server = fakeServer({ invalid: 'MISSING' });
  const feed = createNseMcpQuoteFeed({ fetch: server.fetch, now: () => now });
  const quotes = await feed.getQuotes(['SYNTHETIC', 'MISSING']); assert.equal(quotes.length, 1);
  const pendingServer = fakeServer(); const concurrent = createNseMcpQuoteFeed({ fetch: pendingServer.fetch, now: () => now });
  await Promise.all([concurrent.getQuotes(['SYNTHETIC']), concurrent.getQuotes(['SYNTHETIC'])]);
  assert.equal(pendingServer.calls.filter(c => c.method === 'tools/call').length, 1);
  const large = fakeServer({ oversize: true });
  await assert.rejects(createNseMcpQuoteFeed({ fetch: large.fetch, now: () => now }).getQuotes(['SYNTHETIC']));
});

test('NSE malformed RPC IDs, protocol errors and network failures fail closed', async () => {
  for (const response of [Response.json({ jsonrpc: '2.0', id: -1, result: {} }), Response.json({ jsonrpc: '2.0', id: 1, error: { message: 'Synthetic failure' } })]) {
    await assert.rejects(createNseMcpQuoteFeed({ fetch: async () => response }).getQuotes(['SYNTHETIC']));
  }
  await assert.rejects(createNseMcpQuoteFeed({ fetch: async () => { throw new Error('Synthetic network failure'); } }).getQuotes(['SYNTHETIC']));
});
