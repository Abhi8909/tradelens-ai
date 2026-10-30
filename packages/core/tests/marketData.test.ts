import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessCandles, buildStockSummary, completedSessionsSince, isCalendarDate, istDate, makeProvenance, missingSessions, validateInstrument,
  type ProviderInfo
} from '../src/marketData.ts';

const candle = (date: string, close = 100) => ({ date, open: close, high: close + 1, low: close - 1, close, volume: 1000 });
// IST is UTC+05:30, so 18:29:59 UTC is still the same IST day and 18:30 UTC is the next one.
const at = (iso: string) => new Date(iso);

test('istDate converts instants to the Indian calendar date', () => {
  assert.equal(istDate(at('2026-10-29T18:29:59.000Z')), '2026-10-29');
  assert.equal(istDate(at('2026-10-29T18:30:00.000Z')), '2026-10-30');
  assert.equal(istDate(at('2026-10-29T00:00:00.000Z')), '2026-10-29');
});

test('isCalendarDate rejects impossible and malformed dates', () => {
  assert.ok(isCalendarDate('2026-02-28'));
  for (const bad of ['2026-02-30', '2026-13-01', '2026-1-01', '20261001', 20261001, null]) assert.equal(isCalendarDate(bad), false, String(bad));
});

test('completedSessionsSince counts weekday sessions strictly between the observation and today (IST)', () => {
  // Thursday data, Friday morning: no completed session is missing.
  assert.equal(completedSessionsSince('2026-10-29', at('2026-10-30T04:00:00.000Z')), 0);
  // Thursday data on Monday: Friday is missing; the weekend is not.
  assert.equal(completedSessionsSince('2026-10-29', at('2026-11-02T04:00:00.000Z')), 1);
  // Friday data on Monday: nothing missing across the weekend.
  assert.equal(completedSessionsSince('2026-10-30', at('2026-11-02T04:00:00.000Z')), 0);
  // A configured holiday is not a missing session.
  assert.equal(completedSessionsSince('2026-10-29', at('2026-11-02T04:00:00.000Z'), new Set(['2026-10-30'])), 0);
  // Late on Thursday in IST is already Friday for UTC-midnight users; IST decides.
  assert.equal(completedSessionsSince('2026-10-28', at('2026-10-29T19:00:00.000Z')), 1);
});

test('missingSessions finds weekday gaps inside a series and skips weekends and holidays', () => {
  assert.deepEqual(missingSessions(['2026-10-23', '2026-10-29']), ['2026-10-26', '2026-10-27', '2026-10-28']);
  assert.deepEqual(missingSessions(['2026-10-23', '2026-10-26']), [], 'weekend only');
  assert.deepEqual(missingSessions(['2026-10-01', '2026-10-05'], new Set(['2026-10-02'])), [], 'holiday');
  assert.deepEqual(missingSessions(['2026-10-01']), []);
});

test('assessCandles rejects bad rows with reasons instead of repairing them', () => {
  const rows: unknown[] = [
    candle('2026-10-28'),
    { ...candle('2026-10-27'), high: 90 },
    { ...candle('2026-10-26'), volume: -1 },
    { ...candle('2026-10-23'), close: '100' },
    'not a row',
    candle('2026-10-29', 101), candle('2026-10-29', 102),
    candle('2099-01-01')
  ];
  const result = assessCandles(rows, { now: at('2026-10-30T04:00:00.000Z') });
  assert.deepEqual(result.candles.map((c) => c.date), ['2026-10-28']);
  assert.deepEqual(result.rejected.map((r) => [r.date, r.reason.split(' ')[0]]), [
    ['2026-10-23', 'close'], ['2026-10-26', 'volume'], ['2026-10-27', 'inconsistent'],
    ['2026-10-29', 'duplicate'], ['2026-10-29', 'duplicate'], ['2099-01-01', 'dated'], ['unknown', 'row']
  ]);
  assert.equal(result.freshness, 'stale', 'Thursday is missing on Friday because the 29th was rejected');
});

test('assessCandles sorts rows, strips extra fields and reports gaps and freshness', () => {
  const rows = [{ ...candle('2026-10-29'), extra: 'ignored' }, candle('2026-10-26'), candle('2026-10-28')];
  const result = assessCandles(rows, { now: at('2026-10-30T04:00:00.000Z') });
  assert.deepEqual(result.candles.map((c) => c.date), ['2026-10-26', '2026-10-28', '2026-10-29']);
  assert.equal('extra' in result.candles[2], false);
  assert.deepEqual(result.missingDates, ['2026-10-27']);
  assert.equal(result.observedAt, '2026-10-29');
  assert.equal(result.freshness, 'fresh');
  assert.equal(assessCandles(rows, { now: at('2026-11-03T04:00:00.000Z') }).freshness, 'stale');
  assert.equal(assessCandles(rows, { now: at('2026-11-03T04:00:00.000Z'), maxStaleSessions: 2 }).freshness, 'fresh');
  assert.equal(assessCandles([], { now: at('2026-10-30T04:00:00.000Z') }).freshness, 'unknown');
});

test('generated demo calendars skip the as-of check and freshness', () => {
  const result = assessCandles([candle('2099-01-01')], { now: at('2026-10-30T04:00:00.000Z'), realCalendar: false });
  assert.equal(result.candles.length, 1);
  assert.equal(result.freshness, 'not-applicable');
});

test('validateInstrument accepts NSE-style symbols and rejects malformed records', () => {
  const ok = validateInstrument({ symbol: 'M&M', name: ' Fixture Motors ', sector: 'Auto', exchange: 'TEST', currency: 'INR' });
  assert.deepEqual(ok, { symbol: 'M&M', name: 'Fixture Motors', sector: 'Auto', description: '', exchange: 'TEST', currency: 'INR' });
  const base = { symbol: 'FIX-A', name: 'A', sector: 'B', exchange: 'TEST', currency: 'INR' };
  for (const bad of [{ ...base, symbol: 'fix a' }, { ...base, name: '' }, { ...base, exchange: 'nse' }, { ...base, currency: 'RUPEE' }, { ...base, description: 5 }, null]) {
    assert.equal(typeof validateInstrument(bad), 'string', JSON.stringify(bad));
  }
});

test('buildStockSummary needs two closes and matches indicator conventions', () => {
  const company = { symbol: 'FIX-A', name: 'A', sector: 'B', description: '' };
  assert.equal(buildStockSummary(company, []), null);
  assert.equal(buildStockSummary(company, [candle('2026-10-29')]), null);
  const summary = buildStockSummary(company, [candle('2026-10-28', 100), candle('2026-10-29', 110)])!;
  assert.equal(summary.changePct, 10);
  assert.equal(summary.sma20, null);
  assert.equal(summary.trend, 'insufficient-data');
});

test('makeProvenance carries provider identity, licence and data-quality flags', () => {
  const info: ProviderInfo = { id: 'x', name: 'X', kind: 'licensed', exchange: 'NSE', currency: 'INR', license: 'terms', timezone: 'Asia/Kolkata' };
  const assessed = assessCandles([candle('2026-10-29')], { now: at('2026-10-30T04:00:00.000Z') });
  assert.deepEqual(makeProvenance(info, assessed, '2026-10-30T04:00:00.000Z'), {
    providerId: 'x', kind: 'licensed', exchange: 'NSE', currency: 'INR', license: 'terms',
    observedAt: '2026-10-29', ingestedAt: '2026-10-30T04:00:00.000Z', freshness: 'fresh', missingDates: [], rejected: []
  });
});
