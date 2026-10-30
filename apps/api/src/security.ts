import { timingSafeEqual, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type ApiOptions = {
  accessToken?: string;
  maxRequestsPerMinute?: number;
  maxConcurrentRequests?: number;
  observe?: (event: { requestId: string; method: string; status: number; durationMs: number }) => void;
};
/** Single-workspace gate; no identity or tenancy is implied. Never trust forwarded headers. */
export function createGuard(options: ApiOptions) {
  let count = 0; let windowStart = Date.now(); let active = 0;
  return (request: IncomingMessage, response: ServerResponse): boolean => {
    const started = Date.now();
    const requestId = randomUUID();
    response.setHeader('x-request-id', requestId);
    response.setHeader('x-frame-options', 'DENY');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('cache-control', 'no-store');
    let admitted = false;
    response.once('close', () => {
      if (admitted) active--;
      try { options.observe?.({ requestId, method: ['GET', 'POST'].includes(request.method ?? '') ? request.method! : 'OTHER', status: response.statusCode, durationMs: Date.now() - started }); } catch { /* telemetry cannot affect requests */ }
    });
    const reject = (status: number, error: string) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error })); return false; };
    if (options.accessToken) {
      const expected = Buffer.from(`Bearer ${options.accessToken}`);
      const actual = Buffer.from(request.headers.authorization ?? '');
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return reject(401, 'Authentication required');
    }
    if (started - windowStart >= 60_000) { count = 0; windowStart = started; }
    if (++count > (options.maxRequestsPerMinute ?? 300)) { response.setHeader('retry-after', '60'); return reject(429, 'Request limit exceeded'); }
    if (active >= (options.maxConcurrentRequests ?? 16)) return reject(503, 'Server busy');
    active++; admitted = true;
    return true;
  };
}

export function securityFromEnv(env: NodeJS.ProcessEnv): ApiOptions {
  if (env.API_ACCESS_TOKEN && (env.API_ACCESS_TOKEN.length < 32 || /\s/.test(env.API_ACCESS_TOKEN))) throw new Error('API_ACCESS_TOKEN must contain at least 32 non-whitespace characters');
  if (env.NODE_ENV === 'production' && !env.API_ACCESS_TOKEN) throw new Error('Production requires API_ACCESS_TOKEN');
  return { accessToken: env.API_ACCESS_TOKEN, observe: event => console.log(JSON.stringify(event)) };
}
