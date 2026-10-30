import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { listStocks, getStock, getCandles } from './market.ts';
import { simulatePosition } from '../../../packages/core/src/scenario.ts';
import type { PositionScenarioInput } from '../../../packages/core/src/types.ts';

const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, headers);
  response.end(JSON.stringify(body));
}
async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 16_384) throw new Error('Body exceeds 16 KB');
    parts.push(buffer);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
function numberInRange(raw: string | null, fallback: number, min: number, max: number): number | null {
  if (raw === null) return fallback;
  if (!raw.trim()) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

export function createApp() {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;
    try {
      if (request.method === 'GET' && path === '/api/health') {
        return send(response, 200, { status: 'ok', source: 'synthetic-demo', warning: 'No real market data is served' });
      }
      if (request.method === 'GET' && path === '/api/stocks') {
        const search = (url.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 80);
        const trend = url.searchParams.get('trend') ?? 'all';
        const minRsi = numberInRange(url.searchParams.get('minRsi'), 0, 0, 100);
        const maxRsi = numberInRange(url.searchParams.get('maxRsi'), 100, 0, 100);
        if (minRsi === null || maxRsi === null || minRsi > maxRsi || !['all', 'above-sma', 'below-sma'].includes(trend)) {
          return send(response, 400, { error: 'Invalid screener filters' });
        }
        const data = listStocks().filter((s) =>
          (s.name.toLowerCase().includes(search) || s.symbol.toLowerCase().includes(search)) &&
          (trend === 'all' || s.trend === trend) &&
          s.rsi14 !== null && s.rsi14 >= minRsi && s.rsi14 <= maxRsi
        );
        return send(response, 200, { source: 'synthetic-demo', count: data.length, data });
      }
      const match = /^\/api\/stocks\/([A-Z0-9-]+)(?:\/(candles))?$/.exec(path);
      if (request.method === 'GET' && match) {
        const symbol = match[1];
        const stock = getStock(symbol);
        if (!stock) return send(response, 404, { error: 'Unknown demo symbol' });
        if (match[2] === 'candles') return send(response, 200, { source: 'synthetic-demo', symbol, candles: getCandles(symbol) });
        return send(response, 200, { source: 'synthetic-demo', stock });
      }
      if (request.method === 'POST' && path === '/api/scenarios') {
        if (!request.headers['content-type']?.startsWith('application/json')) return send(response, 415, { error: 'Expected application/json' });
        let input: unknown;
        try { input = await jsonBody(request); } catch { return send(response, 400, { error: 'Invalid or oversized JSON body' }); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) return send(response, 400, { error: 'Expected a scenario object' });
        const required: (keyof PositionScenarioInput)[] = ['budget', 'entryPrice', 'movePct', 'holdingDays', 'borrowedAmount', 'annualInterestPct', 'estimatedFees'];
        if (!required.every((key) => typeof (input as Record<string, unknown>)[key] === 'number')) return send(response, 400, { error: 'All seven numeric fields are required' });
        try {
          const result = simulatePosition(input as PositionScenarioInput);
          return send(response, 200, { source: 'hypothetical-user-input', result });
        } catch (error) {
          return send(response, 400, { error: error instanceof Error ? error.message : 'Invalid input' });
        }
      }
      return send(response, 404, { error: 'Endpoint not found' });
    } catch {
      return send(response, 500, { error: 'Internal server error' });
    }
  });
}
