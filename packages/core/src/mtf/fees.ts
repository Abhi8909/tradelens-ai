import { D, amount, calendarDate, money, istDay, quantity, requireMtf, rounding } from './decimal.ts';
import type { MtfFeeSchedule, MtfSource } from './types.ts';

export function validateSource(source: MtfSource) {
  requireMtf(!!source && ['DEMO', 'MANUAL_UNVERIFIED', 'VERIFIED'].includes(source.kind) && typeof source.reference === 'string' && source.reference.trim().length > 0 && source.reference.length <= 500);
}
export function validateFeeSchedule(schedule: MtfFeeSchedule, day: string) {
  calendarDate(day); calendarDate(schedule.effectiveFrom);
  if (schedule.effectiveTo !== null) calendarDate(schedule.effectiveTo);
  requireMtf(!!schedule.id && schedule.effectiveFrom <= day && (schedule.effectiveTo === null || day <= schedule.effectiveTo));
  validateSource(schedule.source); rounding(schedule.roundingMode);
  requireMtf(Array.isArray(schedule.lines) && schedule.lines.length <= 30);
  const ids = new Set<string>(); let maxSlope = new D(0);
  for (const line of schedule.lines) {
    requireMtf(!!line.id && !ids.has(line.id)); ids.add(line.id);
    requireMtf(['BROKERAGE', 'PLEDGE', 'UNPLEDGE', 'DP', 'STT', 'STAMP', 'EXCHANGE', 'SEBI', 'GST', 'AUTO_SQUARE_OFF', 'OTHER'].includes(line.kind));
    amount(line.fixedInr); maxSlope = maxSlope.add(amount(line.turnoverFraction));
    if (line.capInr !== null) amount(line.capInr);
  }
  // Ensures net sale proceeds are monotone apart from paise-rounding steps.
  requireMtf(maxSlope.lt(1));
}
function feesFor(value: InstanceType<typeof D>, schedule: MtfFeeSchedule) {
  let total = new D(0);
  const lines = schedule.lines.map(line => {
    let fee = value.mul(line.turnoverFraction).add(line.fixedInr);
    if (line.capInr !== null) fee = D.min(fee, line.capInr);
    fee = fee.toDecimalPlaces(2, rounding(schedule.roundingMode)); total = total.add(fee);
    return { id: line.id, kind: line.kind, amountInr: money(fee) };
  });
  return { totalInr: money(total), lines };
}
export function estimateMtfSellFees(priceInr: string, shares: number, schedule: MtfFeeSchedule, day: string) {
  validateFeeSchedule(schedule, day); quantity(shares);
  return { ...feesFor(amount(priceInr).mul(shares), schedule), scheduleId: schedule.id, evidence: 'ESTIMATED' as const };
}
/** Continuous unrounded fee algebra + conservative paise reserve, then discrete 4dp grid search.
 * Rounded fee steps can make net proceeds locally nonmonotone; reserve bounds the root search. */
export function mtfBreakEven(basisInr: string, shares: number, schedule: MtfFeeSchedule, day: string): string {
  validateFeeSchedule(schedule, day); quantity(shares);
  const basis = amount(basisInr); let low = new D(0); let high = D.max(1, basis.div(shares));
  const unroundedNet = (p: InstanceType<typeof D>) => {
    const value = p.mul(shares);
    const fee = schedule.lines.reduce((sum, line) => sum.add(line.capInr === null ? value.mul(line.turnoverFraction).add(line.fixedInr) : D.min(line.capInr, value.mul(line.turnoverFraction).add(line.fixedInr))), new D(0));
    return value.sub(fee).sub(basis);
  };
  // Every fee line differs from its unrounded value by < 0.01 INR.
  const reserve = new D(schedule.lines.length).mul('0.01');
  for (let i = 0; unroundedNet(high).lt(reserve) && i < 100; i++) high = high.mul(2);
  requireMtf(unroundedNet(high).gte(reserve));
  for (let i = 0; i < 100; i++) { const mid = low.add(high).div(2); if (unroundedNet(mid).gte(reserve)) high = mid; else low = mid; }
  let price = high.toDecimalPlaces(4, D.ROUND_CEIL);
  // Bounded refinement finds the lowest satisfying 4dp tick in the rounding neighborhood.
  const start = D.max(0, price.sub(reserve.mul(2).div(shares)).sub('0.0002')).toDecimalPlaces(4, D.ROUND_FLOOR);
  const steps = price.sub(start).mul(10_000).toNumber();
  for (let i = 0; i <= steps; i++) {
    const candidate = start.add(new D(i).div(10_000));
    if (candidate.mul(shares).sub(feesFor(candidate.mul(shares), schedule).totalInr).gte(basis)) { price = candidate; break; }
  }
  return price.toFixed(4);
}

/** Allocate one explicit per-ISIN/per-purchase-day request fee, never one charge per fill.
 * Largest-remainder paise allocation conserves the booked fee, even for many tiny lots. */
export function allocateMtfRequestFee(lots: import('./types.ts').MtfLot[], totalInr: string, requestId: string) {
  requireMtf(Array.isArray(lots) && lots.length > 0 && lots.length <= 1000 && !!requestId);
  const first = lots[0];
  const purchaseDate = istDay(first.buy.at);
  const ids = new Set<string>(); let shares = new D(0);
  for (const lot of lots) {
    requireMtf(lot.tenantId === first.tenantId && lot.accountId === first.accountId && lot.instrument.isin === first.instrument.isin && lot.instrument.exchange === first.instrument.exchange && istDay(lot.buy.at) === purchaseDate, 'SCOPE_MISMATCH');
    requireMtf(!ids.has(lot.id), 'DUPLICATE_ID'); ids.add(lot.id); quantity(lot.buy.quantity); shares = shares.add(lot.buy.quantity);
  }
  const paise = amount(totalInr).mul(100); requireMtf(paise.isInteger());
  const allocations = lots.map(lot => {
    const exact = paise.mul(lot.buy.quantity).div(shares); const whole = exact.floor();
    return { lotId: lot.id, paise: whole, remainder: exact.sub(whole) };
  });
  const remaining = paise.sub(allocations.reduce((a, v) => a.add(v.paise), new D(0))).toNumber();
  allocations.sort((a, b) => b.remainder.cmp(a.remainder) || a.lotId.localeCompare(b.lotId));
  for (let i = 0; i < remaining; i++) allocations[i].paise = allocations[i].paise.add(1);
  return { tenantId: first.tenantId, accountId: first.accountId, isin: first.instrument.isin, purchaseDate, requestId,
    totalInr: money(amount(totalInr)), allocations: allocations.sort((a, b) => a.lotId.localeCompare(b.lotId)).map(a => ({ lotId: a.lotId, amountInr: a.paise.div(100).toFixed(2) })) };
}
