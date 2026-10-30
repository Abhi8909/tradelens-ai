import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateManualMtf, parseManualMtfStorage, summarizeManualMtf, type ManualMtfPosition } from '../src/mtf/manual.ts';
const base: ManualMtfPosition = { id: 'synthetic-manual', symbol: 'SYNTHETIC', boughtDate: '2026-01-01', quantity: 100, buyPriceInr: '100', interestPerDayInr: '2.40', otherChargesInr: '20', exitDate: null, manualPrice: null };
test('manual MTF computes integer days, daily interest, invested cost, adjusted price and net P/L', () => {
  const r = calculateManualMtf(base, '2026-01-31', '110');
  assert.equal(r.days, 30); assert.equal(r.interestInr, '72.00'); assert.equal(r.totalChargesInr, '92.00');
  assert.equal(r.investedInr, '10000.00'); assert.equal(r.adjustedBuyPriceInr, '100.9200');
  assert.equal(r.pnlInr, '908.00'); assert.equal(r.pnlPct, '9.00');
});
test('manual MTF freezes costs at exit, retains the row and excludes it from every open total', () => {
  const closed = calculateManualMtf({ ...base, exitDate: '2026-01-11' }, '2026-02-28', '110');
  assert.equal(closed.days, 10); assert.equal(closed.interestInr, '24.00'); assert.equal(closed.pnlInr, null);
  const open = calculateManualMtf(base, '2026-01-31', '110');
  assert.deepEqual(summarizeManualMtf([closed, open]), summarizeManualMtf([open]));
});
test('manual MTF portfolio percentage is weighted net P/L divided by total cost, not average percentages', () => {
  const a = calculateManualMtf({ ...base, boughtDate: '2026-01-31', interestPerDayInr: '0', otherChargesInr: '0' }, '2026-01-31', '110');
  const b = calculateManualMtf({ ...base, boughtDate: '2026-01-31', quantity: 10, interestPerDayInr: '0', otherChargesInr: '0' }, '2026-01-31', '50');
  const total = summarizeManualMtf([a, b]); assert.equal(total.pnlInr, '500.00'); assert.equal(total.pnlPct, '4.55');
});
test('manual MTF missing prices preserve partial coverage and never invent zero-price losses', () => {
  const unpriced = calculateManualMtf(base, '2026-01-31', null); assert.equal(unpriced.pnlInr, null);
  const total = summarizeManualMtf([unpriced]); assert.equal(total.complete, false); assert.equal(total.pnlPct, null); assert.equal(total.pnlInr, null);
});
test('manual MTF validates chronology, decimals, quantities and future entries', () => {
  for (const invalid of [{ ...base, quantity: 0 }, { ...base, boughtDate: '2026-02-30' }, { ...base, buyPriceInr: 'NaN' }, { ...base, interestPerDayInr: '-1' }, { ...base, exitDate: '2025-12-31' }, { ...base, exitDate: '2026-02-01' }]) assert.throws(() => calculateManualMtf(invalid, '2026-01-31', null));
  assert.throws(() => calculateManualMtf(base, '2025-12-31', null));
  assert.equal(calculateManualMtf(base, base.boughtDate, null).days, 0);
});
test('manual MTF browser storage round-trips and rejects corrupt/newer/duplicate records', () => {
  assert.deepEqual(parseManualMtfStorage(JSON.stringify({ version: 1, positions: [base] }), '2026-01-31'), [base]);
  assert.throws(() => parseManualMtfStorage('{broken', '2026-01-31'));
  assert.throws(() => parseManualMtfStorage(JSON.stringify({ version: 2, positions: [] }), '2026-01-31'));
  assert.throws(() => parseManualMtfStorage(JSON.stringify({ version: 1, positions: [base, base] }), '2026-01-31'));
});
