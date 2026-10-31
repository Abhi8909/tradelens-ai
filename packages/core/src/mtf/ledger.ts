import { D, MtfDomainError, addDays, amount, calendarDate, dayNumber, instant, istDay, money, quantity, requireMtf, rounding } from './decimal.ts';
import { estimateMtfSellFees, mtfBreakEven, validateFeeSchedule, validateSource } from './fees.ts';
import type { MtfCalculationOptions, MtfCharge, MtfEvent, MtfExitAllocation, MtfInterestDay, MtfIssue, MtfLot, MtfSnapshot, MtfStatus } from './types.ts';

const zero = () => new D(0);
function booked(value: string, signed = false) { const result = amount(value, signed); requireMtf(result.decimalPlaces() <= 2); return result; }
const sameScope = (a: { tenantId: string; accountId: string }, b: { tenantId: string; accountId: string }) => a.tenantId === b.tenantId && a.accountId === b.accountId;
const canonical = (v: unknown): string => JSON.stringify(v, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);

function validate(lot: MtfLot, options: MtfCalculationOptions) {
  requireMtf(!!lot && !!lot.buy && !!lot.instrument && !!options.policy);
  requireMtf(!!lot.id && !!lot.tenantId && !!lot.accountId && !!lot.buy.id);
  requireMtf(!!lot.instrument.id && !!lot.instrument.isin && !!lot.instrument.exchange && !!lot.instrument.symbol);
  validateSource(lot.buy.source); quantity(lot.buy.quantity);
  requireMtf(amount(lot.buy.priceInr).gt(0));
  const notional = amount(lot.buy.priceInr).mul(lot.buy.quantity).toDecimalPlaces(2);
  requireMtf(notional.gt(0));
  if (lot.buy.fundedInr !== null) requireMtf(booked(lot.buy.fundedInr).lte(notional), 'INVALID_FUNDING');
  const buyTime = instant(lot.buy.at); const asOf = instant(options.asOf);
  requireMtf(asOf >= buyTime, 'INVALID_CHRONOLOGY');
  requireMtf(dayNumber(istDay(options.asOf)) - dayNumber(istDay(lot.buy.at)) <= 36_600);
  requireMtf(Number.isSafeInteger(options.quoteMaxAgeMs) && options.quoteMaxAgeMs >= 0);
  const policy = options.policy;
  if (policy.flatDailyInr !== undefined) amount(policy.flatDailyInr);
  requireMtf(!!policy.id && Number.isInteger(policy.startOffsetDays) && policy.startOffsetDays >= 0 && policy.startOffsetDays <= 30 && typeof policy.includeExitDay === 'boolean');
  requireMtf(['DAILY', 'TOTAL'].includes(policy.rounding.timing)); rounding(policy.rounding.mode);
  requireMtf(Array.isArray(policy.rates) && policy.rates.length <= 1000);
  const rateIds = new Set<string>();
  const rates = [...policy.rates].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  for (const [i, rate] of rates.entries()) {
    requireMtf(!!rate.id && !rateIds.has(rate.id)); rateIds.add(rate.id);
    calendarDate(rate.effectiveFrom); validateSource(rate.source);
    if (rate.effectiveTo !== null) { calendarDate(rate.effectiveTo); requireMtf(rate.effectiveTo >= rate.effectiveFrom); }
    requireMtf(amount(rate.dailyFraction).lte(1));
    if (i) requireMtf(rates[i - 1].effectiveTo !== null && rates[i - 1].effectiveTo! < rate.effectiveFrom);
  }
  requireMtf(Array.isArray(lot.events) && Array.isArray(lot.charges) && lot.events.length + lot.charges.length <= 20_000);
  const ids = new Set([lot.buy.id]);
  for (const record of [...lot.events, ...lot.charges]) {
    requireMtf(!!record.id && !ids.has(record.id), 'DUPLICATE_ID'); ids.add(record.id);
    requireMtf(sameScope(lot, record) && record.lotId === lot.id, 'SCOPE_MISMATCH');
    validateSource(record.source);
    requireMtf(instant(record.at) >= buyTime, 'INVALID_CHRONOLOGY');
  }
  if (options.sellFees) validateFeeSchedule(options.sellFees, istDay(options.asOf));
}

