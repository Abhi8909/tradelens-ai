import { Agent, request as httpsRequest } from 'node:https';
import { amount, instant } from '../../../packages/core/src/mtf/decimal.ts';
import { MARKET_SYMBOL } from '../../../packages/core/src/marketData.ts';
import type { MtfPrice, MtfQuoteFeed } from './mtfQuotes.ts';

// Official, documented no-auth interface for informational/non-commercial use.
// https://www.nseindia.com/nse-mcp — never uses the website's private endpoints.
export const NSE_MCP_URL = 'https://mcp.nseindia.in/cmmkt/mcp';
const PROTOCOL = '2025-03-26';
const SOURCE = 'NSE official MCP · non-commercial';
const MAX_BYTES = 262_144;
type RpcResult = { content?: { type: string; text?: string }[]; isError?: boolean; protocolVersion?: string };
class NseSessionExpired extends Error {}
type Envelope = { jsonrpc?: string; id?: number; result?: RpcResult; error?: unknown };

/** NSE's stock timestamp is exchange-local, unlike its cache updatedAt timestamp. */
export function parseNseMcpStock(result: RpcResult, symbol: string, now: number): MtfPrice {
  if (result.isError || !Array.isArray(result.content)) throw new Error('NSE quote unavailable');
  const blocks = result.content.filter(c => c.type === 'text' && typeof c.text === 'string');
  if (blocks.length !== 1) throw new Error('Invalid NSE quote');
  const data = JSON.parse(blocks[0].text!); const stock = data?.stock;
  if (!stock || stock.symbol !== symbol || stock.type !== 'CM' || !MARKET_SYMBOL.test(symbol)) throw new Error('NSE symbol mismatch');
  const value = stock.lastTradedPrice;
  if ((typeof value !== 'number' && typeof value !== 'string') || !amount(String(value)).gt(0)) throw new Error('Invalid NSE price');
  if (typeof stock.latestTimestamp !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(stock.latestTimestamp)) throw new Error('Missing NSE market timestamp');
  const marketAt = new Date(instant(`${stock.latestTimestamp.replace(' ', 'T')}+05:30`)).toISOString();
  if (Date.parse(marketAt) > now) throw new Error('Future NSE quote');
  const istNow = new Date(now + 19_800_000);
  const minute = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();
  const weekday = istNow.getUTCDay();
  // Exchange says data is delayed 1–3 minutes. Never claim tick-by-tick LIVE.
  const inSession = weekday >= 1 && weekday <= 5 && minute >= 555 && minute < 930;
  return { symbol, priceInr: String(value), marketAt, source: SOURCE, mode: inSession ? 'DELAYED' : 'EOD' };
}

/** Serialize the stateful service's HTTP exchanges on one keep-alive connection.
 * Keep response buffers bounded; do not leave SSE readers/sockets open between polls. */
function createNseTransport(): typeof fetch {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  return async (url, options) => {
    if (String(url) !== NSE_MCP_URL || options?.method !== 'POST' || typeof options.body !== 'string') throw new Error('Invalid NSE request');
    const body = options.body;
    const headers = Object.fromEntries(new Headers(options.headers).entries());
    headers['content-length'] = String(Buffer.byteLength(body));
    return new Promise<Response>((resolve, reject) => {
      const req = httpsRequest(NSE_MCP_URL, { method: 'POST', headers, agent, signal: options.signal ?? undefined }, response => {
        const parts: Buffer[] = []; let bytes = 0;
        response.on('data', (part: Buffer) => {
          bytes += part.length;
          if (bytes > MAX_BYTES) { response.destroy(new Error('NSE response too large')); return; }
          parts.push(part);
        });
        response.once('error', reject);
        response.once('end', () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
          const status = response.statusCode ?? 502;
          resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(parts), { status, headers: responseHeaders }));
        });
      });
      req.once('error', reject); req.end(body);
    });
  };
}

