import { amount, instant } from '../../../packages/core/src/mtf/decimal.ts';
import { MARKET_SYMBOL } from '../../../packages/core/src/marketData.ts';

export type MtfPrice = { symbol: string; priceInr: string; marketAt: string; source: string; mode: 'LIVE' | 'DELAYED' | 'EOD' };
export type MtfQuoteFeed = { getQuotes(symbols: string[]): Promise<MtfPrice[]> };
export function validateMtfQuotes(raw: unknown, symbols: string[], now: number): MtfPrice[] {
  if (!Array.isArray(raw) || raw.length > symbols.length) throw new Error('Invalid quotes');
  const ids = new Set<string>();
  return raw.map(q => {
    if (!q || !symbols.includes(q.symbol) || ids.has(q.symbol) || !MARKET_SYMBOL.test(q.symbol) || !['LIVE', 'DELAYED', 'EOD'].includes(q.mode) || typeof q.source !== 'string' || !q.source.trim() || q.source.length > 120) throw new Error('Invalid quote');
    if (!amount(q.priceInr).gt(0) || instant(q.marketAt) > now) throw new Error('Invalid quote');
    ids.add(q.symbol); return { symbol: q.symbol, priceInr: q.priceInr, marketAt: q.marketAt, source: q.source, mode: q.mode };
  });
}
/** A user-operated licensed adapter, not an NSE website scraper. */
export function mtfQuoteFeedFromEnv(env: NodeJS.ProcessEnv): MtfQuoteFeed | undefined {
  if (!env.MTF_QUOTE_URL && !env.MTF_QUOTE_API_KEY && !env.MTF_QUOTE_LICENSE) return undefined;
  let url: URL;
  try { url = new URL(env.MTF_QUOTE_URL ?? ''); } catch { throw new Error('Invalid MTF quote configuration'); }
  if (url.protocol !== 'https:' || url.username || url.password || !env.MTF_QUOTE_API_KEY || !env.MTF_QUOTE_LICENSE?.trim()) throw new Error('MTF quotes require HTTPS, private credentials and a data license');
  return { async getQuotes(symbols) {
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.MTF_QUOTE_API_KEY}` }, body: JSON.stringify({ symbols }) });
    if (!response.ok || !response.body) throw new Error('Quote feed unavailable');
    const reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
    try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 65_536) throw new Error('Quote response too large'); parts.push(value); } }
    finally { await reader.cancel(); }
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
    return validateMtfQuotes(body.quotes, symbols, Date.now());
  } };
}
