import { D, addDays, amount, calendarDate, instant, istDay, money, requireMtf, rounding } from './decimal.ts';
import { calculateMtfLot } from './ledger.ts';
import { summarizeMtfPortfolio } from './portfolio.ts';
import { validateManualMtfPosition, type ManualMtfPosition } from './manual.ts';
import type { MtfCharge, MtfEvent, MtfFeeSchedule, MtfInterestPolicy, MtfLot, MtfScope, MtfSnapshot, MtfMetrics } from './types.ts';

export type MtfAccount = { id: string; label: string; broker: string; createdAt: string };
export type PortfolioDocument = {
  id: string; accountId: string; version: number; position: ManualMtfPosition;
  instrument?: MtfLot['instrument']; interestPolicy?: Pick<MtfInterestPolicy,'startOffsetDays'|'includeExitDay'|'rounding'>;
  rateChanges?: { id: string; effectiveFrom: string; dailyFraction: string; at: string; reference: string }[];
  fundedInr: string | null; dailyFraction: string | null; events: MtfEvent[]; charges: MtfCharge[];
  sellFees: MtfFeeSchedule | null; createdAt: string; updatedAt: string;
};
export type PortfolioPrice = { symbol: string; priceInr: string; marketAt: string; source: string; mode: 'LIVE' | 'DELAYED' | 'EOD' };
export function createPortfolioDocument(input: unknown, scope: MtfScope, id: string, now: string): PortfolioDocument {
  requireMtf(!!input && typeof input === 'object' && !Array.isArray(input));
  const body = input as Record<string, unknown>;
  const position = { ...(body.position as ManualMtfPosition), id };
  validateManualMtfPosition(position, istDay(now));
  const fundedInr = body.fundedInr === undefined || body.fundedInr === '' ? null : body.fundedInr as string | null;
  const dailyFraction = body.dailyFraction === undefined || body.dailyFraction === '' ? null : body.dailyFraction as string | null;
  if (fundedInr !== null) requireMtf(amount(fundedInr).lte(amount(position.buyPriceInr).mul(position.quantity)), 'INVALID_FUNDING');
  if (dailyFraction !== null) requireMtf(amount(dailyFraction).lte('1'));
  requireMtf((fundedInr === null) === (dailyFraction === null), 'INVALID_FUNDING');
  const sellFees = body.sellFees === undefined ? null : body.sellFees as MtfFeeSchedule | null;
  const policy = body.interestPolicy as PortfolioDocument['interestPolicy'];
  if (policy) requireMtf(Object.keys(policy).every(k=>['startOffsetDays','includeExitDay','rounding'].includes(k)) && Number.isInteger(policy.startOffsetDays) && policy.startOffsetDays>=0 && policy.startOffsetDays<=30 && typeof policy.includeExitDay==='boolean' && policy.rounding && ['DAILY','TOTAL'].includes(policy.rounding.timing) && ['HALF_UP','HALF_EVEN','DOWN'].includes(policy.rounding.mode));
  const instrument = body.instrument as MtfLot['instrument'] | undefined;
  if (instrument) requireMtf(instrument.exchange === 'NSE' && typeof instrument.isin === 'string' && /^[A-Z0-9]{12}$/.test(instrument.isin) && instrument.symbol === position.symbol);
  const document: PortfolioDocument = { instrument, interestPolicy: policy, id, accountId: scope.accountId, version: 1, position, fundedInr, dailyFraction, events: [], charges: [], sellFees, createdAt: now, updatedAt: now };
  const result = derivePortfolioPosition(document, scope, now, null);
  requireMtf(result.metrics !== null, result.issues[0]?.code ?? 'INVALID_INPUT');
  return document;
}
export function positionLot(document: PortfolioDocument, scope: MtfScope): { lot: MtfLot; policy: MtfInterestPolicy } {
  requireMtf(document.accountId === scope.accountId, 'SCOPE_MISMATCH');
  const p = document.position;
  const source = { kind: 'MANUAL_UNVERIFIED' as const, reference: 'User-entered position; not reconciled broker data' };
  const at = `${p.boughtDate}T00:00:00+05:30`;
  const lot: MtfLot = { ...scope, id: document.id, instrument: document.instrument ?? { id: `NSE:${p.symbol}`, exchange: 'NSE', isin: `UNRESOLVED:${p.symbol}`, symbol: p.symbol, aliases: [] },
    buy: { id: `buy:${document.id}`, at, quantity: p.quantity, priceInr: p.buyPriceInr, fundedInr: document.fundedInr, source },
    events: structuredClone(document.events), charges: [{ ...scope, id: `entry:${document.id}`, lotId: document.id, at, source, kind: 'OTHER', effectiveDate: p.boughtDate, amountInr: amount(p.otherChargesInr).toFixed(2), evidence: 'ESTIMATED', exitId: null, refundOf: null }, ...structuredClone(document.charges)] };
  if (p.exitDate && !lot.events.some(e => e.id === `exit:${document.id}`)) {
    // Legacy date-only exits retain unknown realized proceeds; never invent a zero sale.
    lot.events.push({ ...scope, id: `exit:${document.id}`, lotId: document.id, at: `${p.exitDate}T00:00:01+05:30`, source,
      kind: 'EXIT_UNPRICED', quantity: p.quantity, principalRepaidInr: document.fundedInr });
  }
  const changes = [...(document.rateChanges ?? [])].sort((a,b)=>a.effectiveFrom.localeCompare(b.effectiveFrom));
  const rates = document.dailyFraction === null ? [] : [{ id: `rate:${document.id}`, effectiveFrom: p.boughtDate, effectiveTo: null as string | null, dailyFraction: document.dailyFraction, source }];
  for(const change of changes){ const previous=rates.at(-1)!; requireMtf(change.effectiveFrom>previous.effectiveFrom,'INVALID_CHRONOLOGY'); previous.effectiveTo=addDays(change.effectiveFrom,-1); rates.push({id:change.id,effectiveFrom:change.effectiveFrom,effectiveTo:null,dailyFraction:change.dailyFraction,source:{...source,reference:change.reference}}); }
  return { lot, policy: { id: `policy:${document.id}:v${document.version}`, startOffsetDays: 1, includeExitDay: true,
    rounding: { timing: 'DAILY', mode: 'HALF_UP' },
    ...(document.dailyFraction === null ? { flatDailyInr: p.interestPerDayInr } : {}),
    rates, ...document.interestPolicy } };
}
export function derivePortfolioPosition(document: PortfolioDocument, scope: MtfScope, asOf: string, price: PortfolioPrice | null): MtfSnapshot {
  const { lot, policy } = positionLot(document, scope);
  const manual = document.position.manualPrice;
  const autoValid = price && instant(price.marketAt) <= instant(asOf);
  const quote = autoValid ? { ...scope, instrumentId: lot.instrument.id, priceInr: price.priceInr, marketAt: price.marketAt, receivedAt: asOf, mode: price.mode,
    source: { kind: 'VERIFIED' as const, reference: price.source } } : manual && instant(manual.at) <= instant(asOf) ? { ...scope, instrumentId: lot.instrument.id, priceInr: manual.priceInr, marketAt: manual.at, receivedAt: asOf, mode: 'MANUAL' as const,
      source: { kind: 'MANUAL_UNVERIFIED' as const, reference: 'Manual price' } } : null;
  const result = calculateMtfLot(lot, { asOf, policy, quote, quoteMaxAgeMs: quote?.mode === 'EOD' || quote?.mode === 'MANUAL' ? 86_400_000 : 300_000, sellFees: document.sellFees });
  if (document.position.exitDate && result.metrics?.quantityOpen === 0) result.status = 'CLOSED_SOLD';
  return result;
}
export function dailyBurn(document: PortfolioDocument, metrics: MtfMetrics | null, day: string): string | null {
  if(!metrics || metrics.quantityOpen===0)return '0.00';
  const mode = rounding(document.interestPolicy?.rounding.mode ?? 'HALF_UP');
  if(document.dailyFraction===null)return amount(document.position.interestPerDayInr).mul(metrics.remainingPurchaseCostInr).div(metrics.grossPurchaseNotionalInr).toFixed(2,mode);
  if(metrics.fundedOutstandingInr===null)return null;
  const rate=[...(document.rateChanges??[])].filter(r=>r.effectiveFrom<=day).sort((a,b)=>a.effectiveFrom.localeCompare(b.effectiveFrom)).at(-1)?.dailyFraction??document.dailyFraction;
  return amount(metrics.fundedOutstandingInr).mul(rate).toFixed(2,mode);
}
export function summarizeDashboard(documents: PortfolioDocument[], scope: MtfScope, asOf: string, prices: PortfolioPrice[]) {
  const rows = documents.map(document => ({ document, snapshot: derivePortfolioPosition(document, scope, asOf, prices.find(p => p.symbol === document.position.symbol) ?? null) }));
  const summary = summarizeMtfPortfolio(rows.map(r => r.snapshot), scope, asOf);
  const open = rows.filter(r => ['OPEN_MTF', 'PARTIALLY_SOLD'].includes(r.snapshot.status));
  const sum = (read: (row: typeof rows[number]) => string | null) => { const values = open.map(read); return values.some(v => v === null) ? null : money(values.reduce((a, v) => a.add(v!), new D(0))); };
  return { rows, summary: { ...summary,
    initialOwnFundsInr: sum(r => r.snapshot.metrics!.initialOwnFundsInr),
    actualInterestInr: sum(r => r.snapshot.metrics!.actualInterestInr), estimatedInterestInr: sum(r => r.snapshot.metrics!.estimatedInterestInr),
    marketValueInr: summary.grossMarketValueInr,
    dailyInterestInr: sum(r => dailyBurn(r.document,r.snapshot.metrics,istDay(asOf))),
    pnlPct: summary.costAdjustedUnrealizedPnlInr !== null && summary.remainingPurchaseCostInr !== null && summary.openIncurredCostsInr !== null && amount(summary.remainingPurchaseCostInr).add(summary.openIncurredCostsInr).gt(0)
      ? amount(summary.costAdjustedUnrealizedPnlInr, true).div(amount(summary.remainingPurchaseCostInr).add(summary.openIncurredCostsInr)).mul(100).toFixed(2) : null } };
}
export function projectPosition(document: PortfolioDocument, scope: MtfScope, asOf: string, price: PortfolioPrice | null) {
  const baseline = derivePortfolioPosition(document, scope, asOf, price);
  return [7, 15, 30, 60, 90].map(days => {
    const future = new Date(instant(asOf) + days * 86_400_000).toISOString();
    const copy = structuredClone(document);
    const validPrice = !['STALE', 'MISSING', 'MISMATCH'].includes(baseline.quoteState) ? baseline.quote?.priceInr : null;
    copy.position.manualPrice = validPrice ? { priceInr: validPrice, at: future } : null;
    const projected = derivePortfolioPosition(copy, scope, future, null);
    return { days, asOf: future, evidence: 'PROJECTED' as const, additionalInterestInr: projected.metrics?.interestAccruedInr !== null && baseline.metrics?.interestAccruedInr !== null && projected.metrics && baseline.metrics ? money(amount(projected.metrics.interestAccruedInr!).sub(baseline.metrics.interestAccruedInr!)) : null,
      costAdjustedPriceInr: projected.metrics?.costAdjustedPriceInr ?? null, estimatedBreakEvenPriceInr: projected.metrics?.estimatedBreakEvenPriceInr ?? null, pnlInr: projected.metrics?.costAdjustedUnrealizedPnlInr ?? null };
  });
}
export function validateServiceDate(day: string, now: string) { calendarDate(day); requireMtf(day <= istDay(now), 'INVALID_CHRONOLOGY'); }
