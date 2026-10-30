import test from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { appendMtfEvent, allocateMtfRequestFee, calculateMtfLot, estimateMtfSellFees, mtfBreakEven, summarizeMtfPortfolio, zerodhaMtfInterestTemplate, type MtfCharge, type MtfFeeSchedule } from '../src/mtf/index.ts';
import { at, demo, event, lot, options, scope, syntheticMtfPortfolio } from './fixtures/mtf.ts';

const feeSchedule = (): MtfFeeSchedule => ({ id: 'synthetic-fees-v1', effectiveFrom: '2026-01-01', effectiveTo: null, source: demo, roundingMode: 'HALF_UP', lines: [{ id: 'fixed', kind: 'OTHER', fixedInr: '5', turnoverFraction: '0', capInr: null }, { id: 'variable', kind: 'EXCHANGE', fixedInr: '0', turnoverFraction: '0.01', capInr: null }] });

test('MTF acceptance 1–3: funded interest, original vs adjusted price and economic P&L', () => {
  const snapshot = calculateMtfLot(lot(), options()); const m = snapshot.metrics!;
  assert.equal(snapshot.status, 'OPEN_MTF'); assert.equal(m.interestBearingDays, 30);
  assert.equal(snapshot.dailyInterest[0].selectedInr, '2.4000000000000000');
  assert.equal(m.interestAccruedInr, '72.00'); assert.equal(m.initialOwnFundsInr, '4000.00');
  assert.equal(m.grossPurchaseNotionalInr, '10000.00'); assert.equal(m.originalBuyPriceInr, '100.00');
  assert.equal(m.costAdjustedPriceInr, '100.9200'); assert.equal(m.openOtherChargesInr, '20.00');
  assert.equal(m.grossUnrealizedPnlInr, '1000.00'); assert.equal(m.costAdjustedUnrealizedPnlInr, '908.00');
  assert.equal(m.ownCapitalReturnPct, null); assert.equal(m.estimatedNetExitPnlInr, null);
  assert.equal(m.interestEvidence, 'ESTIMATED'); assert.equal(snapshot.source.kind, 'DEMO');
});

test('MTF acceptance 4: sale stops interest, preserves history, never subtracts principal from P&L', () => {
  const l = lot(); l.events.push(event(l, '2026-01-11', { kind: 'SELL', quantity: 100, priceInr: '110', principalRepaidInr: '6000' }));
  const before = JSON.stringify(l); const s = calculateMtfLot(l, options());
  assert.equal(s.status, 'CLOSED_SOLD'); assert.equal(s.dailyInterest.length, 10);
  assert.equal(s.metrics!.interestAccruedInr, '24.00'); assert.equal(s.metrics!.realizedPnlInr, '956.00');
  assert.equal(s.metrics!.quantityOpen, 0); assert.equal(s.metrics!.grossUnrealizedPnlInr, '0.00');
  assert.equal(s.metrics!.costAdjustedUnrealizedPnlInr, '0.00'); assert.equal(s.metrics!.fundedOutstandingInr, '0.00');
  assert.equal(s.exits.length, 1); assert.equal(JSON.stringify(l), before);
  const later = options(); later.asOf = at('2026-02-28');
  assert.deepEqual(calculateMtfLot(l, later).dailyInterest, s.dailyInterest);
});

test('MTF acceptance 5: conversion transfers basis, not sale proceeds, and stops accrual', () => {
  const l = lot(); l.events.push(event(l, '2026-01-11', { kind: 'CONVERT', quantity: 100, destinationLotId: 'demo-cnc-lot', principalRepaidInr: '6000' }));
  const s = calculateMtfLot(l, options()); assert.equal(s.status, 'CONVERTED_TO_DELIVERY');
  assert.equal(s.metrics!.realizedPnlInr, '0.00'); assert.equal(s.metrics!.interestAccruedInr, '24.00');
  assert.equal(s.exits[0].destinationLotId, 'demo-cnc-lot'); assert.equal(s.exits[0].proceedsInr, null);
  assert.equal(s.exits[0].originalCostInr, '10000.00'); assert.equal(s.exits[0].allocatedCostsInr, '44.00');
});

