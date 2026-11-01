import type { IncomingMessage, ServerResponse } from "node:http";
import {
  aggregateRollovers,
  enrichHistory,
  monthOffset,
  rolloverCsv,
} from "../../../../packages/core/src/rollovers.ts";
import type {
  MetricKey,
  RolloverViewRow,
} from "../../../../packages/core/src/rolloverTypes.ts";
import type { BhavcopyProvider } from "./provider.ts";
import { NseBhavcopyProvider } from "./nse.ts";
const SORTS = [
  "symbol",
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
  "average",
  "basisAverage",
  "spreadAverage",
  "deltaPp",
] as const;
export function createRolloverRoutes(
  provider: BhavcopyProvider = new NseBhavcopyProvider(),
) {
  return (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): boolean => {
    if (!url.pathname.startsWith("/api/rollovers")) return false;
    const send = (status: number, body: unknown) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(body));
      return true;
    };
    if (request.method !== "GET")
      return send(405, {
        error: "Use the refresh endpoint to download official NSE reports",
      });
    try {
      const dataset = provider.load();
      const latest =
        dataset.months.filter((m) => m.status === "COMPLETE").at(-1)?.month ??
        null;
      if (url.pathname === "/api/rollovers/months")
        return send(200, {
          evidence: dataset.evidence,
          latestComplete: latest,
          latestAvailable:
            dataset.months.filter((m) => m.lastSync !== null).at(-1)?.month ??
            null,
          months: dataset.months,
          calendarReference: dataset.calendarReference,
          capabilities: {
            imports: true,
            scheduler: false,
            verifiedNseData: dataset.rows.some(
              (row) => row.evidence === "VERIFIED",
            ),
          },
        });
      const month =
        url.searchParams.get("month") ?? latest ?? dataset.months.at(-1)?.month;
      if (!month || !dataset.months.some((m) => m.month === month))
        return send(400, { error: "Select an available month" });
      monthOffset(month, 0);
      const selected = dataset.months.find((m) => m.month === month)!;
      const rows = dataset.rows
        .filter((r) => r.month === month)
        .map((r) => enrichHistory(r, dataset.rows));
      const window = Array.from({ length: 6 }, (_, i) =>
        monthOffset(month, i - 5),
      );
      const match = /^\/api\/rollovers\/([^/]+)\/history$/.exec(url.pathname);
      if (match) {
        const symbol = decodeURIComponent(match[1]);
        if (!/^[A-Z0-9&._-]{1,80}$/.test(symbol))
          throw new Error("Invalid symbol");
        if (!dataset.rows.some((r) => r.symbol === symbol))
          return send(404, { error: "Symbol not found" });
        return send(200, {
          evidence: dataset.evidence,
          symbol,
          months: window,
          history: window.map((m) => ({
            month: m,
            row:
              dataset.rows.find((r) => r.symbol === symbol && r.month === m) ??
              null,
          })),
        });
      }
      const sectors = [...new Set(rows.map((r) => r.sector))]
        .sort()
        .map((sector) => ({
          sector,
          ...aggregateRollovers(rows.filter((r) => r.sector === sector)),
        }));
      if (url.pathname === "/api/rollovers/sectors")
        return send(200, { evidence: dataset.evidence, month, sectors });
      if (url.pathname === "/api/rollovers/market-summary")
        return send(200, {
          evidence: dataset.evidence,
          month,
          summary: aggregateRollovers(rows),
        });
      if (!["/api/rollovers", "/api/rollovers/export"].includes(url.pathname))
        return send(404, { error: "Rollover endpoint not found" });
      const min = optionalNumber(url, "min", 0, 100);
      const max = optionalNumber(url, "max", 0, 100);
      if (min !== null && max !== null && min > max)
        throw new Error("Minimum rollover must not exceed maximum");
      const spread = url.searchParams.get("spread") ?? "all";
      const compare = url.searchParams.get("compare") ?? "all";
      const sort = url.searchParams.get("sort") ?? "symbol";
      const direction = url.searchParams.get("direction") ?? "asc";
      if (
        !["all", "positive", "negative"].includes(spread) ||
        !["all", "above", "below"].includes(compare) ||
        !SORTS.includes(sort as (typeof SORTS)[number]) ||
        !["asc", "desc"].includes(direction)
      )
        throw new Error("Invalid filter or sort");
      const missing = url.searchParams.get("missing") ?? "include";
      if (!["include", "only", "exclude"].includes(missing))
        throw new Error("Invalid missing-data filter");
      const q = (url.searchParams.get("q") ?? "").toUpperCase();
      if (q.length > 80) throw new Error("Search is too long");
      const sector = url.searchParams.get("sector");
      const filtered = rows.filter(
        (r) =>
          r.symbol.includes(q) &&
          (!sector || r.sector === sector) &&
          (min === null ||
            (r.metrics.rolloverPct.value !== null &&
              r.metrics.rolloverPct.value >= min)) &&
          (max === null ||
            (r.metrics.rolloverPct.value !== null &&
              r.metrics.rolloverPct.value <= max)) &&
          (spread === "all" ||
            (r.metrics.spreadPct.value !== null &&
              (spread === "positive"
                ? r.metrics.spreadPct.value > 0
                : r.metrics.spreadPct.value < 0))) &&
          (compare === "all" ||
            (r.deltaPp.value !== null &&
              (compare === "above"
                ? r.deltaPp.value > 0
                : r.deltaPp.value < 0))) &&
          (missing === "include" ||
            (missing === "only"
              ? r.status === "INCOMPLETE"
              : r.status === "COMPLETE")),
      );
      filtered.sort((a, b) => {
        const av = sortValue(a, sort),
          bv = sortValue(b, sort);
        if (av === null)
          return bv === null ? a.symbol.localeCompare(b.symbol) : 1;
        if (bv === null) return -1;
        const result =
          typeof av === "string"
            ? av.localeCompare(String(bv))
            : av - Number(bv);
        return (
          (direction === "desc" ? -result : result) ||
          a.symbol.localeCompare(b.symbol)
        );
      });
      if (url.pathname === "/api/rollovers/export") {
        response.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="rollovers-${dataset.evidence}-${month}.csv"`,
          "cache-control": "no-store",
        });
        response.end(rolloverCsv(filtered));
        return true;
      }
      const page = optionalNumber(url, "page", 1, 10000) ?? 1;
      if (!Number.isInteger(page)) throw new Error("Page must be an integer");
      return send(200, {
        evidence: dataset.evidence,
        selected,
        lastComplete: latest,
        summary: aggregateRollovers(rows),
        sectors,
        total: filtered.length,
        page,
        rows: filtered.slice((page - 1) * 25, page * 25),
        window,
        trend: window.map((m) => ({
          month: m,
          ...aggregateRollovers(dataset.rows.filter((r) => r.month === m)),
        })),
        matrix: filtered.slice((page - 1) * 25, page * 25).map((r) => ({
          symbol: r.symbol,
          average: r.average,
          values: window.map((m) => ({
            month: m,
            rollover: dataset.rows.find(
              (h) => h.symbol === r.symbol && h.month === m,
            )?.metrics.rolloverPct ?? {
              value: null,
              reason: "Monthly observation unavailable",
            },
            spread: dataset.rows.find(
              (h) => h.symbol === r.symbol && h.month === m,
            )?.metrics.spreadPct ?? {
              value: null,
              reason: "Monthly observation unavailable",
            },
          })),
        })),
      });
    } catch (error) {
      return send(400, {
        error:
          error instanceof Error ? error.message : "Invalid rollover request",
      });
    }
  };
}
function optionalNumber(
  url: URL,
  key: string,
  min: number,
  max: number,
): number | null {
  const raw = url.searchParams.get(key);
  if (raw === null || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max)
    throw new Error(`Invalid ${key}`);
  return value;
}
function sortValue(row: RolloverViewRow, key: string): number | string | null {
  return key === "symbol"
    ? row.symbol
    : key === "deltaPp"
      ? row.deltaPp.value
      : key === "average"
        ? row.average.value
        : key === "basisAverage"
          ? row.basisAverage.value
          : key === "spreadAverage"
            ? row.spreadAverage.value
            : row.metrics[key as MetricKey].value;
}
