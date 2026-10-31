import { Decimal } from "decimal.js";
import {
  ROLLOVER_POLICY,
  type ExpiryCalendar,
  type Metric,
  type MetricKey,
  type RolloverAggregate,
  type RolloverAverage,
  type RolloverInput,
  type RolloverRow,
  type RolloverViewRow,
} from "./rolloverTypes.ts";
const D = Decimal.clone({ precision: 50 });
const metric = (
  value: number | null,
  reason: string | null = null,
): Metric => ({
  value,
  reason: value === null ? (reason ?? "Unavailable") : null,
});
export function validDate(day: string): boolean {
  return (
    typeof day === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    Number.isFinite(Date.parse(`${day}T00:00:00Z`)) &&
    new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day
  );
}
export function monthOffset(month: string, offset: number): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    throw new Error("Invalid month; expected YYYY-MM");
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 7);
}
/** The caller supplies an authoritative calendar. No weekday expiry rule is guessed here. */
export function snapshotBeforeExpiry(calendar: ExpiryCalendar): string {
  monthOffset(calendar.month, 0);
  if (
    !validDate(calendar.actualExpiry) ||
    calendar.actualExpiry.slice(0, 7) !== calendar.month ||
    !calendar.reference ||
    !calendar.tradingDates.every(validDate)
  )
    throw new Error("Invalid expiry calendar");
  const dates = [...new Set(calendar.tradingDates)].sort();
  if (
    dates.length !== calendar.tradingDates.length ||
    !dates.includes(calendar.actualExpiry)
  )
    throw new Error("Actual expiry must be a confirmed trading session");
  const previous = dates.filter((day) => day < calendar.actualExpiry).at(-1);
  if (!previous || previous.slice(0, 7) !== calendar.month)
    throw new Error("Missing pre-expiry trading session");
  return previous;
}
function validSourceTimestamp(value: string, reportDate: string): boolean {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) ||
    !validDate(value.slice(0, 10))
  )
    return false;
  return (
    Number(value.slice(11, 13)) < 24 &&
    Number(value.slice(14, 16)) < 60 &&
    Number(value.slice(17, 19)) < 60 &&
    Number.isFinite(Date.parse(value)) &&
    Date.parse(value) >= Date.parse(reportDate + "T00:00:00+05:30")
  );
}
const positive = (n: number | null) =>
  typeof n === "number" && Number.isFinite(n) && n > 0;