test('MTF acceptance 6: partial sale allocates past charges and reduces subsequent funding only', () => {
  const l = lot(); l.events.push(event(l, '2026-01-11', { kind: 'SELL', quantity: 40, priceInr: '110', principalRepaidInr: '2400' }));
  const s = calculateMtfLot(l, options()); const m = s.metrics!;
  assert.equal(s.status, 'PARTIALLY_SOLD'); assert.equal(m.quantityOpen, 60);
  assert.equal(s.dailyInterest[9].fundedInr, '6000.00'); assert.equal(s.dailyInterest[10].fundedInr, '3600.00');
  assert.equal(m.interestAccruedInr, '52.80'); assert.equal(m.openIncurredCostsInr, '55.20');
  assert.equal(m.remainingPurchaseCostInr, '6000.00'); assert.equal(m.costAdjustedPriceInr, '100.9200');
  assert.equal(s.exits[0].allocatedCostsInr, '17.60'); assert.equal(m.realizedPnlInr, '382.40');
  assert.equal(m.costAdjustedUnrealizedPnlInr, '544.80');
});

test('MTF funding adjustments use explicit service dates, do not rewrite historical balances', () => {
  const l = lot(); l.events.push({ ...scope, lotId: l.id, id: 'repayment', at: at('2026-01-17'), effectiveDate: '2026-01-17', kind: 'FUNDING', direction: 'REPAY', amountInr: '1000', source: demo });
  const s = calculateMtfLot(l, options()); assert.equal(s.metrics!.interestAccruedInr, '66.00');
  assert.equal(s.dailyInterest[14].fundedInr, '6000.00'); assert.equal(s.dailyInterest[15].fundedInr, '5000.00');
  const earlier = options(); earlier.asOf = at('2026-01-10'); earlier.quote = null;
  assert.equal(calculateMtfLot(l, earlier).metrics!.fundedOutstandingInr, '6000.00');
});

test('MTF acceptance 7: invalid exit chronology becomes review, without fabricated P&L', () => {
  const l = lot(); l.buy.at = at('2026-10-29'); l.charges = [];
  l.events.push(event(l, '2026-10-01', { kind: 'SELL', quantity: 100, priceInr: '110', principalRepaidInr: '6000' }));
  const o = options(); o.asOf = at('2026-10-30'); const s = calculateMtfLot(l, o);
  assert.equal(s.status, 'NEEDS_REVIEW'); assert.deepEqual(s.issues, [{ code: 'INVALID_CHRONOLOGY' }]); assert.equal(s.metrics, null);
});

test('MTF acceptance 8, 15, 16: missing/stale prices keep partial coverage and history outside open totals', () => {
  const fixtures = syntheticMtfPortfolio(); const snapshots = fixtures.map(f => calculateMtfLot(f.lot, f.options));
  const summary = summarizeMtfPortfolio(snapshots, scope, options().asOf);
  assert.equal(summary.openLots, 5); assert.equal(summary.excludedLots, 3);
  assert.deepEqual(summary.quoteCoverage, { valued: 4, required: 5, complete: false }); assert.equal(summary.grossMarketValueInr, null);
  const noQuote = options(); noQuote.quote = null; const absent = calculateMtfLot(lot(), noQuote);
  assert.equal(absent.metrics!.grossUnrealizedPnlInr, null); assert.equal(absent.quoteState, 'MISSING');
  const stale = options(); stale.asOf = '2026-01-31T12:05:00+05:30';
  assert.equal(calculateMtfLot(lot(), stale).quoteState, 'STALE');
  assert.equal(snapshots.find(s => s.lotId === 'stale')!.metrics!.grossMarketValueInr, null);
  const justOpen = snapshots.filter(s => s.status === 'OPEN_MTF' || s.status === 'PARTIALLY_SOLD');
  assert.equal(summarizeMtfPortfolio(justOpen, scope, options().asOf).remainingPurchaseCostInr, summary.remainingPurchaseCostInr);
});

