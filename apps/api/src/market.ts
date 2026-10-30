import { buildStockSummary } from '../../../packages/core/src/marketData.ts';
import type { Candle, Company, StockSummary } from '../../../packages/core/src/types.ts';

/** Every ticker and price in this module is fictional and generated locally. */
export const COMPANIES: Company[] = [
  { symbol: 'DEMO-ALPHA', name: 'Alpha Manufacturing (demo)', sector: 'Industrials', description: 'Synthetic industrial company for product testing.' },
  { symbol: 'DEMO-BETA', name: 'Beta Financial (demo)', sector: 'Financial Services', description: 'Synthetic financial company for product testing.' },
  { symbol: 'DEMO-GAMMA', name: 'Gamma Software (demo)', sector: 'Technology', description: 'Synthetic technology company for product testing.' },
  { symbol: 'DEMO-DELTA', name: 'Delta Energy (demo)', sector: 'Energy', description: 'Synthetic energy company for product testing.' },
  { symbol: 'DEMO-EPSILON', name: 'Epsilon Consumer (demo)', sector: 'Consumer', description: 'Synthetic consumer company for product testing.' },
  { symbol: 'DEMO-ZETA', name: 'Zeta Healthcare (demo)', sector: 'Healthcare', description: 'Synthetic healthcare company for product testing.' }
];

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
const round = (n: number) => Math.round(n * 100) / 100;
export function createDemoCandles(index: number, days = 90): Candle[] {
  const random = rng(1759 + index * 77);
  const series: Candle[] = [];
  let price = 85 + index * 53;
  const date = new Date('2026-06-01T00:00:00.000Z');
  while (series.length < days) {
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      const drift = [0.0024, -0.0013, 0.001, -0.0006, 0.0012, 0.0008][index];
      const shock = (random() - 0.5) * 0.048;
      const open = price;
      const close = Math.max(2, open * (1 + drift + shock));
      const high = Math.max(open, close) * (1 + random() * 0.013);
      const low = Math.min(open, close) * (1 - random() * 0.013);
      series.push({ date: date.toISOString().slice(0, 10), open: round(open), high: round(high), low: round(low), close: round(close), volume: Math.floor(20000 + random() * 450000) });
      price = close;
    }
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return series;
}

const CANDLE_MAP = new Map(COMPANIES.map((company, index) => [company.symbol, createDemoCandles(index)]));
export function getCandles(symbol: string): Candle[] | undefined { return CANDLE_MAP.get(symbol); }
export function getStock(symbol: string): StockSummary | undefined {
  const company = COMPANIES.find((item) => item.symbol === symbol);
  const candles = getCandles(symbol);
  if (!company || !candles) return undefined;
  return buildStockSummary(company, candles) ?? undefined;
}
export function listStocks(): StockSummary[] { return COMPANIES.map((c) => getStock(c.symbol)!); }
