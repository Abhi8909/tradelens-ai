import { createHash } from "node:crypto";
import {
  calculateRollover,
  monthOffset,
  snapshotBeforeExpiry,
} from "../../../../packages/core/src/rollovers.ts";
import type {
  ExpiryCalendar,
  RolloverDataset,
  RolloverInput,
  RolloverSource,
} from "../../../../packages/core/src/rolloverTypes.ts";
import type { BhavcopyProvider } from "../../src/rollovers/provider.ts";
const expiries = [
  "2025-11-25",
  "2025-12-30",
  "2026-01-27",
  "2026-02-24",
  "2026-03-31",
  "2026-04-28",
  "2026-05-26",
  "2026-06-30",
  "2026-07-28",
  "2026-08-25",
  "2026-09-29",
  "2026-10-27",
  "2026-11-24",
  "2026-12-29",
];
const stocks = [
  ["DEMO-ALPHA", "Industrials"],
  ["DEMO-BETA", "Technology"],
  ["DEMO-GAMMA", "Financials"],
  ["DEMO-DELTA", "Industrials"],
  ["DEMO-EPSILON", "Technology"],
  ["DEMO-ZETA", "Financials"],
];
/** Invented calendar and inputs exclusively for development, never an NSE report/calendar. */
export class FixtureBhavcopyProvider implements BhavcopyProvider {
  readonly kind = "fixture" as const;
  load(): RolloverDataset {
    const rows: RolloverDataset["rows"] = [];
    const months: RolloverDataset["months"] = [];
    for (let index = 0; index < 12; index++) {
      const month = expiries[index].slice(0, 7);
      const actualExpiry = expiries[index];
      const tradingDates = Array.from(
        { length: 12 },
        (_, i) =>
          new Date(
            Date.parse(`${actualExpiry}T00:00:00Z`) - (11 - i) * 86400000,
          ),
      )
        .filter((d) => ![0, 6].includes(d.getUTCDay()))
        .map((d) => d.toISOString().slice(0, 10));
      const calendar: ExpiryCalendar = {
        month,
        actualExpiry,
        tradingDates,
        evidence: "DEMO",
        reference: "Synthetic calendar v1; no official holiday verification",
      };
      const snapshotDate = snapshotBeforeExpiry(calendar);
      if (index === 4) {
        months.push({
          month,
          snapshotDate,
          actualExpiry,
          status: "MISSING",
          evidence: "DEMO",
          lastSync: null,
          issues: ["Synthetic missing FO and CM reports"],
        });
        continue;
      }
      for (let stock = 0; stock < stocks.length; stock++) {
        const [symbol, sector] = stocks[stock];
        const spot = 995 + stock * 120 + index * 7;
        const nextOi = 800000 + stock * 150000 + index * 9000;
        const nearOi = 150000 + stock * 80000 + (11 - index) * 6000;
        const contracts = [0, 1, 2].map((tenor) => ({
          symbol,
          tradeDate: snapshotDate,
          expiry: expiries[index + tenor],
          instrument: "STF",
          close: spot + 5 + tenor * (stock % 2 ? -4 : 8),
          oi: [nearOi, nextOi, 50000 + stock * 15000][tenor],
          oiUnit: "SHARES" as const,
        }));
        if (stock === 5 && index === 11) contracts.pop();
        const sources: RolloverSource[] = (["FO", "CM"] as const).map(
          (segment) => ({
            id: `fixture:${month}:${symbol}:${segment}`,
            segment,
            reportDate: snapshotDate,
            receivedAt: `${snapshotDate}T20:00:00+05:30`,
            evidence: "DEMO",
            reference: `Synthetic ${segment} fixture v1; not an NSE download`,
            schemaVersion: "synthetic-normalized-v1",
            sha256: createHash("sha256")
              .update(
                JSON.stringify({ month, symbol, segment, contracts, spot }),
              )
              .digest("hex"),
          }),
        );
        const prior = rows.find(
          (r) => r.symbol === symbol && r.month === monthOffset(month, -1),
        );
        const input: RolloverInput = {
          symbol,
          sector,
          calendar,
          contracts,
          cash: { symbol, tradeDate: snapshotDate, series: "EQ", close: spot },
          farConfirmedAbsent: false,
          sources,
          previousSpot: prior
            ? {
                month: prior.month,
                value: prior.metrics.spot.value,
                policy: prior.policy,
              }
            : undefined,
        };
        rows.push(calculateRollover(input));
      }
      months.push({
        month,
        snapshotDate,
        actualExpiry,
        status: rows
          .filter((r) => r.month === month)
          .every((r) => r.status === "COMPLETE")
          ? "COMPLETE"
          : "INCOMPLETE",
        evidence: "DEMO",
        lastSync: `${snapshotDate}T20:00:00+05:30`,
        issues: rows
          .filter((r) => r.month === month && r.status !== "COMPLETE")
          .flatMap((r) => r.issues),
      });
    }
    months.push({
      month: "2026-11",
      snapshotDate: "2026-11-23",
      actualExpiry: "2026-11-24",
      status: "MISSING",
      evidence: "DEMO",
      lastSync: null,
      issues: ["Synthetic pending month; final reports not available"],
    });
    return {
      evidence: "DEMO",
      calendarReference:
        "Synthetic trading sessions and expiries. Official calendar integration is not enabled.",
      rows,
      months,
    };
  }
}