test('MTF acceptance 10: append retries are idempotent and conflicting IDs never overwrite events', () => {
  const l = lot(); const sale = event(l, '2026-01-11', { kind: 'SELL', quantity: 40, priceInr: '110', principalRepaidInr: '2400' });
  assert.equal(sale.kind, 'SELL'); if (sale.kind !== 'SELL') throw new Error('Expected sale');
  const once = appendMtfEvent(l, sale); assert.deepEqual(appendMtfEvent(once, structuredClone(sale)), once);
  assert.equal(l.events.length, 0); assert.throws(() => appendMtfEvent(once, { ...sale, quantity: 50 }));
});

test('MTF acceptance 11, 12: same-symbol lots retain independent timelines; T+1 includes weekends', () => {
  const a = lot('first'); a.buy.at = at('2026-01-02'); a.charges = []; // Friday
  const b = lot('second'); b.buy.at = at('2026-01-03'); b.charges = [];
  const o = options(); o.asOf = at('2026-01-04'); o.quote = null;
  assert.equal(calculateMtfLot(a, o).metrics!.interestAccruedInr, '4.80');
  assert.equal(calculateMtfLot(b, o).metrics!.interestAccruedInr, '2.40');
});

test('MTF acceptance 13: split keeps total basis/principal; renamed identity requires a matching quote', () => {
  const l = lot(); l.events.push({ ...scope, lotId: l.id, id: 'split', kind: 'SPLIT', numerator: 2, denominator: 1, at: at('2026-01-15'), source: demo });
  const o = options(); o.quote!.priceInr = '55'; const s = calculateMtfLot(l, o);
  assert.equal(s.metrics!.quantityOpen, 200); assert.equal(s.metrics!.costAdjustedPriceInr, '50.4600');
  assert.equal(s.metrics!.grossUnrealizedPnlInr, '1000.00'); assert.equal(s.metrics!.fundedOutstandingInr, '6000.00');
  l.events.push({ ...scope, lotId: l.id, id: 'rename', kind: 'RENAME', at: at('2026-01-16'), source: demo, instrument: { ...l.instrument, id: 'demo-new-id', symbol: 'DEMO-RENAMED', aliases: [{ symbol: l.instrument.symbol, from: '2026-01-01', to: '2026-01-15' }] } });
  assert.equal(calculateMtfLot(l, o).quoteState, 'MISMATCH');
  l.events[0] = { ...l.events[0], kind: 'SPLIT', numerator: 1, denominator: 3 };
  assert.equal(calculateMtfLot(l, o).issues[0].code, 'UNSUPPORTED_CORPORATE_ACTION');
});

function interestCharge(id: string, day: string, amountInr: string): MtfCharge {
  return { ...scope, lotId: 'synthetic-lot', id, at: at(day), source: demo, kind: 'INTEREST', effectiveDate: day, amountInr, evidence: 'ACTUAL', exitId: null, refundOf: null };
}
test('MTF acceptance 14: billed daily interest replaces estimate, preserves variance and mixed label', () => {
  const l = lot(); l.charges.push(interestCharge('actual-interest', '2026-01-02', '3.00'));
  const s = calculateMtfLot(l, options()); assert.equal(s.metrics!.interestAccruedInr, '72.60');
  assert.equal(s.metrics!.actualInterestInr, '3.00'); assert.equal(s.metrics!.estimatedInterestInr, '69.60');
  assert.equal(s.metrics!.interestEvidence, 'MIXED'); assert.equal(s.dailyInterest[0].varianceInr, '0.60');
  assert.equal(s.dailyInterest[0].estimatedInr, '2.4000000000000000');
  const refund = interestCharge('interest-refund', '2026-01-02', '-0.50'); refund.refundOf = 'actual-interest'; l.charges.push(refund);
  assert.equal(calculateMtfLot(l, options()).metrics!.interestAccruedInr, '72.10');
});

