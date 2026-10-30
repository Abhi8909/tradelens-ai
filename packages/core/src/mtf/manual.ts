import { D, amount, calendarDate, dayNumber, money, quantity, requireMtf } from './decimal.ts';
import { MARKET_SYMBOL } from '../marketData.ts';

export type ManualMtfPosition = {
  id: string; symbol: string; boughtDate: string; quantity: number; buyPriceInr: string;
  interestPerDayInr: string; otherChargesInr: string; exitDate: string | null;
  manualPrice: { priceInr: string; at: string } | null;
};
export function validateManualMtfPosition(position: ManualMtfPosition, asOfDate: string): void {
  calendarDate(asOfDate); calendarDate(position.boughtDate);
  requireMtf(typeof position.id === 'string' && position.id.length > 0 && position.id.length <= 100);
  requireMtf(typeof position.symbol === 'string' && MARKET_SYMBOL.test(position.symbol));
  quantity(position.quantity); requireMtf(amount(position.buyPriceInr).gt(0));
  amount(position.interestPerDayInr); amount(position.otherChargesInr);
  requireMtf(position.boughtDate <= asOfDate, 'INVALID_CHRONOLOGY');
  if (position.exitDate !== null) { calendarDate(position.exitDate); requireMtf(position.exitDate >= position.boughtDate && position.exitDate <= asOfDate, 'INVALID_CHRONOLOGY'); }
  if (position.manualPrice !== null) {
    requireMtf(amount(position.manualPrice.priceInr).gt(0));
    requireMtf(typeof position.manualPrice.at === 'string' && Number.isFinite(Date.parse(position.manualPrice.at)));
  }
}
/** User-entered flat daily-cost tracker. Separate from actual-funded broker-ledger calculations. */
export function calculateManualMtf(position: ManualMtfPosition, asOfDate: string, currentPriceInr: string | null) {
  validateManualMtfPosition(position, asOfDate);
  const days = dayNumber(position.exitDate ?? asOfDate) - dayNumber(position.boughtDate);
  const interest = amount(position.interestPerDayInr).mul(days).toDecimalPlaces(2);
  const charges = interest.add(position.otherChargesInr).toDecimalPlaces(2);
  const invested = amount(position.buyPriceInr).mul(position.quantity).toDecimalPlaces(2);
  const basis = invested.add(charges);
  const market = currentPriceInr === null || position.exitDate !== null ? null : amount(currentPriceInr).mul(position.quantity);
  if (currentPriceInr !== null) requireMtf(amount(currentPriceInr).gt(0));
  const pnl = market === null ? null : market.sub(basis);
  return { days, interestInr: money(interest), totalChargesInr: money(charges), investedInr: money(invested),
    costBasisInr: money(basis), adjustedBuyPriceInr: basis.div(position.quantity).toFixed(4),
    marketValueInr: market === null ? null : money(market), pnlInr: pnl === null ? null : money(pnl),
    pnlPct: pnl === null ? null : pnl.div(basis).mul(100).toFixed(2), closed: position.exitDate !== null };
}
export function summarizeManualMtf(rows: ReturnType<typeof calculateManualMtf>[]) {
  const open = rows.filter(r => !r.closed); const priced = open.filter(r => r.pnlInr !== null);
  const sum = (key: 'investedInr' | 'interestInr' | 'totalChargesInr' | 'costBasisInr') => open.reduce((a, r) => a.add(r[key]), new D(0));
  const basis = sum('costBasisInr'); const partialPnl = priced.reduce((a, r) => a.add(r.pnlInr!), new D(0));
  const complete = open.length === priced.length;
  return { count: open.length, priced: priced.length, complete, investedInr: money(sum('investedInr')), interestInr: money(sum('interestInr')),
    chargesInr: money(sum('totalChargesInr')), basisInr: money(basis), partialPnlInr: money(partialPnl),
    pnlInr: complete ? money(partialPnl) : null, pnlPct: complete && basis.gt(0) ? partialPnl.div(basis).mul(100).toFixed(2) : null };
}

export const MANUAL_MTF_STORAGE_KEY = 'tradelens-manual-mtf-v1';
export function parseManualMtfStorage(raw: string | null, today: string): ManualMtfPosition[] {
  if (raw === null) return [];
  const data = JSON.parse(raw);
  requireMtf(data?.version === 1 && Array.isArray(data.positions) && data.positions.length <= 500);
  const ids = new Set<string>();
  for (const row of data.positions) {
    requireMtf(row && typeof row === 'object'); validateManualMtfPosition(row, today);
    requireMtf(!ids.has(row.id), 'DUPLICATE_ID'); ids.add(row.id);
  }
  return data.positions;
}