export function createNseMcpQuoteFeed(deps: { fetch?: typeof fetch; now?: () => number } = {}): MtfQuoteFeed {
  const request = deps.fetch ?? createNseTransport(); const now = deps.now ?? Date.now;
  let session: string | null = null; let initializing: Promise<void> | null = null; let counter = 0;
  const cache = new Map<string, { quote: MtfPrice; fetchedAt: number }>();
  const inflight = new Map<string, Promise<MtfPrice>>();
  async function post(method: string, params: unknown, signal: AbortSignal, notification = false): Promise<RpcResult> {
    const id = notification ? undefined : ++counter;
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (session) headers['mcp-session-id'] = session;
    const response = await request(NSE_MCP_URL, { method: 'POST', headers, redirect: 'error', signal,
      body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) }) });
    // NSE currently returns 404 for some initialized notifications even though
    // the session can serve tools/call. The notification has no result to read.
    if (notification && response.status === 404) { await response.body?.cancel(); return {}; }
    if (!response.ok) { await response.body?.cancel(); if (response.status === 404) { session = null; throw new NseSessionExpired('NSE session expired'); } throw new Error('NSE service unavailable'); }
    if (method === 'initialize') session = response.headers.get('mcp-session-id');
    if (notification) { await response.body?.cancel(); return {}; }
    if (!response.body) throw new Error('Empty NSE response');
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let text = ''; let bytes = 0;
    let envelope: Envelope | undefined;
    const sse = response.headers.get('content-type')?.includes('text/event-stream');
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) { text += decoder.decode(); break; }
        bytes += value.byteLength; if (bytes > MAX_BYTES) throw new Error('NSE response too large');
        text += decoder.decode(value, { stream: true });
        if (sse) {
          const events = text.replaceAll('\r\n', '\n').split('\n\n'); text = events.pop()!;
          for (const event of events) {
            const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!data) continue;
            const item = JSON.parse(data) as Envelope;
            if (item.id === id) { envelope = item; break; }
          }
          if (envelope) break;
        }
      }
    } finally { await reader.cancel(); }
    if (!sse) envelope = JSON.parse(text) as Envelope;
    if (!envelope || envelope.jsonrpc !== '2.0' || envelope.id !== id || envelope.error || !envelope.result) throw new Error('Invalid NSE MCP response');
    return envelope.result;
  }
  async function initialize(signal: AbortSignal) {
    if (session) return;
    if (!initializing) initializing = (async () => {
      const result = await post('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'tradelens-research', version: '0.1.0' } }, signal);
      if (result.protocolVersion !== PROTOCOL) throw new Error('Unsupported NSE protocol');
      await post('notifications/initialized', undefined, signal, true);
    })().catch(error => { session = null; throw error; }).finally(() => { initializing = null; });
    await initializing;
  }
  async function quote(symbol: string, signal: AbortSignal): Promise<MtfPrice> {
    const existing = cache.get(symbol);
    if (existing && now() - existing.fetchedAt < 150_000) return { ...existing.quote };
    const pending = inflight.get(symbol); if (pending) return pending;
    const task = (async () => {
      await initialize(signal);
      const params = { name: 'cm_get_stock_quote', arguments: { symbol } };
      let result: RpcResult;
      try { result = await post('tools/call', params, signal); }
      catch (error) {
        if (!(error instanceof NseSessionExpired) || signal.aborted) throw error;
        await initialize(signal); result = await post('tools/call', params, signal);
      }
      const parsed = parseNseMcpStock(result, symbol, now());
      if (cache.size >= 2000) cache.delete(cache.keys().next().value!);
      cache.set(symbol, { quote: { ...parsed }, fetchedAt: now() }); return { ...parsed };
    })().finally(() => inflight.delete(symbol));
    inflight.set(symbol, task); return task;
  }
  return { async getQuotes(symbols) {
    if (!symbols.length || symbols.length > 50 || symbols.some(s => !MARKET_SYMBOL.test(s))) throw new Error('Invalid symbols');
    const signal = AbortSignal.timeout(10_000); const results: MtfPrice[] = []; let index = 0; let failures = 0;
    await Promise.all(Array.from({ length: Math.min(3, symbols.length) }, async () => {
      while (index < symbols.length) {
        const symbol = symbols[index++];
        try { results.push(await quote(symbol, signal)); } catch { failures++; }
      }
    }));
    if (!results.length && failures) throw new Error('NSE quote service unavailable or symbols not found');
    return results.sort((a, b) => symbols.indexOf(a.symbol) - symbols.indexOf(b.symbol));
  } };
}