test('MTF statement posted after a sale is allocated to service-date holders, never today’s remaining units', () => {
  const l = lot(); l.events.push(event(l, '2026-01-11', { kind: 'SELL', quantity: 100, priceInr: '110', principalRepaidInr: '6000' }));
  const c = interestCharge('late-interest', '2026-01-02', '3'); c.at = at('2026-01-20'); l.charges.push(c);
  const s = calculateMtfLot(l, options()); assert.equal(s.metrics!.realizedPnlInr, '955.40');
  const earlier = options(); earlier.asOf = at('2026-01-15'); earlier.quote = null;
  assert.equal(calculateMtfLot(l, earlier).metrics!.realizedPnlInr, '956.00');
});

test('MTF acceptance 17: variable sell fees produce a conservative 4dp break-even with no fixed-fee shortcut', () => {
  const o = options(); o.sellFees = feeSchedule(); const s = calculateMtfLot(lot(), o); const m = s.metrics!;
  assert.equal(m.estimatedSellFeesInr, '115.00'); assert.equal(m.estimatedNetExitPnlInr, '793.00');
  assert.ok(new Decimal(m.estimatedBreakEvenPriceInr!).gt(m.costAdjustedPriceInr!));
  const price = new Decimal(m.estimatedBreakEvenPriceInr!); const fees = estimateMtfSellFees(price.toFixed(4), 100, feeSchedule(), '2026-01-31');
  assert.ok(price.mul(100).sub(fees.totalInr).gte('10092'));
  const previous = price.sub('0.0001');
  assert.ok(previous.mul(100).sub(estimateMtfSellFees(previous.toFixed(4), 100, feeSchedule(), '2026-01-31').totalInr).lt('10092'));
});

test('MTF acceptance 18: equivalent instants produce identical IST accrual across midnight', () => {
  const o = options(); o.asOf = '2026-01-31T00:00:00+05:30'; o.quote = null;
  const utc = { ...o, asOf: '2026-01-30T18:30:00Z' };
  assert.deepEqual(calculateMtfLot(lot(), o).metrics, calculateMtfLot(lot(), utc).metrics);
  const before = { ...o, asOf: '2026-01-30T18:29:59Z' };
  assert.equal(calculateMtfLot(lot(), before).metrics!.interestAccruedInr, '69.60');
});

test('MTF date-effective rates handle boundaries without changing earlier daily estimates', () => {
  const o = options(); o.policy.rates[0].effectiveTo = '2026-01-16';
  o.policy.rates.push({ ...o.policy.rates[0], id: 'synthetic-rate-v2', effectiveFrom: '2026-01-17', effectiveTo: null, dailyFraction: '0.0005' });
  const s = calculateMtfLot(lot(), o);
  assert.equal(s.metrics!.interestAccruedInr, '81.00'); assert.equal(s.dailyInterest[14].rateId, 'synthetic-rate-v1');
  assert.equal(s.dailyInterest[15].rateId, 'synthetic-rate-v2'); assert.deepEqual(s.dailyInterest[15].rateSource, demo);
  const overlap = structuredClone(o); overlap.policy.rates[1].effectiveFrom = '2026-01-16';
  assert.equal(calculateMtfLot(lot(), overlap).status, 'NEEDS_REVIEW');
  const gap = structuredClone(o); gap.policy.rates[1].effectiveFrom = '2026-01-18';
  const incomplete = calculateMtfLot(lot(), gap); assert.equal(incomplete.status, 'NEEDS_REVIEW');
  assert.equal(incomplete.metrics!.interestAccruedInr, null); assert.equal(incomplete.metrics!.costAdjustedPriceInr, null);
});

