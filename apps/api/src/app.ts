import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { MARKET_SYMBOL, buildStockSummary, type DataProvenance, type Instrument, type ProviderKind } from '../../../packages/core/src/marketData.ts';
import { runBacktest, validateBacktestConfig } from '../../../packages/core/src/backtest.ts';
import { createDemoProvider } from './providers/demo.ts';
import { ProviderError, type CandleResult, type MarketDataProvider } from './providers/types.ts';
import { simulatePosition } from '../../../packages/core/src/scenario.ts';
import { MAX_CANDLE_LIMIT, latestCandles, parseCandleLimit } from '../../../packages/core/src/chart.ts';
import {
  PORTFOLIO_LIMITS, analyzePortfolio, compareScenarios, evaluateRiskLimits, validatePortfolio, validateRiskLimits, validateScenario
} from '../../../packages/core/src/portfolio.ts';
import type { PortfolioScenario, PositionScenarioInput, StockSummary } from '../../../packages/core/src/types.ts';
import { mockResearchProvider, runResearch, validateResearchInput, type ResearchProvider } from './research.ts';
import { validateMtfQuotes, type MtfQuoteFeed } from './mtfQuotes.ts';
import type { MtfService } from './mtf/service.ts';
import { createGuard, type ApiOptions } from './security.ts';