const openInterest = (n: number | null) =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
export function percentageChange(
  current: number | null,
  previous: number | null,
): Metric {
  if (!positive(current) || !positive(previous))
    return metric(null, "Positive current and previous prices required");
  return metric(
    new D(current!).minus(previous!).div(previous!).times(100).toNumber(),
  );
}
export function averageValues(values: number[]): number | null {
  if (!values.length || values.some((v) => !Number.isFinite(v))) return null;
  return values
    .reduce((sum, value) => sum.plus(value), new D(0))
    .div(values.length)
    .toNumber();
}
export function calculateRollover(input: RolloverInput): RolloverRow {
  const snapshotDate = snapshotBeforeExpiry(input.calendar);
  const issues: string[] = [];
  const metrics = Object.fromEntries(
    [
      "spot",
      "momPct",
      "nearClose",
      "nextClose",
      "basisInr",
      "basisPct",
      "nearOi",
      "nextOi",
      "farOi",
      "totalOi",
      "rolloverPct",
      "spreadInr",
      "spreadPct",
    ].map((k) => [k, metric(null, "Missing or invalid source inputs")]),
  ) as Record<MetricKey, Metric>;
  const issue = (message: string) => {
    if (!issues.includes(message)) issues.push(message);
  };
  const fo = input.sources.find((s) => s.segment === "FO");
  const cm = input.sources.find((s) => s.segment === "CM");
  const evidence =
    input.calendar.evidence === "DEMO" ||
    input.sources.some((s) => s.evidence === "DEMO")
      ? "DEMO"
      : input.calendar.evidence === "VERIFIED" &&
          input.sources.length === 2 &&
          input.sources.every((s) => s.evidence === "VERIFIED")
        ? "VERIFIED"
        : "UNVERIFIED";
  const validSource = (source: typeof fo) =>
    !!source &&
    !!source.id &&
    !!source.schemaVersion &&
    !!source.reference &&
    validSourceTimestamp(source.receivedAt, source.reportDate);
  let foValid =
    validSource(fo) &&
    fo!.reportDate === snapshotDate &&
    input.sources.filter((s) => s.segment === "FO").length === 1;
  if (!foValid) issue("FO final report missing or date mismatch");
  if (input.contracts.some((c) => !["STF"].includes(c.instrument)))
    issue(
      "Non-stock-futures records excluded; normalized instrument mapping needs verification",
    );
  const contracts = input.contracts
    .filter(
      (c) =>
        ["STF"].includes(c.instrument) &&
        validDate(c.expiry) &&
        c.expiry >= snapshotDate,
    )
    .sort((a, b) => a.expiry.localeCompare(b.expiry));
  if (
    input.contracts.some(
      (c) =>
        !validDate(c.expiry) ||
        c.symbol !== input.symbol ||
        c.tradeDate !== snapshotDate,
    )
  ) {
    foValid = false;
    issue("Contract symbol, date or expiry mismatch");
  }
  if (new Set(contracts.map((c) => c.expiry)).size !== contracts.length) {
    foValid = false;
    issue("Duplicate contract expiry");
  }
  if (
    contracts.length < 2 ||
    contracts.length > 3 ||
    contracts[0]?.expiry !== input.calendar.actualExpiry
  ) {
    foValid = false;
    issue("Near/next contract or actual monthly expiry mismatch");
  }
  if (
    new Set(contracts.map((c) => c.oiUnit)).size !== 1 ||
    contracts.some((c) => !["SHARES", "CONTRACTS"].includes(c.oiUnit))
  ) {
    foValid = false;
    issue("Mixed or unknown OI units");
  }
  if (contracts.length === 2 && !input.farConfirmedAbsent) {
    foValid = false;
    issue("Far contract missing; absence is not confirmed");
  }
  if (contracts.some((c) => !positive(c.close)))
    issue("Missing or invalid futures close");
  const [near, next, far] = contracts;
  if (foValid) {
    metrics.nearClose = metric(
      positive(near.close) ? near.close : null,
      "Near close missing or invalid",
    );
    metrics.nextClose = metric(
      positive(next.close) ? next.close : null,
      "Next close missing or invalid",
    );
    metrics.nearOi = metric(
      openInterest(near.oi) ? near.oi : null,
      "Near OI missing or invalid",
    );
    metrics.nextOi = metric(
      openInterest(next.oi) ? next.oi : null,
      "Next OI missing or invalid",
    );
    metrics.farOi = metric(
      far ? (openInterest(far.oi) ? far.oi : null) : 0,
      "Far OI missing or invalid",
    );
    if (
      [metrics.nearOi, metrics.nextOi, metrics.farOi].every(
        (m) => m.value !== null,
      )
    ) {
      const total = new D(metrics.nearOi.value!)
        .plus(metrics.nextOi.value!)
        .plus(metrics.farOi.value!);
      metrics.totalOi = total.lte(Number.MAX_SAFE_INTEGER)
        ? metric(total.toNumber())
        : metric(null, "OI total exceeds safe numeric range");
      metrics.rolloverPct = total.gt(Number.MAX_SAFE_INTEGER)
        ? metric(null, "OI total exceeds safe numeric range")
        : total.gt(0)
          ? metric(
              new D(metrics.nextOi.value!)
                .plus(metrics.farOi.value!)
                .div(total)
                .times(100)
                .toNumber(),
            )
          : metric(null, "Total OI is zero");
    }
    if (
      positive(metrics.nearClose.value) &&
      positive(metrics.nextClose.value)
    ) {
      metrics.spreadInr = metric(
        new D(next.close!).minus(near.close!).toNumber(),
      );
      metrics.spreadPct = percentageChange(next.close, near.close);
    }
  }
  const cashValid =
    input.cash?.symbol === input.symbol &&
    input.cash.tradeDate === snapshotDate &&
    input.cash.series === "EQ" &&
    validSource(cm) &&
    cm?.reportDate === snapshotDate &&
    input.sources.filter((s) => s.segment === "CM").length === 1;
  if (!cashValid)
    issue(
      "CM final report missing, symbol/series mismatch or FO/CM date mismatch",
    );
  metrics.spot = metric(
    cashValid && positive(input.cash!.close) ? input.cash!.close : null,
    "Cash close unavailable or date mismatch",
  );
  if (positive(metrics.spot.value) && positive(metrics.nearClose.value)) {
    metrics.basisInr = metric(
      new D(metrics.nearClose.value!).minus(metrics.spot.value!).toNumber(),
    );
    metrics.basisPct = percentageChange(
      metrics.nearClose.value,
      metrics.spot.value,
    );
  }
  metrics.momPct =
    input.previousSpot?.month === monthOffset(input.calendar.month, -1) &&
    input.previousSpot.policy === ROLLOVER_POLICY
      ? percentageChange(metrics.spot.value, input.previousSpot.value)
      : metric(null, "Previous comparable calendar month unavailable");
  for (const key of [
    "spot",
    "nearClose",
    "nextClose",
    "rolloverPct",
    "spreadPct",
    "basisPct",
  ] as MetricKey[])
    if (metrics[key].value === null) issue(`${key}: ${metrics[key].reason}`);
  return {
    symbol: input.symbol,
    sector: input.sector,
    month: input.calendar.month,
    snapshotDate,
    actualExpiry: input.calendar.actualExpiry,
    policy: ROLLOVER_POLICY,
    calculationVersion: "rollover-v1",
    evidence,
    status: issues.length ? "INCOMPLETE" : "COMPLETE",
    issues,
    contracts,
    sources: input.sources,
    metrics,
  };
}
export function historicalAverage(
  rows: RolloverRow[],
  selected: RolloverRow,
  key: MetricKey,
  previousOnly = false,
): RolloverAverage {
  const candidates = rows
    .filter(
      (r) =>
        r.symbol === selected.symbol &&
        r.policy === selected.policy &&
        r.evidence === selected.evidence &&
        r.status === "COMPLETE" &&
        r.month <=
          (previousOnly ? monthOffset(selected.month, -1) : selected.month) &&
        r.metrics[key].value !== null,
    )
    .sort((a, b) => a.month.localeCompare(b.month));
  if (new Set(candidates.map((r) => r.month)).size !== candidates.length)
    throw new Error("Duplicate historical month");
  const window = candidates.slice(-6);
  return {
    value: averageValues(window.map((r) => r.metrics[key].value!)),
    count: window.length,
    months: window.map((r) => r.month),
    reason:
      window.length < 6 ? `Only ${window.length}/6 valid observations` : null,
  };
}
export function enrichHistory(
  row: RolloverRow,
  history: RolloverRow[],
): RolloverViewRow {
  const average = historicalAverage(history, row, "rolloverPct");
  return {
    ...row,
    average,
    basisAverage: historicalAverage(history, row, "basisPct"),
    spreadAverage: historicalAverage(history, row, "spreadPct"),
    priorBenchmark: historicalAverage(history, row, "rolloverPct", true),
    deltaPp: metric(
      row.metrics.rolloverPct.value !== null && average.value !== null
        ? new D(row.metrics.rolloverPct.value).minus(average.value).toNumber()
        : null,
      "Current rollover or historical average unavailable",
    ),
  };
}
export function aggregateRollovers(rows: RolloverRow[]): RolloverAggregate {
  const eligible = rows.filter(
    (r) => r.status === "COMPLETE" && r.metrics.rolloverPct.value !== null,
  );
  if (
    new Set(
      eligible.map((r) =>
        JSON.stringify([r.month, r.snapshotDate, r.policy, r.evidence]),
      ),
    ).size > 1
  )
    throw new Error(
      "Cannot aggregate mixed snapshot dates, policies or source modes",
    );
  const units = new Set(eligible.map((r) => r.contracts[0].oiUnit));
  const mixed = units.size > 1;
  const sum = (key: MetricKey) =>
    eligible.reduce((a, r) => a.plus(r.metrics[key].value!), new D(0));
  const total = sum("totalOi");
  return {
    eligible: eligible.length,
    total: rows.length,
    equalWeight: averageValues(
      eligible.map((r) => r.metrics.rolloverPct.value!),
    ),
    oiWeighted:
      !mixed && total.gt(0)
        ? sum("nextOi").plus(sum("farOi")).div(total).times(100).toNumber()
        : null,
    averageSpread: averageValues(
      eligible.map((r) => r.metrics.spreadPct.value!).filter((v) => v !== null),
    ),
    unit: mixed ? null : (eligible[0]?.contracts[0].oiUnit ?? null),
  };
}
/** Spreadsheet-safe export: formula-like user text is escaped before CSV quoting. */
export function rolloverCsv(rows: RolloverViewRow[]): string {
  const keys: MetricKey[] = [
    "spot",
    "momPct",
    "nearClose",
    "nextClose",
    "basisInr",
    "basisPct",
    "nearOi",
    "nextOi",
    "farOi",
    "totalOi",
    "rolloverPct",
    "spreadPct",
  ];
  const quote = (v: unknown) => {
    let text = v === null || v === undefined ? "" : String(v);
    if (typeof v === "string" && /^[\s]*[=+@\-]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  const data: unknown[][] = [
    [
      "Sector",
      "Symbol",
      "Month",
      "Snapshot date",
      "Actual expiry",
      "Evidence",
      ...keys,
      "6M average rollover %",
      "History count",
      "Delta (pp)",
      "6M average basis %",
      "6M average spread %",
      "Quality",
      "Issues",
    ],
    ...rows.map((r) => [
      r.sector,
      r.symbol,
      r.month,
      r.snapshotDate,
      r.actualExpiry,
      r.evidence,
      ...keys.map((k) => r.metrics[k].value),
      r.average.value,
      r.average.count,
      r.deltaPp.value,
      r.basisAverage.value,
      r.spreadAverage.value,
      r.status,
      r.issues.join("; "),
    ]),
  ];
  return data.map((row) => row.map(quote).join(",")).join("\r\n");
}
