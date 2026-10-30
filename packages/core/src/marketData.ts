import { isValidCandle } from './chart.ts';
import { percentChange, rsi, sma } from './indicators.ts';
import type { Candle, Company, StockSummary } from './types.ts';

export type ProviderKind = 'demo' | 'fixture' | 'licensed';
/** `not-applicable` for generated demo data; `unknown` when there is nothing to judge. */
export type Freshness = 'fresh' | 'stale' | 'unknown' | 'not-applicable';
export type ProviderInfo = {
  id: string; name: string; kind: ProviderKind; exchange: string; currency: string; license: string; timezone: 'Asia/Kolkata';
};
export type Instrument = Company & { exchange: string; currency: string };
export type RejectedRow = { date: string; reason: string };
export type DataProvenance = {
  providerId: string; kind: ProviderKind; exchange: string; currency: string; license: string;
  /** Date of the latest valid observation (exchange trading date), or null when there is none. */
  observedAt: string | null;
  /** When this process received the data from the provider (ISO instant). */
  ingestedAt: string;
  freshness: Freshness; missingDates: string[]; rejected: RejectedRow[];
};

export const MARKET_SYMBOL = /^[A-Z0-9][A-Z0-9&-]{0,19}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const IST_OFFSET_MS = 330 * 60 * 1000;