/** Replay one explicitly matched purchase lot. No symbol-based merging or implicit FIFO matching. */
export function calculateMtfLot(lot: MtfLot, options: MtfCalculationOptions): MtfSnapshot {
  const base = {
    tenantId: lot.tenantId, accountId: lot.accountId, lotId: lot.id, calculationVersion: 'mtf-v1' as const,
    asOf: options.asOf, timezone: 'Asia/Kolkata' as const, instrument: lot.instrument, source: lot.buy.source,
    policyId: options.policy.id, feeScheduleId: options.sellFees?.id ?? null, quote: options.quote ? structuredClone(options.quote) : null,
  };
  try {
    validate(lot, options);
    return replay(lot, options, base);
  } catch (error) {
    if (!(error instanceof MtfDomainError)) throw error;
    return { ...base, status: 'NEEDS_REVIEW', metrics: null, dailyInterest: [], exits: [], issues: [{ code: error.code }], quoteState: 'MISSING' };
  }
}

function replay(lot: MtfLot, options: MtfCalculationOptions, base: Omit<MtfSnapshot, 'status' | 'metrics' | 'dailyInterest' | 'exits' | 'issues' | 'quoteState'>): MtfSnapshot {
  const cutoff = instant(options.asOf); const start = istDay(lot.buy.at); const end = istDay(options.asOf);
  const events = lot.events.filter(e => instant(e.at) <= cutoff).sort((a, b) => instant(a.at) - instant(b.at) || a.id.localeCompare(b.id));
  const charges = lot.charges.filter(e => instant(e.at) <= cutoff);
  const issues: MtfIssue[] = [];
  const issue = (code: MtfIssue['code']) => { if (!issues.some(i => i.code === code)) issues.push({ code }); };
  const dayEvents = new Map<string, MtfEvent[]>(); const dayCharges = new Map<string, MtfCharge[]>();
  const actuals = new Map<string, MtfCharge[]>();
  for (const event of events) {
    const day = event.kind === 'FUNDING' ? calendarDate(event.effectiveDate) : istDay(event.at);
    requireMtf(day >= start && day <= istDay(event.at), 'INVALID_CHRONOLOGY');
    if (event.kind === 'FUNDING') { requireMtf(['BORROW', 'REPAY'].includes(event.direction)); booked(event.amountInr); }
    else if (event.kind === 'SELL' || event.kind === 'CONVERT' || event.kind === 'EXIT_UNPRICED') {
      quantity(event.quantity);
      if (event.kind === 'SELL') requireMtf(amount(event.priceInr).gt(0));
      else if (event.kind === 'CONVERT') requireMtf(!!event.destinationLotId && event.destinationLotId !== lot.id);
      if (event.principalRepaidInr !== null) booked(event.principalRepaidInr);
    } else if (event.kind === 'SPLIT' || event.kind === 'BONUS') { quantity(event.numerator); quantity(event.denominator); }
    else if (event.kind === 'RENAME') requireMtf(!!event.instrument.id && !!event.instrument.isin && !!event.instrument.symbol && !!event.instrument.exchange);
    else requireMtf(false);
    const group = dayEvents.get(day) ?? []; group.push(event); dayEvents.set(day, group);
  }
  for (const charge of charges) {
    const day = calendarDate(charge.effectiveDate);
    requireMtf(day >= start && day <= istDay(charge.at), 'INVALID_CHRONOLOGY');
    const value = booked(charge.amountInr, true);
    requireMtf(['INTEREST', 'BROKERAGE', 'PLEDGE', 'UNPLEDGE', 'DP', 'STT', 'STAMP', 'EXCHANGE', 'SEBI', 'GST', 'AUTO_SQUARE_OFF', 'OTHER'].includes(charge.kind));
    requireMtf(['ACTUAL', 'ESTIMATED', 'IMPORTED_UNVERIFIED'].includes(charge.evidence));
    if (charge.evidence === 'IMPORTED_UNVERIFIED') { issue('UNVERIFIED_CHARGE'); continue; }
    if (charge.evidence === 'ACTUAL') requireMtf(charge.source.kind === 'VERIFIED' || charge.source.kind === 'DEMO');
    if (value.lt(0)) {
      const original = charges.find(c => c.id === charge.refundOf);
      requireMtf(!!original && amount(original.amountInr).gt(0) && instant(original.at) <= instant(charge.at) && original.kind === charge.kind && original.effectiveDate === day && original.exitId === charge.exitId && original.evidence === charge.evidence);
      const refunded = charges.filter(c => c.refundOf === original.id).reduce((sum, c) => sum.add(amount(c.amountInr, true)), zero());
      requireMtf(refunded.lte(0) && refunded.abs().lte(original.amountInr));
    } else requireMtf(charge.refundOf === null);
    if (charge.exitId !== null) {
      const exit = events.find(e => e.id === charge.exitId && (e.kind === 'SELL' || e.kind === 'CONVERT' || e.kind === 'EXIT_UNPRICED'));
      requireMtf(!!exit && day === istDay(exit.at));
    }
    if (charge.kind === 'INTEREST') {
      // Statement entries must explicitly allocate to this lot and service date.
      requireMtf(charge.exitId === null && charge.evidence === 'ACTUAL');
      const list = actuals.get(day) ?? []; list.push(charge); actuals.set(day, list);
    } else { const list = dayCharges.get(day) ?? []; list.push(charge); dayCharges.set(day, list); }
  }
  let q = lot.buy.quantity; let principal = lot.buy.fundedInr === null ? null : amount(lot.buy.fundedInr);
  const purchase = amount(lot.buy.priceInr).mul(q).toDecimalPlaces(2);
  let cost = purchase; let openInterest = zero(); let openOther = zero();
  let allocatedInterestTotal = zero();
  let allInterest = zero(); let actualInterest = zero(); let estimatedInterest = zero(); let totalOther = zero();
  let unknownInterest = false; let hasActual = false; let hasEstimate = false; let bearingDays = 0;
  let realized = zero(); let realizedUnknown = false; let instrument = structuredClone(lot.instrument);
  const exits: MtfExitAllocation[] = []; const daily: MtfInterestDay[] = [];
  let lastCorporateTime = instant(lot.buy.at);
  let sold = false; let converted = false; let lastExitDay = end;
  for (let day = start; day <= end; day = addDays(day, 1)) {
    const onDay = dayEvents.get(day) ?? []; const fees = dayCharges.get(day) ?? [];
    for (const event of onDay.filter(e => e.kind === 'FUNDING')) {
      requireMtf(q > 0, 'INVALID_FUNDING');
      requireMtf(principal !== null, 'MISSING_FUNDED_BALANCE');
      principal = event.direction === 'BORROW' ? principal.add(event.amountInr) : principal.sub(event.amountInr);
      requireMtf(principal.gte(0) && principal.lte(cost), 'INVALID_FUNDING');
    }
    const disposalEvents = onDay.filter(e => e.kind === 'SELL' || e.kind === 'CONVERT' || e.kind === 'EXIT_UNPRICED');
    let interestPrincipal = principal;
    if (!options.policy.includeExitDay && interestPrincipal !== null) {
      for (const exit of disposalEvents) {
        if (exit.principalRepaidInr === null) { interestPrincipal = null; break; }
        interestPrincipal = interestPrincipal.sub(exit.principalRepaidInr);
      }
      if (interestPrincipal !== null) requireMtf(interestPrincipal.gte(0), 'INVALID_FUNDING');
    }
    const activeDay = q > 0 && dayNumber(day) >= dayNumber(start) + options.policy.startOffsetDays;
    const rate = options.policy.rates.find(r => r.effectiveFrom <= day && (r.effectiveTo === null || r.effectiveTo >= day));
    const statement = actuals.get(day);
    requireMtf(!statement || activeDay, 'INVALID_CHRONOLOGY');
    if (activeDay) {
      const funded = interestPrincipal;
      if (funded === null) issue('MISSING_FUNDED_BALANCE');
      if (options.policy.flatDailyInr === undefined && funded?.gt(0) && !rate && !statement) issue('RATE_GAP');
      let estimate = options.policy.flatDailyInr !== undefined
        ? amount(options.policy.flatDailyInr).mul(cost).div(purchase)
        : funded === null || (funded.gt(0) && !rate) ? null : funded.mul(rate?.dailyFraction ?? '0');
      if (estimate !== null && options.policy.rounding.timing === 'DAILY') estimate = estimate.toDecimalPlaces(2, rounding(options.policy.rounding.mode));
      const actual = statement ? statement.reduce((sum, c) => sum.add(c.amountInr), zero()) : null;
      const selected = actual ?? estimate;
      if (options.policy.flatDailyInr !== undefined || funded === null || funded.gt(0)) bearingDays++;
      if (selected === null) unknownInterest = true;
      else { allInterest = allInterest.add(selected); openInterest = openInterest.add(selected); }
      if (actual !== null) { actualInterest = actualInterest.add(actual); hasActual = true; }
      else if (estimate !== null) { estimatedInterest = estimatedInterest.add(estimate); hasEstimate = true; }
      daily.push({ date: day, fundedInr: funded === null ? null : money(funded), rateId: rate?.id ?? null, dailyFraction: rate?.dailyFraction ?? null, rateSource: rate ? structuredClone(rate.source) : null,
        estimatedInr: estimate?.toFixed(16) ?? null, actualInr: actual === null ? null : money(actual), selectedInr: selected?.toFixed(16) ?? null,
        varianceInr: actual === null || estimate === null ? null : money(actual.sub(estimate)), evidence: actual !== null ? 'ACTUAL' : estimate !== null ? 'ESTIMATED' : 'UNKNOWN', references: statement?.map(c => c.source.reference) ?? [] });
    }
    for (const fee of fees.filter(c => c.exitId === null)) {
      requireMtf(q > 0, 'INVALID_QUANTITY'); openOther = openOther.add(fee.amountInr); totalOther = totalOther.add(fee.amountInr);
    }
    for (const event of onDay.filter(e => e.kind !== 'FUNDING')) {
      requireMtf(q > 0, 'INVALID_QUANTITY');
      if (event.kind === 'SPLIT' || event.kind === 'BONUS') {
        lastCorporateTime = instant(event.at);
        const next = new D(q).mul(event.numerator).div(event.denominator);
        requireMtf(next.isInteger() && next.gt(0) && next.lte(1_000_000_000), 'UNSUPPORTED_CORPORATE_ACTION'); q = next.toNumber();
      } else if (event.kind === 'RENAME') {
        lastCorporateTime = instant(event.at);
        instrument = structuredClone(event.instrument);
      } else if (event.kind === 'SELL' || event.kind === 'CONVERT' || event.kind === 'EXIT_UNPRICED') {
        requireMtf(event.quantity <= q, 'INVALID_QUANTITY');
        const ratio = new D(event.quantity).div(q);
        const allocate = (v: InstanceType<typeof D>) => event.quantity === q ? v : v.mul(ratio).toDecimalPlaces(2, rounding(options.policy.rounding.mode));
        const allocatedCost = allocate(cost);
        const allocatedInterest = event.quantity === q ? allInterest.toDecimalPlaces(2, rounding(options.policy.rounding.mode)).sub(allocatedInterestTotal) : allocate(openInterest);
        allocatedInterestTotal = allocatedInterestTotal.add(allocatedInterest);
        const allocatedOther = allocate(openOther);
        const exitFees = fees.filter(c => c.exitId === event.id).reduce((sum, c) => sum.add(c.amountInr), zero()); totalOther = totalOther.add(exitFees);
        const incurred = allocatedInterest.add(allocatedOther).add(exitFees);
        cost = cost.sub(allocatedCost); openInterest = openInterest.sub(allocatedInterest); openOther = openOther.sub(allocatedOther);
        if (event.principalRepaidInr === null) { principal = null; issue('MISSING_FUNDED_BALANCE'); }
        else if (principal !== null) { principal = principal.sub(event.principalRepaidInr); requireMtf(principal.gte(0), 'INVALID_FUNDING'); }
        q -= event.quantity;
        if (q === 0 && principal !== null) requireMtf(principal.eq(0), 'INVALID_FUNDING');
        const proceeds = event.kind === 'SELL' ? amount(event.priceInr).mul(event.quantity).toDecimalPlaces(2) : null;
        const pnl = proceeds === null || unknownInterest ? null : proceeds.sub(allocatedCost).sub(incurred);
        if (event.kind !== 'CONVERT') { sold = true; if (pnl === null) realizedUnknown = true; else realized = realized.add(pnl); }
        else converted = true;
        exits.push({ eventId: event.id, at: event.at, kind: event.kind, quantity: event.quantity, destinationLotId: event.kind === 'CONVERT' ? event.destinationLotId : null,
          originalCostInr: money(allocatedCost), allocatedCostsInr: unknownInterest ? null : money(incurred), proceedsInr: proceeds === null ? null : money(proceeds), principalRepaidInr: event.principalRepaidInr, realizedPnlInr: pnl === null ? null : money(pnl) });
        lastExitDay = day;
      }
    }
  }
  if (principal === null) issue('MISSING_FUNDED_BALANCE');
  const excluded = issues.some(i => ['UNVERIFIED_CHARGE', 'RATE_GAP'].includes(i.code));
  const status: MtfStatus = excluded ? 'NEEDS_REVIEW' : q > 0 ? (sold || converted ? 'PARTIALLY_SOLD' : 'OPEN_MTF') : converted ? 'CONVERTED_TO_DELIVERY' : 'CLOSED_SOLD';
  openInterest = allInterest.toDecimalPlaces(2, rounding(options.policy.rounding.mode)).sub(allocatedInterestTotal);
  const costs = q === 0 ? zero() : unknownInterest ? null : openInterest.add(openOther);
  const basis = costs === null ? null : cost.add(costs);
  let quoteState: MtfSnapshot['quoteState'] = 'MISSING'; let market: InstanceType<typeof D> | null = null;
  const quote = options.quote;
  if (q === 0) market = zero();
  else if (!quote) issue('MISSING_QUOTE');
  else {
    validateSource(quote.source); const price = amount(quote.priceInr); requireMtf(price.gt(0));
    requireMtf(['LIVE', 'DELAYED', 'EOD', 'DEMO', 'MANUAL'].includes(quote.mode));
    const marketAt = instant(quote.marketAt); const receivedAt = instant(quote.receivedAt);
    if (!sameScope(lot, quote) || quote.instrumentId !== instrument.id || marketAt < lastCorporateTime || marketAt > cutoff || receivedAt > cutoff || receivedAt < marketAt || (quote.mode === 'LIVE' && quote.source.kind !== 'VERIFIED')) { quoteState = 'MISMATCH'; issue('QUOTE_MISMATCH'); }
    else if (cutoff - marketAt >= options.quoteMaxAgeMs) { quoteState = 'STALE'; issue('STALE_QUOTE'); }
    else { quoteState = quote.mode; market = price.mul(q); }
  }
  const gross = market === null ? null : market.sub(cost);
  const adjusted = gross === null || costs === null ? null : gross.sub(costs);
  const estimatedFees = q && market !== null && options.sellFees ? estimateMtfSellFees(quote!.priceInr, q, options.sellFees, end).totalInr : null;
  return { ...base, instrument, status, issues, quoteState, dailyInterest: daily, exits,
    metrics: {
      originalQuantity: lot.buy.quantity, quantityOpen: q, grossPurchaseNotionalInr: money(purchase), originalBuyPriceInr: lot.buy.priceInr,
      remainingPurchaseCostInr: money(cost), initialOwnFundsInr: lot.buy.fundedInr === null ? null : money(purchase.sub(lot.buy.fundedInr)), fundedOutstandingInr: principal === null ? null : money(principal),
      interestAccruedInr: unknownInterest ? null : money(allInterest.toDecimalPlaces(2, rounding(options.policy.rounding.mode))), actualInterestInr: money(actualInterest), estimatedInterestInr: money(estimatedInterest.toDecimalPlaces(2, rounding(options.policy.rounding.mode))),
      interestEvidence: unknownInterest ? 'UNKNOWN' : hasActual && hasEstimate ? 'MIXED' : hasActual ? 'ACTUAL' : 'ESTIMATED',
      openInterestInr: q === 0 ? '0.00' : unknownInterest ? null : money(openInterest), openIncurredCostsInr: costs === null ? null : money(costs), openOtherChargesInr: money(openOther), totalOtherChargesInr: money(totalOther),
      costAdjustedPriceInr: !q || basis === null ? null : basis.div(q).toFixed(4), grossMarketValueInr: market === null ? null : money(market),
      grossUnrealizedPnlInr: gross === null ? null : money(gross), costAdjustedUnrealizedPnlInr: adjusted === null ? null : money(adjusted),
      estimatedSellFeesInr: estimatedFees, estimatedNetExitPnlInr: estimatedFees === null || adjusted === null ? null : money(adjusted.sub(estimatedFees)),
      estimatedBreakEvenPriceInr: !q || basis === null || !options.sellFees ? null : mtfBreakEven(basis.toFixed(8), q, options.sellFees, end),
      realizedPnlInr: realizedUnknown ? null : money(realized), realizedEvidence: lot.buy.source.kind === 'DEMO' ? 'DEMO' : 'ESTIMATED', ownCapitalReturnPct: null,
      daysHeld: dayNumber(q ? end : lastExitDay) - dayNumber(start), interestBearingDays: bearingDays,
    } };
}

/** Append-only helper. Retries with identical IDs/content are no-ops; conflicts are rejected. */
export function appendMtfEvent(lot: MtfLot, event: MtfEvent): MtfLot {
  requireMtf(sameScope(lot, event) && event.lotId === lot.id, 'SCOPE_MISMATCH');
  const prior = lot.events.find(e => e.id === event.id);
  if (prior) { requireMtf(canonical(prior) === canonical(event), 'DUPLICATE_ID'); return structuredClone(lot); }
  requireMtf(event.id !== lot.buy.id && !lot.charges.some(c => c.id === event.id), 'DUPLICATE_ID');
  return structuredClone({ ...lot, events: [...lot.events, event] });
}