test('MTF rounding uses decimal inputs and explicit per-day vs total conventions', () => {
  const l = lot(); l.buy.fundedInr = '1.00';
  const o = options(); o.policy.rates[0].dailyFraction = '0.005';
  assert.equal(calculateMtfLot(l, o).metrics!.interestAccruedInr, '0.30');
  o.policy.rounding.mode = 'HALF_EVEN'; assert.equal(calculateMtfLot(l, o).metrics!.interestAccruedInr, '0.00');
  o.policy.rounding.timing = 'TOTAL'; assert.equal(calculateMtfLot(l, o).metrics!.interestAccruedInr, '0.15');
  assert.equal(calculateMtfLot(l, o).metrics!.costAdjustedPriceInr, '100.2015');
  o.policy.rounding.mode = 'DOWN'; o.policy.rates[0].dailyFraction = '0.00049';
  const s = calculateMtfLot(l, o); assert.equal(s.metrics!.interestAccruedInr, '0.01');
  assert.equal(s.metrics!.openIncurredCostsInr, '20.01');
});

test('MTF total-rounding residues are conserved through partial exits', () => {
  const l = lot(); l.buy.fundedInr = '1'; l.buy.quantity = 3; l.buy.priceInr = '1'; l.charges = [];
  l.events.push(event(l, '2026-01-11', { kind: 'SELL', quantity: 1, priceInr: '2', principalRepaidInr: '0.33' }));
  l.events.push(event(l, '2026-01-21', { kind: 'SELL', quantity: 2, priceInr: '2', principalRepaidInr: '0.67' }));
  const o = options(); o.policy.rounding.timing = 'TOTAL'; o.policy.rounding.mode = 'DOWN';
  const s = calculateMtfLot(l, o); assert.equal(s.status, 'CLOSED_SOLD');
  const allocated = s.exits.reduce((sum, e) => sum.add(e.allocatedCostsInr!), new Decimal(0));
  assert.equal(allocated.toFixed(2), s.metrics!.interestAccruedInr); assert.equal(s.metrics!.openIncurredCostsInr, '0.00');
});

test('MTF per-request fees conserve paise, group by ISIN/day/account and do not multiply by fills', () => {
  const a = lot('a'); const b = lot('b'); a.buy.quantity = 30; b.buy.quantity = 70;
  const result = allocateMtfRequestFee([b, a], '17.70', 'demo-request');
  assert.deepEqual(result.allocations, [{ lotId: 'a', amountInr: '5.31' }, { lotId: 'b', amountInr: '12.39' }]);
  const tiny = allocateMtfRequestFee(Array.from({ length: 50 }, (_, i) => lot(`tiny-${i}`)), '0.01', 'tiny-request');
  assert.equal(tiny.allocations.reduce((sum, v) => sum.add(v.amountInr), new Decimal(0)).toFixed(2), '0.01');
  assert.ok(tiny.allocations.every(v => new Decimal(v.amountInr).gte(0)));
  b.buy.at = at('2026-01-02'); assert.throws(() => allocateMtfRequestFee([a, b], '17.70', 'wrong-date'));
});

test('MTF missing funding remains unknown instead of inferred from purchase or quote', () => {
  const l = lot(); l.buy.fundedInr = null; const s = calculateMtfLot(l, options());
  assert.equal(s.metrics!.initialOwnFundsInr, null); assert.equal(s.metrics!.fundedOutstandingInr, null);
  assert.equal(s.metrics!.interestAccruedInr, null); assert.equal(s.metrics!.costAdjustedPriceInr, null);
  assert.equal(s.metrics!.grossUnrealizedPnlInr, '1000.00'); assert.ok(s.issues.some(i => i.code === 'MISSING_FUNDED_BALANCE'));
});

test('MTF configurable exit-day policy excludes repayments on the exit day when requested', () => {
  const l = lot(); l.events.push(event(l, '2026-01-11', { kind: 'SELL', quantity: 100, priceInr: '110', principalRepaidInr: '6000' }));
  const o = options(); o.policy.includeExitDay = false;
  assert.equal(calculateMtfLot(l, o).metrics!.interestAccruedInr, '21.60');
});

