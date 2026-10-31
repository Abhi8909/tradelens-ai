import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateRollovers,
  averageValues,
  calculateRollover,
  enrichHistory,
  historicalAverage,
  monthOffset,
  percentageChange,
  rolloverCsv,
  snapshotBeforeExpiry,
} from "../src/rollovers.ts";
import { ROLLOVER_POLICY, type RolloverInput } from "../src/rolloverTypes.ts";
function input(): RolloverInput {
  const date = "2026-01-26";
  return {
    symbol: "SYNTHETIC",
    sector: "Synthetic sector",
    calendar: {
      month: "2026-01",
      actualExpiry: "2026-01-27",
      tradingDates: ["2026-01-22", "2026-01-23", date, "2026-01-27"],
      evidence: "DEMO",
      reference: "Synthetic test calendar",
    },
    contracts: [
      {
        symbol: "SYNTHETIC",
        tradeDate: date,
        expiry: "2026-01-27",
        instrument: "STF",
        close: 1000,
        oi: 150000,
        oiUnit: "SHARES",
      },
      {
        symbol: "SYNTHETIC",
        tradeDate: date,
        expiry: "2026-02-24",
        instrument: "STF",
        close: 1008,
        oi: 800000,
        oiUnit: "SHARES",
      },
      {
        symbol: "SYNTHETIC",
        tradeDate: date,
        expiry: "2026-03-31",
        instrument: "STF",
        close: 1010,
        oi: 50000,
        oiUnit: "SHARES",
      },
    ],
    cash: { symbol: "SYNTHETIC", tradeDate: date, series: "EQ", close: 995 },
    farConfirmedAbsent: false,
    sources: (["FO", "CM"] as const).map((segment) => ({
      id: segment,
      segment,
      reportDate: date,
      receivedAt: date + "T20:00:00+05:30",
      evidence: "DEMO",
      reference: "Synthetic test",
      schemaVersion: "test-v1",
      sha256: null,
    })),
  };
}
const near = (a: number | null, b: number) =>
  assert.ok(a !== null && Math.abs(a - b) < 1e-9, String(a) + " ≠ " + b);
