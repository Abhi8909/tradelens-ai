import { createHash } from 'node:crypto';
import { assertHttp } from './store.ts';
export type KiteCredentials = { accessToken: string; brokerUserId: string; expiresAt: string };
export type KiteConfig = { apiKey: string; apiSecret: string; redirectUrl: string };
export type BrokerHolding = { symbol: string; exchange: string; isin: string; quantity: number; averagePriceInr: string; fundedOutstandingInr: null; source: 'KITE_SNAPSHOT'; needsReview: true; origin: 'HOLDING' | 'NET_POSITION' };
export class KiteReadOnlyClient {
  readonly config: KiteConfig; readonly fetcher: typeof fetch;
  constructor(config: KiteConfig, fetcher: typeof fetch = fetch) { this.config = config; this.fetcher = fetcher; }
  loginUrl(state: string) { const url = new URL('https://kite.zerodha.com/connect/login'); url.searchParams.set('v', '3'); url.searchParams.set('api_key', this.config.apiKey); url.searchParams.set('redirect_params', new URLSearchParams({ state }).toString()); return url.toString(); }
  async request(path: string, token?: string, data?: URLSearchParams) {
    assertHttp(['/session/token', '/portfolio/holdings', '/portfolio/positions'].includes(path), 400, 'Only read-only broker operations are supported');
    assertHttp(!data || path === '/session/token', 400, 'Broker portfolio writes are disabled');
    const response = await this.fetcher(`https://api.kite.trade${path}`, { method: data ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { 'X-Kite-Version': '3', ...(token ? { Authorization: `token ${this.config.apiKey}:${token}` } : {}), ...(data ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: data?.toString() });
    assertHttp(response.ok && response.body, response.status === 401 || response.status === 403 ? 401 : 502, 'Broker session expired or unavailable. Reconnect to Kite.');
    const reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
    try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; assertHttp(size <= 2_000_000, 502, 'Broker response exceeds supported size'); parts.push(value); } } finally { await reader.cancel(); }
    const json = JSON.parse(Buffer.concat(parts).toString('utf8')); assertHttp(json.status === 'success' && json.data, 502, 'Invalid broker response'); return json.data;
  }
  async revoke(credentials: KiteCredentials) {
    const url=new URL('https://api.kite.trade/session/token');url.searchParams.set('api_key',this.config.apiKey);url.searchParams.set('access_token',credentials.accessToken);
    const response=await this.fetcher(url,{method:'DELETE',redirect:'error',signal:AbortSignal.timeout(10_000),headers:{'X-Kite-Version':'3'}});await response.body?.cancel();assertHttp(response.ok,502,'Local connection removed; broker session revocation could not be confirmed');
  }
  async exchange(requestToken: string): Promise<KiteCredentials> {
    assertHttp(/^[A-Za-z0-9_-]{8,200}$/.test(requestToken), 400, 'Invalid broker request token');
    const checksum = createHash('sha256').update(this.config.apiKey + requestToken + this.config.apiSecret).digest('hex');
    const data = await this.request('/session/token', undefined, new URLSearchParams({ api_key: this.config.apiKey, request_token: requestToken, checksum }));
    assertHttp(typeof data.access_token === 'string' && typeof data.user_id === 'string', 502, 'Invalid broker credentials response');
    const now = Date.now(); const ist = new Date(now + 19_800_000); const day = ist.toISOString().slice(0, 10);
    let expires = Date.parse(`${day}T06:00:00+05:30`); if (expires <= now) expires += 86_400_000;
    return { accessToken: data.access_token, brokerUserId: data.user_id, expiresAt: new Date(expires).toISOString() };
  }
  async holdings(credentials: KiteCredentials): Promise<BrokerHolding[]> {
    assertHttp(Date.parse(credentials.expiresAt) > Date.now(), 401, 'Broker session expired. Reconnect to Kite.');
    const data = await this.request('/portfolio/holdings', credentials.accessToken); assertHttp(Array.isArray(data), 502, 'Invalid holdings response');
    const holdings: BrokerHolding[] = data.filter(row => row.exchange === 'NSE' && Number(row.mtf?.quantity) > 0).map(row => {
      assertHttp(typeof row.tradingsymbol === 'string' && typeof row.isin === 'string' && Number.isInteger(row.mtf.quantity) && Number.isFinite(row.mtf.average_price) && row.mtf.average_price > 0, 502, 'Invalid MTF holding');
      return { symbol: row.tradingsymbol, exchange: row.exchange, isin: row.isin, quantity: row.mtf.quantity, averagePriceInr: String(row.mtf.average_price), fundedOutstandingInr: null, source: 'KITE_SNAPSHOT', needsReview: true, origin: 'HOLDING' };
    });
    const positions = await this.request('/portfolio/positions', credentials.accessToken);
    assertHttp(positions && Array.isArray(positions.net), 502, 'Invalid positions response');
    const net: BrokerHolding[] = positions.net.filter((row: Record<string, unknown>) => row.exchange === 'NSE' && row.product === 'MTF' && Number(row.quantity) > 0).map((row: Record<string, unknown>) => {
      assertHttp(typeof row.tradingsymbol === 'string' && Number.isSafeInteger(row.quantity) && Number.isFinite(row.average_price) && Number(row.average_price) > 0, 502, 'Invalid MTF position');
      return { symbol: row.tradingsymbol, exchange: 'NSE', isin: '', quantity: Number(row.quantity), averagePriceInr: String(row.average_price), fundedOutstandingInr: null, source: 'KITE_SNAPSHOT', needsReview: true, origin: 'NET_POSITION' };
    });
    // Keep the endpoint origins separate. Holdings and net positions may overlap;
    // neither snapshot is an authoritative purchase/funding ledger.
    return [...holdings, ...net];
  }
}
export function kiteFromEnv(env: NodeJS.ProcessEnv) {
  if (!env.KITE_API_KEY && !env.KITE_API_SECRET && !env.KITE_REDIRECT_URL) return undefined;
  assertHttp(env.KITE_API_KEY && env.KITE_API_SECRET && env.KITE_REDIRECT_URL, 500, 'Kite requires API key, secret and registered redirect URL');
  const redirect = new URL(env.KITE_REDIRECT_URL); assertHttp(redirect.pathname === '/api/mtf/broker/callback' && !redirect.search && !redirect.hash && (!env.MTF_APP_ORIGIN || redirect.origin === env.MTF_APP_ORIGIN), 500, 'Kite callback must match your application origin and callback path'); assertHttp(redirect.protocol === 'https:' || (redirect.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(redirect.hostname)), 500, 'Invalid broker redirect URL');
  return new KiteReadOnlyClient({ apiKey: env.KITE_API_KEY, apiSecret: env.KITE_API_SECRET, redirectUrl: redirect.toString() });
}
