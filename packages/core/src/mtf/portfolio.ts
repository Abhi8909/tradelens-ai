import { D, instant, money, requireMtf } from './decimal.ts';
import type { MtfScope, MtfSnapshot } from './types.ts';

/** Always aggregate the unfiltered snapshot set; view filters must operate on a separate copy. */
export function summarizeMtfPortfolio(snapshots: MtfSnapshot[], scope: MtfScope, asOf: string) {
  instant(asOf);
  const ids = new Set<string>();
  for (const snapshot of snapshots) {
    requireMtf(snapshot.tenantId === scope.tenantId && snapshot.accountId === scope.accountId, 'SCOPE_MISMATCH');
    requireMtf(instant(snapshot.asOf) === instant(asOf), 'INVALID_CHRONOLOGY');
    requireMtf(!ids.has(snapshot.lotId), 'DUPLICATE_ID'); ids.add(snapshot.lotId);
  }
  const open = snapshots.filter(s => (s.status === 'OPEN_MTF' || s.status === 'PARTIALLY_SOLD') && s.metrics && s.metrics.quantityOpen > 0);
  const sum = (read: (snapshot: MtfSnapshot) => string | null) => {
    const values = open.map(read); return values.some(v => v === null) ? null : money(values.reduce<InstanceType<typeof D>>((a, v) => a.add(v!), new D(0)));
  };
  const valued = open.filter(s => s.metrics!.grossMarketValueInr !== null);
  const verified = open.filter(s => s.source.kind === 'VERIFIED' && s.quote?.source.kind === 'VERIFIED' && s.quoteState !== 'DEMO' && s.quoteState !== 'MANUAL' && s.metrics!.grossMarketValueInr !== null);
  return {
    ...scope, asOf, calculationVersion: 'mtf-v1' as const, openLots: open.length,
    excludedLots: snapshots.length - open.length,
    remainingPurchaseCostInr: sum(s => s.metrics!.remainingPurchaseCostInr),
    fundedOutstandingInr: sum(s => s.metrics!.fundedOutstandingInr),
    // Only costs attributed to remaining units enter Open totals, not total lifetime lot interest.
    openInterestInr: sum(s => s.metrics!.openInterestInr),
    openOtherChargesInr: sum(s => s.metrics!.openOtherChargesInr),
    openIncurredCostsInr: sum(s => s.metrics!.openIncurredCostsInr),
    grossMarketValueInr: sum(s => s.metrics!.grossMarketValueInr),
    partialMarketValueInr: money(valued.reduce((a, s) => a.add(s.metrics!.grossMarketValueInr!), new D(0))),
    grossUnrealizedPnlInr: sum(s => s.metrics!.grossUnrealizedPnlInr),
    costAdjustedUnrealizedPnlInr: sum(s => s.metrics!.costAdjustedUnrealizedPnlInr),
    quoteCoverage: { valued: valued.length, required: open.length, complete: valued.length === open.length },
    verifiedCoverage: { verified: verified.length, required: open.length },
    evidence: open.length === 0 ? 'EMPTY' : open.every(s => s.source.kind === 'DEMO') ? 'DEMO' : verified.length === open.length ? 'VERIFIED_TRADES_AND_QUOTES' : 'UNVERIFIED_OR_PARTIAL',
  };
}
