import { readFileSync } from 'node:fs';
import { assessCandles, isCalendarDate, makeProvenance, validateInstrument, type Instrument, type ProviderInfo } from '../../../../packages/core/src/marketData.ts';
import { ProviderError, type MarketDataProvider } from './types.ts';

export const FIXTURE_SCHEMA = 'tradelens-market-fixture/v1';
export const DEFAULT_FIXTURE_PATH = new URL('../../fixtures/market-fixture.json', import.meta.url);
const configError = (message: string) => new ProviderError('config', `Invalid market fixture: ${message}`);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A synthetic JSON file shaped like real provider output, including deliberate gaps and bad rows,
 * so the validation, staleness and provenance paths can be exercised without any network access.
 * Structural problems fail at load time; individual bad candle rows are reported per request.
 */
export function createFixtureProvider(data: unknown, now: () => Date = () => new Date()): MarketDataProvider {
  if (!isRecord(data) || data.schema !== FIXTURE_SCHEMA) throw configError(`schema must be "${FIXTURE_SCHEMA}"`);
  const p = data.provider;
  if (!isRecord(p) || [p.id, p.name, p.license].some((v) => typeof v !== 'string' || !v.trim())) throw configError('provider needs id, name and license');
  const holidays = data.holidays ?? [];
  if (!Array.isArray(holidays) || !holidays.every(isCalendarDate)) throw configError('holidays must be YYYY-MM-DD dates');
  const maxStaleSessions = data.maxStaleSessions ?? 0;
  if (typeof maxStaleSessions !== 'number' || !Number.isInteger(maxStaleSessions) || maxStaleSessions < 0) throw configError('maxStaleSessions must be a whole number ≥ 0');
  if (!Array.isArray(data.instruments) || data.instruments.length === 0) throw configError('instruments must be a non-empty list');
  const instruments: Instrument[] = data.instruments.map((raw) => {
    const result = validateInstrument(raw);
    if (typeof result === 'string') throw configError(result);
    return result;
  });
  const info: ProviderInfo = {
    id: p.id as string, name: p.name as string, kind: 'fixture', license: p.license as string, timezone: 'Asia/Kolkata',
    exchange: instruments[0].exchange, currency: instruments[0].currency
  };
  if (instruments.some((i) => i.exchange !== info.exchange || i.currency !== info.currency)) throw configError('all instruments must share one exchange and currency');
  const symbols = new Set(instruments.map((i) => i.symbol));
  if (symbols.size !== instruments.length) throw configError('duplicate instrument symbol');
  const candles = data.candles;
  if (!isRecord(candles)) throw configError('candles must be an object keyed by symbol');
  for (const [symbol, rows] of Object.entries(candles)) {
    if (!symbols.has(symbol)) throw configError(`candles for ${symbol} have no instrument`);
    if (!Array.isArray(rows)) throw configError(`candles for ${symbol} must be a list`);
  }
  const ingestedAt = now().toISOString();
  return {
    info,
    async listInstruments() { return instruments.map((i) => ({ ...i })); },
    async getCandles(symbol) {
      if (!symbols.has(symbol)) throw new ProviderError('not-found', `Unknown symbol ${symbol}`);
      const assessed = assessCandles((candles[symbol] as unknown[] | undefined) ?? [], { now: now(), holidays: holidays as string[], maxStaleSessions });
      return { candles: assessed.candles, provenance: makeProvenance(info, assessed, ingestedAt) };
    }
  };
}

export function loadFixtureProvider(path: string | URL = DEFAULT_FIXTURE_PATH, now?: () => Date): MarketDataProvider {
  let data: unknown;
  try { data = JSON.parse(readFileSync(path, 'utf8')); } catch { throw configError(`cannot read JSON from ${String(path)}`); }
  return createFixtureProvider(data, now);
}