const SOURCES: Record<ProviderKind, string> = { demo: 'synthetic-demo', fixture: 'synthetic-fixture', licensed: 'licensed-provider' };
const WARNINGS: Record<ProviderKind, string> = {
  demo: 'No real market data is served',
  fixture: 'Synthetic fixture data for testing; not market data',
  licensed: 'Licensed provider data: check provenance and freshness flags before relying on it'
};

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
/** Provider problems are an upstream failure (502), never a crash; credentials never appear in the body. */
function providerFailure(response: ServerResponse, error: unknown) {
  if (!(error instanceof ProviderError)) throw error;
  return send(response, 502, { error: 'Market data provider unavailable', code: error.code });
}
function numberInRange(raw: string | null, fallback: number, min: number, max: number): number | null {
  if (raw === null) return fallback;
  if (!raw.trim()) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

export function createApp(provider: MarketDataProvider = createDemoProvider(), options: ApiOptions & { research?: ResearchProvider; mtfQuoteFeed?: MtfQuoteFeed; mtf?: MtfService } = {}) {
  const source = SOURCES[provider.info.kind];
  const guard = createGuard(options);
  return createServer(async (request, response) => {
    try {
      if (!guard(request, response)) return;
      const url = new URL(request.url ?? '/', 'http://localhost');
      const path = url.pathname;
      if (options.mtf && await options.mtf.handle(request, response, url)) return;
      if (request.method === 'POST' && path === '/api/mtf/quotes') {
        if (!request.headers['content-type']?.startsWith('application/json')) return send(response, 415, { error: 'Expected application/json' });
        let raw: unknown;
        try { raw = await jsonBody(request, 4096); } catch { return send(response, 400, { error: 'Invalid quote request' }); }
        const symbols = raw && typeof raw === 'object' ? (raw as { symbols?: unknown }).symbols : null;
        if (!Array.isArray(symbols) || !symbols.length || symbols.length > 50 || new Set(symbols).size !== symbols.length || symbols.some(s => typeof s !== 'string' || !MARKET_SYMBOL.test(s))) return send(response, 400, { error: 'Expected 1–50 unique scrip symbols' });
        if (!options.mtfQuoteFeed) return send(response, 503, { error: 'Automatic quote feed is disabled. You can enter current prices manually.', code: 'QUOTE_FEED_NOT_CONFIGURED' });
        try {
          const quotes = validateMtfQuotes(await options.mtfQuoteFeed.getQuotes(symbols), symbols, Date.now());
          return send(response, 200, { quotes, unavailable: symbols.filter(s => !quotes.some(q => q.symbol === s)), fetchedAt: new Date().toISOString() });
        } catch { return send(response, 502, { error: 'Quote service unavailable or scrip not found. Check the NSE symbol or enter a current price manually.' }); }
      }
      if (request.method === 'POST' && path === '/api/research') {
        if (!request.headers['content-type']?.startsWith('application/json')) return send(response, 415, { error: 'Expected application/json' });
        let raw: unknown;
        try { raw = await jsonBody(request); } catch { return send(response, 400, { error: 'Invalid or oversized JSON body' }); }
        const input = validateResearchInput(raw);
        if (!input) return send(response, 400, { error: 'Expected symbol, thesis (1–2000 characters), direction (rising/falling), action (review/argue-against)' });
        try { return send(response, 200, await runResearch(provider, options.research ?? mockResearchProvider, input)); }
        catch { return send(response, 502, { error: 'Research tools or provider unavailable; no claims generated' }); }
      }
      if (request.method === 'GET' && path === '/api/health') {
        return send(response, 200, { status: 'ok', source, warning: WARNINGS[provider.info.kind], provider: provider.info });
      }
      if (request.method === 'GET' && path === '/api/stocks') {
        const search = (url.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 80);
        const trend = url.searchParams.get('trend') ?? 'all';
        const minRsi = numberInRange(url.searchParams.get('minRsi'), 0, 0, 100);
        const maxRsi = numberInRange(url.searchParams.get('maxRsi'), 100, 0, 100);
        if (minRsi === null || maxRsi === null || minRsi > maxRsi || !['all', 'above-sma', 'below-sma'].includes(trend)) {
          return send(response, 400, { error: 'Invalid screener filters' });
        }
        let instruments: Instrument[];
        try { instruments = await provider.listInstruments(); } catch (error) { return providerFailure(response, error); }
        // Filter by name first so a remote provider is only asked for candles it needs.
        const matching = instruments.filter((i) => i.name.toLowerCase().includes(search) || i.symbol.toLowerCase().includes(search));
        const settled = await Promise.allSettled(matching.map((i) => provider.getCandles(i.symbol)));
        const data: (StockSummary & { provenance: DataProvenance })[] = [];
        const unavailable: { symbol: string; reason: string }[] = [];
        settled.forEach((outcome, index) => {
          const instrument = matching[index];
          if (outcome.status === 'rejected') {
            if (!(outcome.reason instanceof ProviderError)) throw outcome.reason;
            unavailable.push({ symbol: instrument.symbol, reason: outcome.reason.code });
            return;
          }
          const stock = buildStockSummary(instrument, outcome.value.candles);
          if (!stock) unavailable.push({ symbol: instrument.symbol, reason: 'insufficient-data' });
          else if ((trend === 'all' || stock.trend === trend) && stock.rsi14 !== null && stock.rsi14 >= minRsi && stock.rsi14 <= maxRsi) {
            data.push({ ...stock, provenance: outcome.value.provenance });
          }
        });
        return send(response, 200, { source, count: data.length, data, unavailable, provider: provider.info });
      }
      const match = /^\/api\/stocks\/([^/]+)(?:\/(candles))?$/.exec(path);
      if (request.method === 'GET' && match) {
        const unknown = () => send(response, 404, { error: provider.info.kind === 'demo' ? 'Unknown demo symbol' : 'Unknown symbol' });
        let symbol: string;
        try { symbol = decodeURIComponent(match[1]); } catch { return unknown(); }
        if (!MARKET_SYMBOL.test(symbol)) return unknown();
        let instrument: Instrument | undefined;
        try { instrument = (await provider.listInstruments()).find((i) => i.symbol === symbol); } catch (error) { return providerFailure(response, error); }
        if (!instrument) return unknown();
        const limit = match[2] === 'candles' ? parseCandleLimit(url.searchParams.get('limit')) : MAX_CANDLE_LIMIT;
        if (limit === null) return send(response, 400, { error: `limit must be an integer from 1 to ${MAX_CANDLE_LIMIT}` });
        let result: CandleResult;
        try { result = await provider.getCandles(symbol); } catch (error) {
          if (error instanceof ProviderError && error.code === 'not-found') return unknown();
          return providerFailure(response, error);
        }
        if (match[2] === 'candles') {
          const candles = latestCandles(result.candles, limit);
          return send(response, 200, { source, symbol, requested: limit, count: candles.length, candles, provenance: result.provenance });
        }
        return send(response, 200, { source, stock: buildStockSummary(instrument, result.candles), provenance: result.provenance });
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
      if (request.method === 'POST' && path === '/api/backtests') {
        if (!request.headers['content-type']?.startsWith('application/json')) return send(response, 415, { error: 'Expected application/json' });
        let input: unknown;
        try { input = await jsonBody(request); } catch { return send(response, 400, { error: 'Invalid or oversized JSON body' }); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) return send(response, 400, { error: 'Expected { symbol, config }' });
        const { symbol, config } = input as Record<string, unknown>;
        if (typeof symbol !== 'string' || !MARKET_SYMBOL.test(symbol)) return send(response, 400, { error: 'Invalid backtest', details: ['symbol must be an instrument symbol'] });
        const validated = validateBacktestConfig(config);
        if (!validated.ok) return send(response, 400, { error: 'Invalid backtest', details: validated.errors });
        let candles: CandleResult;
        try { candles = await provider.getCandles(symbol); } catch (error) {
          if (error instanceof ProviderError && error.code === 'not-found') return send(response, 404, { error: provider.info.kind === 'demo' ? 'Unknown demo symbol' : 'Unknown symbol' });
          return providerFailure(response, error);
        }
        try {
          const result = runBacktest(validated.value, candles.candles);
          return send(response, 200, { source, symbol, provenance: candles.provenance, result });
        } catch (error) {
          if (error instanceof RangeError) return send(response, 400, { error: 'Invalid backtest', details: [error.message] });
          throw error;
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