export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
/** Calendar date in India for an instant; exchange dates are IST dates, not UTC dates. */
export const istDate = (instant: Date): string => new Date(instant.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
const isSession = (date: string, holidays: ReadonlySet<string>) => {
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !holidays.has(date);
};

/** Trading sessions strictly after `lastDate` and strictly before today (IST); today's session may be incomplete. */
export function completedSessionsSince(lastDate: string, now: Date, holidays: ReadonlySet<string> = new Set()): number {
  const today = istDate(now);
  let count = 0;
  for (let d = addDays(lastDate, 1); d < today; d = addDays(d, 1)) if (isSession(d, holidays)) count++;
  return count;
}

/** Weekday, non-holiday dates between the first and last date that have no observation. */
export function missingSessions(dates: string[], holidays: ReadonlySet<string> = new Set()): string[] {
  if (dates.length < 2) return [];
  const present = new Set(dates);
  const missing: string[] = [];
  for (let d = addDays(dates[0], 1); d < dates[dates.length - 1]; d = addDays(d, 1)) {
    if (isSession(d, holidays) && !present.has(d)) missing.push(d);
  }
  return missing;
}

function candleShapeError(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'row is not an object';
  const row = raw as Record<string, unknown>;
  if (!isCalendarDate(row.date)) return 'date must be YYYY-MM-DD';
  for (const key of ['open', 'high', 'low', 'close', 'volume'] as const) {
    if (typeof row[key] !== 'number' || !Number.isFinite(row[key])) return `${key} must be a finite number`;
  }
  if ((row.volume as number) < 0) return 'volume must be 0 or more';
  if (!isValidCandle(row as Candle)) return 'inconsistent OHLC (prices must be positive, low ≤ open/close ≤ high)';
  return null;
}

export type CandleAssessment = { candles: Candle[]; rejected: RejectedRow[]; missingDates: string[]; observedAt: string | null; freshness: Freshness };

/**
 * Validate provider rows without guessing: bad rows are rejected with a reason (never repaired),
 * every row for an ambiguous duplicate date is rejected, and rows dated after today (IST) are rejected.
 */
export function assessCandles(rows: unknown[], options: {
  now: Date; holidays?: string[]; maxStaleSessions?: number;
  /** false for generated demo data: no as-of date check and freshness is not applicable. */
  realCalendar?: boolean;
}): CandleAssessment {
  const realCalendar = options.realCalendar ?? true;
  const holidays = new Set(options.holidays ?? []);
  const today = istDate(options.now);
  const rejected: RejectedRow[] = [];
  const valid: Candle[] = [];
  for (const raw of rows) {
    const date = typeof raw === 'object' && raw !== null && typeof (raw as { date?: unknown }).date === 'string' ? (raw as { date: string }).date : 'unknown';
    const error = candleShapeError(raw);
    if (error) rejected.push({ date, reason: error });
    else if (realCalendar && date > today) rejected.push({ date, reason: 'dated after the as-of date' });
    else {
      const { open, high, low, close, volume } = raw as Candle;
      valid.push({ date, open, high, low, close, volume });
    }
  }
  const counts = new Map<string, number>();
  for (const c of valid) counts.set(c.date, (counts.get(c.date) ?? 0) + 1);
  const candles = valid.filter((c) => {
    if (counts.get(c.date) === 1) return true;
    rejected.push({ date: c.date, reason: 'duplicate date' });
    return false;
  }).sort((a, b) => a.date.localeCompare(b.date));
  rejected.sort((a, b) => a.date.localeCompare(b.date) || a.reason.localeCompare(b.reason));
  const observedAt = candles.length ? candles[candles.length - 1].date : null;
  const freshness: Freshness = !realCalendar ? 'not-applicable'
    : observedAt === null ? 'unknown'
    : completedSessionsSince(observedAt, options.now, holidays) > (options.maxStaleSessions ?? 0) ? 'stale' : 'fresh';
  return { candles, rejected, missingDates: missingSessions(candles.map((c) => c.date), holidays), observedAt, freshness };
}

export function makeProvenance(info: ProviderInfo, assessed: CandleAssessment, ingestedAt: string): DataProvenance {
  return {
    providerId: info.id, kind: info.kind, exchange: info.exchange, currency: info.currency, license: info.license,
    observedAt: assessed.observedAt, ingestedAt, freshness: assessed.freshness, missingDates: assessed.missingDates, rejected: assessed.rejected
  };
}

/** Validate one instrument record from a provider. Returns an error message or the normalized instrument. */
export function validateInstrument(raw: unknown): Instrument | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'instrument is not an object';
  const r = raw as Record<string, unknown>;
  const text = (key: string, max: number) => typeof r[key] === 'string' && (r[key] as string).trim().length > 0 && (r[key] as string).length <= max;
  if (typeof r.symbol !== 'string' || !MARKET_SYMBOL.test(r.symbol)) return `invalid symbol ${JSON.stringify(r.symbol)}`;
  if (!text('name', 120)) return `${r.symbol}: name must be 1-120 characters`;
  if (!text('sector', 60)) return `${r.symbol}: sector must be 1-60 characters`;
  if (typeof r.exchange !== 'string' || !/^[A-Z]{2,10}$/.test(r.exchange)) return `${r.symbol}: invalid exchange`;
  if (typeof r.currency !== 'string' || !/^[A-Z]{3}$/.test(r.currency)) return `${r.symbol}: invalid currency`;
  if (r.description !== undefined && (typeof r.description !== 'string' || r.description.length > 500)) return `${r.symbol}: description must be text up to 500 characters`;
  return { symbol: r.symbol, name: (r.name as string).trim(), sector: (r.sector as string).trim(), description: (r.description as string | undefined) ?? '', exchange: r.exchange, currency: r.currency };
}

/** Deterministic summary shared by every provider; null when there are fewer than two valid closes. */
export function buildStockSummary(company: Company, candles: Candle[]): StockSummary | null {
  if (candles.length < 2) return null;
  const closes = candles.map((item) => item.close);
  const lastClose = closes[closes.length - 1];
  const previousClose = closes[closes.length - 2];
  const sma20 = sma(closes, 20);
  return {
    symbol: company.symbol, name: company.name, sector: company.sector, description: company.description,
    lastClose, previousClose,
    changePct: percentChange(previousClose, lastClose),
    sma20, rsi14: rsi(closes, 14),
    trend: sma20 === null ? 'insufficient-data' : lastClose >= sma20 ? 'above-sma' : 'below-sma',
    sparkline: closes.slice(-20)
  };
}
