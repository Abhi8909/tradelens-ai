import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { listStocks, getStock, getCandles } from './market.ts';
import { simulatePosition } from '../../../packages/core/src/scenario.ts';
import { MAX_CANDLE_LIMIT, latestCandles, parseCandleLimit } from '../../../packages/core/src/chart.ts';
import {
  PORTFOLIO_LIMITS, analyzePortfolio, compareScenarios, evaluateRiskLimits, validatePortfolio, validateRiskLimits, validateScenario
} from '../../../packages/core/src/portfolio.ts';
import type { PortfolioScenario, PositionScenarioInput } from '../../../packages/core/src/types.ts';

const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, headers);
  response.end(JSON.stringify(body));
}
async function jsonBody(request: IncomingMessage, maxBytes = 16_384): Promise<unknown> {
  const parts: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maxBytes) throw new Error(`Body exceeds ${maxBytes} bytes`);
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
        if (match[2] === 'candles') {
          const limit = parseCandleLimit(url.searchParams.get('limit'));
          if (limit === null) return send(response, 400, { error: `limit must be an integer from 1 to ${MAX_CANDLE_LIMIT}` });
          const candles = latestCandles(getCandles(symbol) ?? [], limit);
          return send(response, 200, { source: 'synthetic-demo', symbol, requested: limit, count: candles.length, candles });
        }
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
      if (request.method === 'POST' && path === '/api/portfolio-scenarios') {
        if (!request.headers['content-type']?.startsWith('application/json')) return send(response, 415, { error: 'Expected application/json' });
        let input: unknown;
        try { input = await jsonBody(request, 65_536); } catch { return send(response, 400, { error: 'Invalid or oversized JSON body' }); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) return send(response, 400, { error: 'Expected { portfolio, scenarios, limits }' });
        const body = input as Record<string, unknown>;
        const portfolio = validatePortfolio(body.portfolio);
        if (!portfolio.ok) return send(response, 400, { error: 'Invalid portfolio', details: portfolio.errors });
        const rawScenarios = body.scenarios ?? [];
        if (!Array.isArray(rawScenarios) || rawScenarios.length > PORTFOLIO_LIMITS.maxScenarios) {
          return send(response, 400, { error: 'Invalid scenarios', details: [`scenarios must be a list of at most ${PORTFOLIO_LIMITS.maxScenarios}`] });
        }
        const scenarios = rawScenarios.map((s, i) => validateScenario(s, portfolio.value, `scenario ${i + 1}`));
        const scenarioErrors = scenarios.flatMap((s) => s.ok ? [] : s.errors);
        if (scenarioErrors.length) return send(response, 400, { error: 'Invalid scenarios', details: scenarioErrors });
        const limits = validateRiskLimits(body.limits ?? {});
        if (!limits.ok) return send(response, 400, { error: 'Invalid risk limits', details: limits.errors });
        const analysis = analyzePortfolio(portfolio.value);
        const comparison = compareScenarios(portfolio.value, scenarios.map((s) => (s as { ok: true; value: PortfolioScenario }).value));
        return send(response, 200, {
          source: 'hypothetical-user-input', analysis, scenarios: comparison.results, worstScenario: comparison.worst,
          checks: evaluateRiskLimits(analysis, limits.value, comparison.results)
        });
      }
      return send(response, 404, { error: 'Endpoint not found' });
    } catch {
      return send(response, 500, { error: 'Internal server error' });
    }
  });
}
