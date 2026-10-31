export const ROLLOVER_POLICY = "PRE_EXPIRY_T_MINUS_1_V1" as const;
export type RolloverEvidence = "DEMO" | "UNVERIFIED" | "VERIFIED";
export type Metric = { value: number | null; reason: string | null };
export type MetricKey =
  | "spot"
  | "momPct"
  | "nearClose"
  | "nextClose"
  | "basisInr"
  | "basisPct"
  | "nearOi"
  | "nextOi"
  | "farOi"
  | "totalOi"
  | "rolloverPct"
  | "spreadInr"
  | "spreadPct";
export type RolloverSource = {
  id: string;
  segment: "FO" | "CM";
  reportDate: string;
  receivedAt: string;
  evidence: RolloverEvidence;
  reference: string;
  schemaVersion: string;
  sha256: string | null;
};
export type ExpiryCalendar = {
  month: string;
  actualExpiry: string;
  tradingDates: string[];
  evidence: RolloverEvidence;
  reference: string;
};
export type RolloverContract = {
  symbol: string;
  tradeDate: string;
  expiry: string;
  instrument: string;
  close: number | null;
  oi: number | null;
  oiUnit: "SHARES" | "CONTRACTS";
};
export type RolloverInput = {
  symbol: string;
  sector: string;
  calendar: ExpiryCalendar;
  contracts: RolloverContract[];
  cash: {
    symbol: string;
    tradeDate: string;
    series: string;
    close: number | null;
  } | null;
  farConfirmedAbsent: boolean;
  sources: RolloverSource[];
  previousSpot?: { month: string; value: number | null; policy: string };
};
export type RolloverRow = {
  symbol: string;
  sector: string;
  month: string;
  snapshotDate: string;
  actualExpiry: string;
  policy: typeof ROLLOVER_POLICY;
  calculationVersion: "rollover-v1";
  evidence: RolloverEvidence;
  status: "COMPLETE" | "INCOMPLETE";
  issues: string[];
  contracts: RolloverContract[];
  sources: RolloverSource[];
  metrics: Record<MetricKey, Metric>;
};
export type RolloverAverage = {
  value: number | null;
  count: number;
  months: string[];
  reason: string | null;
};
export type RolloverViewRow = RolloverRow & {
  average: RolloverAverage;
  basisAverage: RolloverAverage;
  spreadAverage: RolloverAverage;
  priorBenchmark: RolloverAverage;
  deltaPp: Metric;
};
export type RolloverAggregate = {
  eligible: number;
  total: number;
  equalWeight: number | null;
  oiWeighted: number | null;
  averageSpread: number | null;
  unit: string | null;
};
export type RolloverDataset = {
  evidence: RolloverEvidence;
  calendarReference: string;
  rows: RolloverRow[];
  months: {
    month: string;
    snapshotDate: string;
    actualExpiry: string;
    status: "COMPLETE" | "INCOMPLETE" | "MISSING";
    evidence: RolloverEvidence;
    lastSync: string | null;
    issues: string[];
  }[];
};