test("rollover acceptance fixture separates rollover, basis and true roll spread without intermediate rounding", () => {
  const row = calculateRollover(input());
  assert.equal(row.status, "COMPLETE");
  assert.equal(row.evidence, "DEMO");
  assert.equal(row.metrics.totalOi.value, 1000000);
  assert.equal(row.metrics.rolloverPct.value, 85);
  assert.equal(row.metrics.basisInr.value, 5);
  near(row.metrics.basisPct.value, 0.5025125628140703);
  assert.equal(row.metrics.spreadInr.value, 8);
  assert.equal(row.metrics.spreadPct.value, 0.8);
  assert.equal(averageValues([77, 80, 82, 83, 84, 86]), 82);
  assert.equal(85 - averageValues([77, 80, 82, 83, 84, 86])!, 3);
});
test("expiry ordering is chronological and does not depend on report row ordering", () => {
  const original = input();
  original.contracts.reverse();
  assert.deepEqual(
    calculateRollover(original).metrics,
    calculateRollover(input()).metrics,
  );
});
test("snapshot resolver respects supplied holidays and shifted actual expiry rather than weekday heuristics", () => {
  assert.equal(
    snapshotBeforeExpiry({
      month: "2026-01",
      actualExpiry: "2026-01-26",
      tradingDates: ["2026-01-22", "2026-01-23", "2026-01-26"],
      evidence: "DEMO",
      reference: "Synthetic shifted expiry",
    }),
    "2026-01-23",
  );
  assert.throws(() =>
    snapshotBeforeExpiry({ ...input().calendar, tradingDates: ["2026-01-26"] }),
  );
  assert.throws(() =>
    snapshotBeforeExpiry({ ...input().calendar, tradingDates: ["2026-01-27"] }),
  );
  assert.throws(() =>
    snapshotBeforeExpiry({ ...input().calendar, actualExpiry: "2026-02-30" }),
  );
});
test("far absence is zero only when explicitly confirmed; incomplete file is never treated as zero", () => {
  const data = input();
  data.contracts.pop();
  let row = calculateRollover(data);
  assert.equal(row.metrics.rolloverPct.value, null);
  assert.equal(row.status, "INCOMPLETE");
  data.farConfirmedAbsent = true;
  row = calculateRollover(data);
  assert.equal(row.metrics.farOi.value, 0);
  near(row.metrics.rolloverPct.value, (100 * 800000) / 950000);
});
test("zero or invalid open interest produces null rollover with diagnostic reasons", () => {
  for (const invalid of [
    -1,
    NaN,
    Infinity,
    null,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const data = input();
    data.contracts[1].oi = invalid;
    const row = calculateRollover(data);
    assert.equal(row.metrics.rolloverPct.value, null);
    assert.equal(row.status, "INCOMPLETE");
    assert.ok(row.metrics.nextOi.reason);
  }
  const data = input();
  data.contracts.forEach((c) => (c.oi = 0));
  const row = calculateRollover(data);
  assert.equal(row.metrics.totalOi.value, 0);
  assert.equal(row.metrics.rolloverPct.value, null);
  assert.match(row.metrics.rolloverPct.reason!, /zero/);
});
test("duplicate contracts, mixed OI units and incorrect actual near expiry fail closed", () => {
  const duplicate = input();
  duplicate.contracts.push({ ...duplicate.contracts[0] });
  assert.equal(calculateRollover(duplicate).metrics.rolloverPct.value, null);
  const units = input();
  units.contracts[1].oiUnit = "CONTRACTS";
  assert.equal(calculateRollover(units).metrics.rolloverPct.value, null);
  const expiry = input();
  expiry.contracts[0].expiry = "2026-01-28";
  assert.equal(calculateRollover(expiry).metrics.rolloverPct.value, null);
});
test("stock symbols, report dates and exact FO contract dates must match", () => {
  const symbol = input();
  symbol.contracts[0].symbol = "OTHER";
  assert.equal(calculateRollover(symbol).metrics.rolloverPct.value, null);
  const date = input();
  date.contracts[0].tradeDate = "2026-01-23";
  assert.equal(calculateRollover(date).metrics.rolloverPct.value, null);
  const source = input();
  source.sources[0].reportDate = "2026-01-23";
  assert.equal(calculateRollover(source).metrics.rolloverPct.value, null);
});
test("cash date and EQ series mismatches never yield fabricated futures-spot basis", () => {
  for (const mode of ["date", "series", "symbol", "missing"]) {
    const data = input();
    if (mode === "date") data.cash!.tradeDate = "2026-01-23";
    if (mode === "series") data.cash!.series = "BE";
    if (mode === "symbol") data.cash!.symbol = "OTHER";
    if (mode === "missing") data.cash = null;
    const row = calculateRollover(data);
    assert.equal(row.metrics.basisPct.value, null);
    assert.equal(row.metrics.spot.value, null);
    assert.equal(row.metrics.rolloverPct.value, 85);
    assert.equal(row.status, "INCOMPLETE");
  }
});
test("nonpositive price never becomes a valid basis or spread denominator", () => {
  for (const value of [0, -1, NaN, Infinity, null]) {
    const data = input();
    data.contracts[0].close = value;
    const row = calculateRollover(data);
    assert.equal(row.metrics.basisPct.value, null);
    assert.equal(row.metrics.spreadPct.value, null);
  }
  assert.equal(percentageChange(100, 0).value, null);
});
test("options/index futures do not enter stock futures calculations and mapping ambiguity stays visible", () => {
  const data = input();
  data.contracts.push({
    ...data.contracts[1],
    instrument: "IDO",
    oi: 999999999,
  });
  const row = calculateRollover(data);
  assert.equal(row.metrics.rolloverPct.value, 85);
  assert.equal(row.status, "INCOMPLETE");
  assert.match(row.issues.join(" "), /excluded/);
});
test("MoM comparison requires the previous calendar month and identical snapshot policy", () => {
  const data = input();
  data.previousSpot = { month: "2025-12", value: 900, policy: ROLLOVER_POLICY };
  near(calculateRollover(data).metrics.momPct.value, (100 * 95) / 900);
  data.previousSpot.month = "2025-11";
  assert.equal(calculateRollover(data).metrics.momPct.value, null);
  data.previousSpot.month = "2025-12";
  data.previousSpot.policy = "EXPIRY_DAY";
  assert.equal(calculateRollover(data).metrics.momPct.value, null);
});
test("six-month history crosses years, excludes future months, discloses gaps and separates prior benchmark", () => {
  const base = calculateRollover(input());
  const history = [77, 80, 82, 83, 84, 86, 85].map((value, i) => ({
    ...structuredClone(base),
    month: monthOffset("2025-07", i),
    metrics: {
      ...structuredClone(base.metrics),
      rolloverPct: { value, reason: null },
    },
  }));
  const selected = history.at(-1)!;
  const result = enrichHistory(selected, history);
  near(result.average.value, (80 + 82 + 83 + 84 + 86 + 85) / 6);
  assert.equal(result.priorBenchmark.value, 82);
  assert.equal(result.average.months[0], "2025-08");
  assert.equal(result.average.months.at(-1), "2026-01");
  const earlier = enrichHistory(history[2], history);
  assert.equal(earlier.average.count, 3);
  assert.ok(earlier.average.reason);
  history[3].status = "INCOMPLETE";
  assert.equal(historicalAverage(history, selected, "rolloverPct").count, 6);
  assert.equal(monthOffset("2026-01", -1), "2025-12");
  assert.throws(() => monthOffset("2026-13", 0));
});
test("history never blends methodologies or DEMO values with verified observations", () => {
  const row = calculateRollover(input());
  const alternate = {
    ...structuredClone(row),
    month: "2025-12",
    evidence: "VERIFIED" as const,
  };
  assert.equal(
    historicalAverage([row, alternate], row, "rolloverPct").count,
    1,
  );
});
test("equal-weight and OI-weighted rollovers differ correctly and report coverage", () => {
  const a = calculateRollover(input());
  const b = structuredClone(a);
  b.symbol = "SECOND";
  b.metrics.nearOi.value = 0;
  b.metrics.nextOi.value = 100000;
  b.metrics.farOi.value = 0;
  b.metrics.totalOi.value = 100000;
  b.metrics.rolloverPct.value = 100;
  const incomplete = {
    ...structuredClone(a),
    symbol: "MISSING",
    status: "INCOMPLETE" as const,
  };
  const summary = aggregateRollovers([a, b, incomplete]);
  assert.equal(summary.eligible, 2);
  assert.equal(summary.total, 3);
  assert.equal(summary.equalWeight, 92.5);
  near(summary.oiWeighted, (100 * 950000) / 1100000);
  assert.equal(aggregateRollovers([]).equalWeight, null);
  b.contracts[0].oiUnit = "CONTRACTS";
  assert.equal(aggregateRollovers([a, b]).oiWeighted, null);
});
test("CSV exports provenance, missing cells, and escapes spreadsheet formulas", () => {
  const row = calculateRollover(input());
  row.symbol = '=HYPERLINK("malicious")';
  row.sector = "+FORMULA";
  row.metrics.spot = { value: null, reason: "Missing cash" };
  const text = rolloverCsv([enrichHistory(row, [row])]);
  assert.ok(text.includes("DEMO"));
  assert.ok(text.includes("'+FORMULA"));
  assert.ok(text.includes("'=HYPERLINK"));
  assert.ok(!text.includes("NaN"));
  assert.ok(text.includes("Snapshot date"));
});
test("source timestamps require an explicit timezone and cannot precede their report date", () => {
  const data = input();
  data.sources[0].receivedAt = "2026-01-26T20:00:00";
  assert.equal(calculateRollover(data).metrics.rolloverPct.value, null);
  data.sources[0].receivedAt = "2026-01-26T20:00:00+05:30";
  assert.equal(calculateRollover(data).metrics.rolloverPct.value, 85);
  data.sources[1].receivedAt = "2026-01-25T18:29:59Z";
  assert.equal(calculateRollover(data).metrics.basisPct.value, null);
  data.sources[1].receivedAt = "2026-01-25T18:30:00Z";
  near(calculateRollover(data).metrics.basisPct.value, 0.5025125628140703);
});
test("aggregate rejects mixed snapshot cohorts and unsafe totals never lose precision silently", () => {
  const row = calculateRollover(input());
  const other = structuredClone(row);
  other.month = "2025-12";
  assert.throws(() => aggregateRollovers([row, other]));
  const huge = input();
  huge.contracts.forEach((c) => (c.oi = Number.MAX_SAFE_INTEGER));
  assert.equal(calculateRollover(huge).metrics.rolloverPct.value, null);
});
