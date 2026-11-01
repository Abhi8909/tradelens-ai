import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import {
  calculateRollover,
  monthOffset,
  snapshotBeforeExpiry,
  percentageChange,
} from "../../../../packages/core/src/rollovers.ts";
import type {
  RolloverDataset,
  RolloverRow,
} from "../../../../packages/core/src/rolloverTypes.ts";
import type { SqlDatabase } from "../mtf/database.ts";
import type { BhavcopyProvider } from "./provider.ts";
import {
  CALENDAR_REFERENCE,
  completedMonths,
  emptyNseDataset,
  officialCalendar,
} from "./calendar.ts";
import { archiveName, parseUdiffZip, type ParsedReport } from "./udiff.ts";
import { downloadSectors, UNCLASSIFIED, type SectorMap } from "./sectors.ts";
export type SyncStatus = {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  currentMonth: string | null;
  completed: number;
  total: number;
  errors: { month: string; message: string }[];
};
type SavedMonth = {
  month: string;
  status: string;
  payload: string;
  updated: string;
};
export class NseBhavcopyProvider implements BhavcopyProvider {
  readonly kind = "verified" as const;
  readonly sql?: SqlDatabase;
  readonly fetcher: typeof fetch;
  readonly now: () => Date;
  readonly intervalMs: number;
  private dataset: RolloverDataset;
  sectors: SectorMap | null = null;
  private pending: Promise<void> | null = null;
  private lastStart = 0;
  status: SyncStatus = {
    running: false,
    startedAt: null,
    finishedAt: null,
    currentMonth: null,
    completed: 0,
    total: 0,
    errors: [],
  };
  constructor(
    options: {
      sql?: SqlDatabase;
      fetcher?: typeof fetch;
      now?: () => Date;
      intervalMs?: number;
    } = {},
  ) {
    this.sql = options.sql;
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.intervalMs = options.intervalMs ?? 1200;
    this.dataset = emptyNseDataset(this.now());
  }
  load() {
    return structuredClone(this.dataset);
  }
  async initialize() {
    if (!this.sql) return;
    await this.sql.transaction(async (tx) => {
      if (tx.dialect === "postgres")
        await tx.query("SELECT pg_advisory_xact_lock(84732102)");
      await tx.query(
        "CREATE TABLE IF NOT EXISTS rollover_reports (id TEXT PRIMARY KEY, segment TEXT NOT NULL, report_date TEXT NOT NULL, payload TEXT NOT NULL, imported TEXT NOT NULL)",
      );
      await tx.query(
        "CREATE INDEX IF NOT EXISTS rollover_report_dates ON rollover_reports(segment,report_date)",
      );
      await tx.query(
        "CREATE TABLE IF NOT EXISTS rollover_months (month TEXT PRIMARY KEY, status TEXT NOT NULL, payload TEXT NOT NULL, updated TEXT NOT NULL)",
      );
      await tx.query(
        "CREATE TABLE IF NOT EXISTS rollover_syncs (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated TEXT NOT NULL)",
      );
      await tx.query(
        "CREATE TABLE IF NOT EXISTS rollover_sectors (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated TEXT NOT NULL)",
      );
    });
    const [sectors] = await this.sql.query<{ payload: string }>(
      "SELECT payload FROM rollover_sectors ORDER BY updated DESC LIMIT 1",
    );
    if (sectors) this.sectors = JSON.parse(sectors.payload);
    const saved = await this.sql.query<SavedMonth>(
      "SELECT * FROM rollover_months ORDER BY month",
    );
    this.restore(saved.map((row) => JSON.parse(row.payload)));
    const [last] = await this.sql.query<{ payload: string }>(
      "SELECT payload FROM rollover_syncs ORDER BY updated DESC LIMIT 1",
    );
    if (last) {
      this.status = JSON.parse(last.payload);
      if (this.status.running) {
        this.status.running = false;
        this.status.errors.push({
          month: this.status.currentMonth ?? "",
          message: "Previous sync interrupted; retry required",
        });
      }
    }
  }
  private restore(
    saved: { meta: RolloverDataset["months"][number]; rows: RolloverRow[] }[],
  ) {
    const map = new Map(
      emptyNseDataset(this.now()).months.map((m) => [
        m.month,
        { meta: m, rows: [] as RolloverRow[] },
      ]),
    );
    for (const month of saved) map.set(month.meta.month, month);
    const values = [...map.values()].sort((a, b) =>
      a.meta.month.localeCompare(b.meta.month),
    );
    const allRows = values.flatMap((v) => v.rows);
    for (const row of allRows) {
      // Current classification applied to every month so sector history stays comparable.
      row.sector = this.sectors?.sectors[row.symbol] ?? UNCLASSIFIED;
      const prior = allRows.find(
        (p) =>
          p.symbol === row.symbol && p.month === monthOffset(row.month, -1),
      );
      row.metrics.momPct = prior
        ? percentageChange(row.metrics.spot.value, prior.metrics.spot.value)
        : {
            value: null,
            reason: "Previous comparable calendar month unavailable",
          };
    }
    this.dataset = {
      evidence: values.some((m) => m.rows.length) ? "VERIFIED" : "UNVERIFIED",
      calendarReference: CALENDAR_REFERENCE,
      months: values.map((v) => v.meta),
      rows: values.flatMap((v) => v.rows),
    };
  }
  private reapply() {
    this.restore(
      this.dataset.months.map((meta) => ({
        meta,
        rows: this.dataset.rows.filter((r) => r.month === meta.month),
      })),
    );
  }
  /** Sector failures are reported but never block price/OI imports. */
  private async refreshSectors(force: boolean) {
    const age = this.sectors
      ? this.now().getTime() - Date.parse(this.sectors.fetchedAt)
      : Infinity;
    if (!force && age < 7 * 24 * 60 * 60 * 1000) return;
    try {
      const sectors = await downloadSectors(
        this.fetcher,
        this.now().toISOString(),
      );
      await this.sql?.query(
        "INSERT INTO rollover_sectors VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated=excluded.updated",
        [sectors.sha256, JSON.stringify(sectors), sectors.fetchedAt],
      );
      this.sectors = sectors;
      this.reapply();
    } catch (error) {
      this.status.errors.push({
        month: "sectors",
        message:
          (error instanceof Error ? error.message : "NSE sector list failed") +
          (this.sectors ? "; keeping previous classification" : ""),
      });
    }
  }
  private async download(
    segment: "FO" | "CM",
    date: string,
  ): Promise<ParsedReport> {
    const name = archiveName(segment, date);
    const url =
      "https://archives.nseindia.com/content/" +
      segment.toLowerCase() +
      "/" +
      name;
    let last = "NSE report unavailable";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.fetcher(url, {
          redirect: "error",
          signal: AbortSignal.timeout(20000),
          headers: { Accept: "application/zip" },
        });
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 403 || response.status === 401)
            throw new Error("NSE denied archive access; no bypass attempted");
          if (response.status === 404)
            throw new Error("NSE final report not published at " + url);
          if (response.status === 429 || response.status >= 500) {
            if (!attempt) {
              await delay(1500);
              continue;
            }
          }
          throw new Error("NSE archive HTTP " + response.status);
        }
        if (!response.body) throw new Error("Empty NSE response");
        const reader = response.body.getReader();
        let size = 0;
        const parts: Uint8Array[] = [];
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 12 * 1024 * 1024)
              throw new Error("NSE archive exceeds 12 MiB");
            parts.push(value);
          }
        } finally {
          await reader.cancel();
        }
        const report = await parseUdiffZip(
          Buffer.concat(parts),
          name,
          segment,
          date,
          url,
          true,
          this.now().toISOString(),
        );
        return report;
      } catch (error) {
        last = error instanceof Error ? error.message : "NSE connection failed";
        if (
          /denied|not published|schema|ZIP|mismatch|Unknown|Duplicate|eligible|exceeds/.test(
            last,
          ) ||
          attempt
        )
          throw new Error(last);
        await delay(1500);
      }
    }
    throw new Error(last);
  }
  /** One job at a time; seven snapshots provide the first visible month's MoM and prior-six benchmark. */
  sync(force = false): Promise<void> {
    if (this.pending) return this.pending;
    if (!force && Date.now() - this.lastStart < 60000) return Promise.resolve();
    this.lastStart = Date.now();
    this.pending = this.run(force)
      .catch((error) => {
        this.status.running = false;
        this.status.currentMonth = null;
        this.status.finishedAt = this.now().toISOString();
        this.status.errors.push({
          month: "",
          message:
            "Rollover persistence failed; retry after checking database availability",
        });
        throw error;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
  private async run(force = false) {
    let months: string[];
    try {
      months = completedMonths(this.now(), 7);
    } catch (error) {
      this.status.errors = [{ month: "", message: (error as Error).message }];
      return;
    }
    this.status = {
      running: true,
      startedAt: this.now().toISOString(),
      finishedAt: null,
      currentMonth: null,
      completed: 0,
      total: months.length,
      errors: [],
    };
    const id = createHash("sha256")
      .update(this.status.startedAt!)
      .digest("hex");
    await this.sql?.query(
      "INSERT INTO rollover_syncs VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated=excluded.updated",
      [id, JSON.stringify(this.status), this.now().toISOString()],
    );
    await this.refreshSectors(force);
    for (const month of months) {
      this.status.currentMonth = month;
      try {
        const calendar = officialCalendar(month);
        const date = snapshotBeforeExpiry(calendar);
        const priorMeta = this.dataset.months.find((m) => m.month === month);
        // Final reports are immutable; flagged scrips do not justify re-downloading.
        if (!force && priorMeta?.lastSync) {
          this.status.completed++;
          continue;
        }
        const fo = await this.download("FO", date);
        await delay(this.intervalMs);
        const cm = await this.download("CM", date);
        await delay(this.intervalMs);
        const symbols = [...new Set(fo.contracts.map((c) => c.symbol))].sort();
        const cash = new Map(cm.cash.map((c) => [c.symbol, c]));
        const rows = symbols.map((symbol) => {
          const prior = this.dataset.rows.find(
            (r) => r.symbol === symbol && r.month === monthOffset(month, -1),
          );
          const input = {
            symbol,
            sector: UNCLASSIFIED,
            calendar,
            contracts: fo.contracts.filter((c) => c.symbol === symbol),
            cash: cash.get(symbol) ?? null,
            farConfirmedAbsent: false,
            sources: [fo.source, cm.source],
            previousSpot: prior
              ? {
                  month: prior.month,
                  value: prior.metrics.spot.value,
                  policy: prior.policy,
                }
              : undefined,
          };
          return calculateRollover(input);
        });
        const meta: RolloverDataset["months"][number] = {
          month,
          actualExpiry: calendar.actualExpiry,
          snapshotDate: date,
          status: rows.every((r) => r.status === "COMPLETE")
            ? "COMPLETE"
            : "INCOMPLETE",
          evidence: "VERIFIED",
          lastSync: this.now().toISOString(),
          // One line per flagged scrip; derived metric echoes add no information.
          issues: rows
            .filter((r) => r.status === "INCOMPLETE")
            .map(
              (r) =>
                r.symbol +
                " — " +
                (r.issues
                  .filter((i) => !i.endsWith(": Missing or invalid source inputs"))
                  .join("; ") || r.issues.join("; ")),
            ),
        };
        if (this.sql)
          await this.sql.transaction(async (tx) => {
            for (const report of [fo, cm])
              await tx.query(
                "INSERT INTO rollover_reports VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING",
                [
                  report.source.id,
                  report.segment,
                  report.date,
                  JSON.stringify(report),
                  this.now().toISOString(),
                ],
              );
            await tx.query(
              "INSERT INTO rollover_months VALUES($1,$2,$3,$4) ON CONFLICT(month) DO UPDATE SET status=excluded.status,payload=excluded.payload,updated=excluded.updated",
              [
                month,
                meta.status,
                JSON.stringify({ meta, rows }),
                this.now().toISOString(),
              ],
            );
          });
        const existing = this.dataset.months
          .filter((m) => m.month !== month)
          .map((meta) => ({
            meta,
            rows: this.dataset.rows.filter((r) => r.month === meta.month),
          }));
        this.restore([...existing, { meta, rows }]);
        this.status.completed++;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "NSE import failed";
        this.status.errors.push({ month, message });
        const meta = this.dataset.months.find((m) => m.month === month);
        if (meta && !meta.lastSync) meta.issues = [message];
      }
      await this.sql?.query(
        "INSERT INTO rollover_syncs VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated=excluded.updated",
        [id, JSON.stringify(this.status), this.now().toISOString()],
      );
    }
    this.status.running = false;
    this.status.currentMonth = null;
    this.status.finishedAt = this.now().toISOString();
    await this.sql?.query(
      "INSERT INTO rollover_syncs VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated=excluded.updated",
      [id, JSON.stringify(this.status), this.now().toISOString()],
    );
  }
}
