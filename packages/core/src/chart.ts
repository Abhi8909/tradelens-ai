import type { Candle } from './types.ts';

/** Selectable chart ranges, in demo trading sessions. */
export const CANDLE_RANGES = [20, 60, 90] as const;
export type CandleRange = (typeof CANDLE_RANGES)[number];
export const MAX_CANDLE_LIMIT = 90;

/** Latest `limit` candles, oldest first. Returns fewer when history is sparse. */
export function latestCandles(candles: Candle[], limit: number): Candle[] {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer');
  return candles.slice(-limit);
}

/** Strict query parser: only a plain integer string in [1, max] is accepted. */
export function parseCandleLimit(raw: string | null, max = MAX_CANDLE_LIMIT): number | null {
  if (raw === null) return max;
  if (!/^[1-9]\d{0,3}$/.test(raw)) return null;
  const limit = Number(raw);
  return limit <= max ? limit : null;
}

export function isValidCandle(c: Candle): boolean {
  const prices = [c.open, c.high, c.low, c.close];
  return /^\d{4}-\d{2}-\d{2}$/.test(c.date) && prices.every((p) => Number.isFinite(p) && p > 0) &&
    c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close) && c.low <= c.high;
}

export type CandleShape = {
  date: string; x: number; bodyWidth: number;
  wickTop: number; wickBottom: number; bodyTop: number; bodyHeight: number;
  direction: 'up' | 'down' | 'flat';
};

/** Map candles to SVG coordinates (y grows downwards). Invalid candles throw rather than draw misleading bars. */
export function candleGeometry(candles: Candle[], width: number, height: number, padding = 4): CandleShape[] {
  if (!(width > 0 && height > 2 * padding)) throw new RangeError('chart dimensions too small');
  if (candles.length === 0) return [];
  const bad = candles.find((c) => !isValidCandle(c));
  if (bad) throw new RangeError(`invalid candle on ${bad.date}`);
  const low = Math.min(...candles.map((c) => c.low));
  const high = Math.max(...candles.map((c) => c.high));
  const range = high - low || 1;
  const plot = height - 2 * padding;
  const y = (price: number) => padding + ((high - price) / range) * plot;
  const slot = width / candles.length;
  const bodyWidth = Math.max(1, slot * 0.6);
  return candles.map((c, i) => {
    const top = y(Math.max(c.open, c.close));
    return {
      date: c.date,
      x: slot * i + slot / 2,
      bodyWidth,
      wickTop: y(c.high),
      wickBottom: y(c.low),
      bodyTop: top,
      bodyHeight: Math.max(1, y(Math.min(c.open, c.close)) - top),
      direction: c.close > c.open ? 'up' : c.close < c.open ? 'down' : 'flat'
    };
  });
}

export type CandleSummary = {
  sessions: number; firstDate: string; lastDate: string;
  firstOpen: number; lastClose: number; changePct: number;
  high: number; highDate: string; low: number; lowDate: string;
  upSessions: number; downSessions: number;
};

/** Descriptive statistics over the given window only; no forward-looking fields. */
export function summarizeCandles(candles: Candle[]): CandleSummary | null {
  if (candles.length === 0) return null;
  const first = candles[0];
  const last = candles[candles.length - 1];
  let highest = first;
  let lowest = first;
  for (const c of candles) {
    if (c.high > highest.high) highest = c;
    if (c.low < lowest.low) lowest = c;
  }
  return {
    sessions: candles.length,
    firstDate: first.date, lastDate: last.date,
    firstOpen: first.open, lastClose: last.close,
    changePct: ((last.close - first.open) / first.open) * 100,
    high: highest.high, highDate: highest.date,
    low: lowest.low, lowDate: lowest.date,
    upSessions: candles.filter((c) => c.close > c.open).length,
    downSessions: candles.filter((c) => c.close < c.open).length
  };
}
