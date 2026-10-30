import type { MtfCalculationOptions, MtfEvent, MtfLot, MtfSource } from '../../src/mtf/index.ts';
export const demo: MtfSource = { kind: 'DEMO', reference: 'wholly-synthetic-mtf-fixture-v1' };
export const scope = { tenantId: 'demo-tenant', accountId: 'demo-account' };
export const at = (day: string) => `${day}T12:00:00+05:30`;
export function lot(id = 'synthetic-lot'): MtfLot {
  return { ...scope, id, instrument: { id: 'demo-instrument', exchange: 'DEMO', isin: 'DEMO-ISIN-001', symbol: 'DEMO-MTF', aliases: [] },
    buy: { id: `buy-${id}`, at: at('2026-01-01'), quantity: 100, priceInr: '100.00', fundedInr: '6000.00', source: demo }, events: [],
    charges: [{ ...scope, lotId: id, id: `entry-${id}`, at: at('2026-01-01'), source: demo, kind: 'BROKERAGE', effectiveDate: '2026-01-01', amountInr: '20.00', evidence: 'ACTUAL', exitId: null, refundOf: null }] };
}
export function event(base: MtfLot, day: string, details: { kind: 'SELL'; quantity: number; priceInr: string; principalRepaidInr: string | null } | { kind: 'CONVERT'; quantity: number; destinationLotId: string; principalRepaidInr: string | null }): MtfEvent {
  return { ...scope, lotId: base.id, id: `exit-${base.id}-${day}`, at: at(day), source: demo, ...details };
}
export function options(): MtfCalculationOptions {
  return { asOf: at('2026-01-31'), quoteMaxAgeMs: 300_000,
    policy: { id: 'synthetic-policy-v1', startOffsetDays: 1, includeExitDay: true, rounding: { timing: 'DAILY', mode: 'HALF_UP' }, rates: [{ id: 'synthetic-rate-v1', effectiveFrom: '2026-01-01', effectiveTo: null, dailyFraction: '0.0004', source: demo }] },
    quote: { ...scope, instrumentId: 'demo-instrument', priceInr: '110.00', marketAt: at('2026-01-31'), receivedAt: at('2026-01-31'), mode: 'DEMO', source: demo } };
}
export function syntheticMtfPortfolio() {
  const open = lot('open'); const closed = lot('closed'); const converted = lot('converted'); const partial = lot('partial');
  closed.events.push(event(closed, '2026-01-11', { kind: 'SELL', quantity: 100, priceInr: '110', principalRepaidInr: '6000' }));
  converted.events.push(event(converted, '2026-01-11', { kind: 'CONVERT', quantity: 100, destinationLotId: 'demo-cnc', principalRepaidInr: '6000' }));
  partial.events.push(event(partial, '2026-01-11', { kind: 'SELL', quantity: 40, priceInr: '110', principalRepaidInr: '2400' }));
  const missing = lot('missing-funding'); missing.buy.fundedInr = null;
  const review = lot('review'); review.events.push(event(review, '2025-12-01', { kind: 'SELL', quantity: 100, priceInr: '110', principalRepaidInr: '6000' }));
  const stale = lot('stale'); const second = lot('second-purchase'); second.buy.at = at('2026-01-10'); second.charges = [];
  return [open, closed, converted, partial, missing, review, stale, second].map(l => {
    const config = options();
    if (l.id === 'stale') config.quote!.marketAt = at('2026-01-30');
    return { lot: l, options: config };
  });
}
