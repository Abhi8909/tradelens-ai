/** Decimal INR strings at boundaries. No prices, rates or ledger amounts are JS numbers. */
export type MtfSource = {
  kind: 'DEMO' | 'MANUAL_UNVERIFIED' | 'VERIFIED'; reference: string;
};
export type MtfScope = { tenantId: string; accountId: string };
export type MtfInstrument = {
  id: string; exchange: string; isin: string; symbol: string;
  aliases: { symbol: string; from: string; to: string | null }[];
};
export type MtfStatus = 'OPEN_MTF' | 'PARTIALLY_SOLD' | 'CLOSED_SOLD' | 'CONVERTED_TO_DELIVERY' | 'NEEDS_REVIEW';
export type MtfChargeKind = 'INTEREST' | 'BROKERAGE' | 'PLEDGE' | 'UNPLEDGE' | 'DP' | 'STT' | 'STAMP' | 'EXCHANGE' | 'SEBI' | 'GST' | 'AUTO_SQUARE_OFF' | 'OTHER';
export type MtfEventBase = MtfScope & { id: string; lotId: string; at: string; source: MtfSource };
export type MtfSale = MtfEventBase & { kind: 'SELL'; quantity: number; priceInr: string; principalRepaidInr: string | null };
export type MtfConversion = MtfEventBase & {
  kind: 'CONVERT'; quantity: number; destinationLotId: string; principalRepaidInr: string | null;
};
export type MtfEvent = MtfSale | MtfConversion
  | (MtfEventBase & { kind: 'EXIT_UNPRICED'; quantity: number; principalRepaidInr: string | null })
  | (MtfEventBase & { kind: 'FUNDING'; effectiveDate: string; direction: 'BORROW' | 'REPAY'; amountInr: string })
  | (MtfEventBase & { kind: 'SPLIT' | 'BONUS'; numerator: number; denominator: number })
  | (MtfEventBase & { kind: 'RENAME'; instrument: MtfInstrument });
export type MtfCharge = MtfEventBase & {
  kind: MtfChargeKind; effectiveDate: string; amountInr: string;
  evidence: 'ACTUAL' | 'ESTIMATED' | 'IMPORTED_UNVERIFIED';
  /** Null = proportional to shares held on effectiveDate. Exit ID = specific sale/conversion costs. */
  exitId: string | null;
  /** Refunds must reference an earlier positive charge and use the same service day/allocation. */
  refundOf: string | null;
};
export type MtfLot = MtfScope & {
  id: string; instrument: MtfInstrument;
  buy: { id: string; at: string; quantity: number; priceInr: string; fundedInr: string | null; source: MtfSource };
  events: MtfEvent[]; charges: MtfCharge[];
};
export type MtfRounding = { timing: 'DAILY' | 'TOTAL'; mode: 'HALF_UP' | 'HALF_EVEN' | 'DOWN' };
export type MtfRate = {
  id: string; effectiveFrom: string; effectiveTo: string | null;
  dailyFraction: string; source: MtfSource;
};
export type MtfInterestPolicy = {
  id: string; startOffsetDays: number;
  /** Optional user-estimated flat daily cost, prorated by remaining original units. */
  flatDailyInr?: string;
  /** Exit-day interest uses balance before sale/conversion repayments if true. */
  includeExitDay: boolean; rounding: MtfRounding; rates: MtfRate[];
};
/** Explicitly supplied fee model; never assume this covers a broker's complete statutory schedule. */
export type MtfFeeSchedule = {
  id: string; effectiveFrom: string; effectiveTo: string | null; source: MtfSource;
  roundingMode: MtfRounding['mode'];
  lines: { id: string; kind: Exclude<MtfChargeKind, 'INTEREST'>; fixedInr: string; turnoverFraction: string; capInr: string | null }[];
};
export type MtfQuote = MtfScope & {
  instrumentId: string; priceInr: string; marketAt: string; receivedAt: string;
  mode: 'LIVE' | 'DELAYED' | 'EOD' | 'DEMO' | 'MANUAL'; source: MtfSource;
};
export type MtfIssueCode = 'INVALID_INPUT' | 'INVALID_CHRONOLOGY' | 'SCOPE_MISMATCH' | 'DUPLICATE_ID' | 'INVALID_QUANTITY' | 'INVALID_FUNDING' | 'MISSING_FUNDED_BALANCE' | 'RATE_GAP' | 'UNVERIFIED_CHARGE' | 'MISSING_QUOTE' | 'STALE_QUOTE' | 'QUOTE_MISMATCH' | 'UNSUPPORTED_CORPORATE_ACTION';
export type MtfIssue = { code: MtfIssueCode };
export type MtfInterestDay = {
  date: string; fundedInr: string | null; rateId: string | null; dailyFraction: string | null; rateSource: MtfSource | null;
  estimatedInr: string | null; actualInr: string | null; selectedInr: string | null;
  varianceInr: string | null; evidence: 'ACTUAL' | 'ESTIMATED' | 'UNKNOWN'; references: string[];
};
export type MtfExitAllocation = {
  eventId: string; at: string; kind: 'SELL' | 'CONVERT' | 'EXIT_UNPRICED'; quantity: number; destinationLotId: string | null;
  originalCostInr: string; allocatedCostsInr: string | null; proceedsInr: string | null;
  principalRepaidInr: string | null; realizedPnlInr: string | null;
};
export type MtfMetrics = {
  originalQuantity: number; quantityOpen: number; grossPurchaseNotionalInr: string; originalBuyPriceInr: string;
  remainingPurchaseCostInr: string; initialOwnFundsInr: string | null; fundedOutstandingInr: string | null;
  interestAccruedInr: string | null; actualInterestInr: string; estimatedInterestInr: string;
  interestEvidence: 'ACTUAL' | 'ESTIMATED' | 'MIXED' | 'UNKNOWN';
  openInterestInr: string | null; openIncurredCostsInr: string | null; openOtherChargesInr: string; totalOtherChargesInr: string;
  costAdjustedPriceInr: string | null; grossMarketValueInr: string | null;
  grossUnrealizedPnlInr: string | null; costAdjustedUnrealizedPnlInr: string | null;
  estimatedSellFeesInr: string | null; estimatedNetExitPnlInr: string | null; estimatedBreakEvenPriceInr: string | null;
  realizedPnlInr: string | null; realizedEvidence: 'DEMO' | 'ESTIMATED'; ownCapitalReturnPct: null;
  daysHeld: number; interestBearingDays: number;
};
export type MtfSnapshot = MtfScope & {
  lotId: string; calculationVersion: 'mtf-v1'; asOf: string; timezone: 'Asia/Kolkata';
  status: MtfStatus; instrument: MtfInstrument; source: MtfSource;
  policyId: string; feeScheduleId: string | null; issues: MtfIssue[];
  quote: MtfQuote | null;
  quoteState: MtfQuote['mode'] | 'STALE' | 'MISSING' | 'MISMATCH';
  metrics: MtfMetrics | null; dailyInterest: MtfInterestDay[]; exits: MtfExitAllocation[];
};
export type MtfCalculationOptions = { asOf: string; policy: MtfInterestPolicy; quote?: MtfQuote | null; quoteMaxAgeMs: number; sellFees?: MtfFeeSchedule | null };