test('MTF partial conversion retains MTF remainder and separate delivery cost allocation', () => {
  const l = lot(); l.events.push(event(l, '2026-01-11', { kind: 'CONVERT', quantity: 40, destinationLotId: 'demo-cnc', principalRepaidInr: '2400' }));
  const s = calculateMtfLot(l, options()); assert.equal(s.status, 'PARTIALLY_SOLD');
  assert.equal(s.metrics!.quantityOpen, 60); assert.equal(s.metrics!.realizedPnlInr, '0.00');
  assert.equal(s.exits[0].originalCostInr, '4000.00'); assert.equal(s.exits[0].allocatedCostsInr, '17.60');
});

test('MTF sale-specific fees apply only to disposed shares, including late-posted refunds', () => {
  const l = lot(); const sale = event(l, '2026-01-11', { kind: 'SELL', quantity: 40, priceInr: '110', principalRepaidInr: '2400' }); l.events.push(sale);
  l.charges.push({ ...scope, lotId: l.id, id: 'exit-fee', at: at('2026-01-20'), source: demo, kind: 'UNPLEDGE', effectiveDate: '2026-01-11', amountInr: '10', evidence: 'ACTUAL', exitId: sale.id, refundOf: null });
  const s = calculateMtfLot(l, options()); assert.equal(s.metrics!.realizedPnlInr, '372.40');
  assert.equal(s.metrics!.openIncurredCostsInr, '55.20');
});

test('MTF unverified imported charges are never treated as reconciled incurred costs', () => {
  const l = lot(); l.charges[0].evidence = 'IMPORTED_UNVERIFIED'; const s = calculateMtfLot(l, options());
  assert.equal(s.status, 'NEEDS_REVIEW'); assert.equal(s.metrics!.totalOtherChargesInr, '0.00');
  assert.equal(summarizeMtfPortfolio([s], scope, options().asOf).openLots, 0);
});

test('MTF invalid quantities, prices, funding, dates, duplicates and cross-account records fail closed', () => {
  const mutations: ((l: ReturnType<typeof lot>) => void)[] = [
    l => { l.buy.quantity = 0; }, l => { l.buy.quantity = 1.5; }, l => { l.buy.priceInr = 'NaN'; },
    l => { l.buy.priceInr = '0'; }, l => { l.buy.priceInr = '1e2'; }, l => { l.buy.fundedInr = '11000'; },
    l => { l.buy.at = '2026-02-30T12:00:00Z'; }, l => { l.charges[0].accountId = 'another-account'; },
    l => { l.charges.push(structuredClone(l.charges[0])); }, l => { l.charges[0].amountInr = '-20'; },
    l => { l.charges[0].amountInr = '20.001'; },
    l => { l.events.push(event(l, '2026-01-11', { kind: 'SELL', quantity: 101, priceInr: '110', principalRepaidInr: '6000' })); },
    l => { l.events.push(event(l, '2026-01-11', { kind: 'SELL', quantity: 100, priceInr: '110', principalRepaidInr: '5999' })); },
    l => { l.events.push(event(l, '2026-01-11', { kind: 'SELL', quantity: 100, priceInr: '110', principalRepaidInr: '6001' })); },
  ];
  for (const mutate of mutations) { const l = lot(); mutate(l); const s = calculateMtfLot(l, options()); assert.equal(s.status, 'NEEDS_REVIEW'); assert.equal(s.metrics, null); }
});

test('MTF quote validation rejects future, mismatched, cross-account and false-live snapshots', () => {
  const mutations: ((o: ReturnType<typeof options>) => void)[] = [
    o => { o.quote!.instrumentId = 'other'; }, o => { o.quote!.accountId = 'other'; },
    o => { o.quote!.marketAt = at('2026-02-01'); }, o => { o.quote!.receivedAt = at('2026-01-30'); },
    o => { o.quote!.mode = 'LIVE'; },
  ];
  for (const mutate of mutations) { const o = options(); mutate(o); const s = calculateMtfLot(lot(), o); assert.equal(s.quoteState, 'MISMATCH'); assert.equal(s.metrics!.grossMarketValueInr, null); }
});

