import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../src/app.ts";
import { FixtureBhavcopyProvider } from "./fixtures/rolloverFixture.ts";
async function api(run: (base: string) => Promise<void>) {
  const server = createApp(undefined, {
    rolloverProvider: new FixtureBhavcopyProvider(),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run("http://127.0.0.1:" + address.port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
test("rollover fixture provider is deterministic and never masquerades as verified NSE data", () => {
  const a = new FixtureBhavcopyProvider().load();
  assert.deepEqual(a, new FixtureBhavcopyProvider().load());
  assert.equal(a.evidence, "DEMO");
  assert.equal(a.months.length, 13);
  assert.ok(a.rows.every((r) => r.evidence === "DEMO"));
  assert.equal(a.months.find((m) => m.month === "2026-03")?.status, "MISSING");
  assert.equal(a.months.at(-1)?.lastSync, null);
});
test("monthly API defaults to latest complete month and exposes pending/missing reports without stale substitution", async () =>
  api(async (base) => {
    const meta = await (await fetch(base + "/api/rollovers/months")).json();
    assert.equal(meta.evidence, "DEMO");
    assert.equal(meta.latestComplete, "2026-09");
    assert.equal(meta.capabilities.scheduler, false);
    assert.equal(meta.capabilities.verifiedNseData, false);
    const latest = await (await fetch(base + "/api/rollovers")).json();
    assert.equal(latest.selected.month, "2026-09");
    assert.equal(latest.window.length, 6);
    assert.equal(latest.rows.length, 6);
    assert.equal(latest.summary.eligible, 6);
    const pending = await (
      await fetch(base + "/api/rollovers?month=2026-11")
    ).json();
    assert.equal(pending.rows.length, 0);
    assert.equal(pending.summary.equalWeight, null);
    assert.equal(pending.selected.status, "MISSING");
    const older = await (
      await fetch(base + "/api/rollovers?month=2026-01")
    ).json();
    assert.deepEqual(older.window, [
      "2025-08",
      "2025-09",
      "2025-10",
      "2025-11",
      "2025-12",
      "2026-01",
    ]);
    assert.ok(
      older.rows.every(
        (r: { average: { count: number } }) => r.average.count === 3,
      ),
    );
  }));
test("filters, sorting and pagination do not change full-universe KPIs", async () =>
  api(async (base) => {
    const all = await (
      await fetch(base + "/api/rollovers?month=2026-10")
    ).json();
    assert.equal(all.summary.eligible, 5);
    const filtered = await (
      await fetch(
        base +
          "/api/rollovers?month=2026-10&q=ALPHA&sort=rolloverPct&direction=desc",
      )
    ).json();
    assert.equal(filtered.total, 1);
    assert.deepEqual(filtered.summary, all.summary);
    const missing = await (
      await fetch(base + "/api/rollovers?month=2026-10&missing=only")
    ).json();
    assert.equal(missing.rows.length, 1);
    assert.equal(missing.rows[0].metrics.rolloverPct.value, null);
    assert.ok(missing.rows[0].issues.length);
    const sorted = await (
      await fetch(
        base + "/api/rollovers?month=2026-10&sort=rolloverPct&direction=desc",
      )
    ).json();
    assert.equal(sorted.rows.at(-1).symbol, "DEMO-ZETA");
    const negative = await (
      await fetch(base + "/api/rollovers?month=2026-09&spread=negative")
    ).json();
    assert.ok(
      negative.rows.every(
        (r: { metrics: { spreadPct: { value: number } } }) =>
          r.metrics.spreadPct.value < 0,
      ),
    );
    const second = await (
      await fetch(base + "/api/rollovers?month=2026-09&page=2")
    ).json();
    assert.equal(second.rows.length, 0);
    assert.equal(second.total, 6);
  }));
test("history, matrix and sector APIs preserve gaps, coverage and exact source dates", async () =>
  api(async (base) => {
    const history = await (
      await fetch(base + "/api/rollovers/DEMO-ALPHA/history?month=2026-06")
    ).json();
    assert.equal(history.history.length, 6);
    assert.equal(
      history.history.find((r: { month: string }) => r.month === "2026-03").row,
      null,
    );
    const rows = await (
      await fetch(base + "/api/rollovers?month=2026-06")
    ).json();
    assert.equal(
      rows.matrix[0].values.find(
        (v: { month: string }) => v.month === "2026-03",
      ).rollover.value,
      null,
    );
    const sectors = await (
      await fetch(base + "/api/rollovers/sectors?month=2026-10")
    ).json();
    assert.equal(
      sectors.sectors.find((s: { sector: string }) => s.sector === "Financials")
        .eligible,
      1,
    );
    const selected = rows.rows[0];
    assert.equal(selected.snapshotDate, selected.sources[0].reportDate);
    assert.ok(
      selected.contracts.every(
        (c: { tradeDate: string }) => c.tradeDate === selected.snapshotDate,
      ),
    );
    assert.equal(selected.sources[0].sha256.length, 64);
  }));
test("CSV export is downloadable, reproducible and explicitly labels synthetic values", async () =>
  api(async (base) => {
    const url = base + "/api/rollovers/export?month=2026-09&q=ALPHA";
    const response = await fetch(url);
    assert.match(response.headers.get("content-type")!, /text\/csv/);
    assert.match(response.headers.get("content-disposition")!, /DEMO-2026-09/);
    const csv = await response.text();
    assert.equal(csv, await (await fetch(url)).text());
    assert.ok(csv.includes("DEMO-ALPHA"));
    assert.ok(csv.includes("Delta (pp)"));
    assert.ok(!csv.includes("DEMO-BETA"));
  }));
test("invalid queries and unsupported mutations fail explicitly", async () =>
  api(async (base) => {
    for (const suffix of [
      "?month=2026-13",
      "?min=-1",
      "?min=90&max=20",
      "?page=1.5",
      "?sort=arbitrary",
      "?spread=bad",
      "?missing=bad",
    ])
      assert.equal(
        (await fetch(base + "/api/rollovers" + suffix)).status,
        400,
        suffix,
      );
    assert.equal(
      (await fetch(base + "/api/rollovers/UNKNOWN/history")).status,
      404,
    );
    assert.equal(
      (await fetch(base + "/api/rollovers", { method: "POST" })).status,
      405,
    );
  }));