test('MTF fee estimates honor capped brokerage, fee dates, decimal safety and invalid slopes', () => {
  const schedule = feeSchedule(); schedule.lines = [{ id: 'brokerage', kind: 'BROKERAGE', fixedInr: '0', turnoverFraction: '0.003', capInr: '20' }];
  assert.equal(estimateMtfSellFees('100', 100, schedule, '2026-01-31').totalInr, '20.00');
  assert.equal(estimateMtfSellFees('1', 1, schedule, '2026-01-31').totalInr, '0.00');
  assert.throws(() => estimateMtfSellFees('100', 100, schedule, '2025-12-31'));
  schedule.lines[0].turnoverFraction = '1'; assert.throws(() => mtfBreakEven('10000', 100, schedule, '2026-01-31'));
});

test('MTF summary rejects mixed scopes, mixed as-of dates and duplicate lots', () => {
  const s = calculateMtfLot(lot(), options());
  assert.throws(() => summarizeMtfPortfolio([s, s], scope, options().asOf));
  assert.throws(() => summarizeMtfPortfolio([s], { ...scope, accountId: 'other' }, options().asOf));
  assert.throws(() => summarizeMtfPortfolio([s], scope, at('2026-02-01')));
});

test('MTF optional sourced interest template needs an explicit effective date and rounding choice', () => {
  const policy = zerodhaMtfInterestTemplate('2026-01-01', { timing: 'DAILY', mode: 'HALF_UP' });
  const o = options(); o.policy = policy; assert.equal(calculateMtfLot(lot(), o).metrics!.interestAccruedInr, '72.00');
  assert.match(policy.rates[0].source.reference, /observed 2026-10-30/);
});

test('MTF reproducibility, immutable inputs and independent decimal context', () => {
  const l = lot(); const o = options(); const baseline = JSON.stringify({ l, o });
  const s = calculateMtfLot(l, o); const previousPrecision = Decimal.precision;
  try { Decimal.set({ precision: 3 }); assert.deepEqual(calculateMtfLot(l, o), s); }
  finally { Decimal.set({ precision: previousPrecision }); }
  assert.equal(JSON.stringify({ l, o }), baseline);
});

test('MTF conservation property across varied partial-sale quantities and paise allocations', () => {
  for (let shares = 2; shares <= 60; shares++) {
    const l = lot(); l.buy.quantity = shares; l.buy.priceInr = '13.37'; l.buy.fundedInr = '0.00';
    const first = Math.floor(shares / 2);
    l.events.push(event(l, '2026-01-11', { kind: 'SELL', quantity: first, priceInr: '15.13', principalRepaidInr: '0' }));
    l.events.push(event(l, '2026-01-21', { kind: 'SELL', quantity: shares - first, priceInr: '14.17', principalRepaidInr: '0' }));
    const s = calculateMtfLot(l, options()); assert.equal(s.status, 'CLOSED_SOLD');
    const cost = s.exits.reduce((a, e) => a.add(e.originalCostInr), new Decimal(0));
    const fees = s.exits.reduce((a, e) => a.add(e.allocatedCostsInr!), new Decimal(0));
    const proceeds = s.exits.reduce((a, e) => a.add(e.proceedsInr!), new Decimal(0));
    assert.equal(cost.toFixed(2), s.metrics!.grossPurchaseNotionalInr); assert.equal(fees.toFixed(2), '20.00');
    assert.equal(proceeds.sub(cost).sub(fees).toFixed(2), s.metrics!.realizedPnlInr);
  }
});

test('MTF a quote preceding a same-day split cannot be used as a post-split mark', () => {
  const l = lot(); l.events.push({ ...scope, lotId: l.id, id: 'split-today', kind: 'SPLIT', numerator: 2, denominator: 1, at: '2026-01-31T11:59:00+05:30', source: demo });
  const o = options(); o.quote!.marketAt = '2026-01-31T11:58:00+05:30';
  assert.equal(calculateMtfLot(l, o).quoteState, 'MISMATCH');
});
