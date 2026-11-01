import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveName,
  parseUdiffZip,
  readCsvZip,
  UDIFF_HEADERS,
} from "../src/rollovers/udiff.ts";
import {
  completedMonths,
  officialCalendar,
} from "../src/rollovers/calendar.ts";
import { NseBhavcopyProvider } from "../src/rollovers/nse.ts";
import {
  parseSectorCsv,
  SECTOR_HEADERS,
  SECTOR_URL,
} from "../src/rollovers/sectors.ts";
import { sqliteDatabase } from "../src/mtf/database.ts";
import { createApp } from "../src/app.ts";
import {
  monthOffset,
  snapshotBeforeExpiry,
} from "../../../packages/core/src/rollovers.ts";
import {
  syntheticCsv,
  syntheticRow,
  syntheticZip,
} from "./fixtures/udiffZip.ts";
const date = "2026-10-26";
const filename = archiveName("FO", date);
const member = filename.slice(0, -4);
function archive(rows: Record<string, string>[], headers = UDIFF_HEADERS) {
  return syntheticZip([{ name: member, data: syntheticCsv(rows, headers) }]);
}
test("official 2026 calendar handles holidays and last six completed month selection", () => {
  assert.equal(officialCalendar("2026-01").actualExpiry, "2026-01-27");
  assert.equal(snapshotBeforeExpiry(officialCalendar("2026-01")), "2026-01-23");
  assert.equal(officialCalendar("2026-03").actualExpiry, "2026-03-30");
  assert.equal(snapshotBeforeExpiry(officialCalendar("2026-03")), "2026-03-27");
  assert.equal(officialCalendar("2026-11").actualExpiry, "2026-11-23");
  assert.deepEqual(completedMonths(new Date("2026-11-01T12:00:00Z")), [
    "2026-05",
    "2026-06",
    "2026-07",
    "2026-08",
    "2026-09",
    "2026-10",
  ]);
  assert.throws(() => officialCalendar("2027-01"), /not configured/);
});
test("UDiFF maps actual expiry, closes and OI while excluding options and retaining source hash", async () => {
  const rows = [
    syntheticRow(date, "FO", {
      XpryDt: "2026-10-28",
      FininstrmActlXpryDt: "2026-10-27",
    }),
    syntheticRow(date, "FO", { FinInstrmTp: "STO" }),
  ];
  const bytes = archive(rows);
  const parsed = await parseUdiffZip(
    bytes,
    filename,
    "FO",
    date,
    "synthetic-upload",
  );
  assert.equal(parsed.accepted, 1);
  assert.equal(parsed.excluded, 1);
  assert.equal(parsed.contracts[0].expiry, "2026-10-27");
  assert.equal(parsed.contracts[0].originalExpiry, "2026-10-28");
  assert.equal(parsed.contracts[0].close, 1000);
  assert.equal(parsed.contracts[0].oi, 150000);
  assert.equal(parsed.source.sha256?.length, 64);
  assert.equal(parsed.source.evidence, "UNVERIFIED");
});
test("strict schema rejects renamed, duplicate and unknown fields and mismatched final archive names", async () => {
  for (const headers of [
    [...UDIFF_HEADERS, "Unknown"],
    UDIFF_HEADERS.map((h) => (h === "ClsPric" ? "SettlementPrice" : h)),
    UDIFF_HEADERS.map((h) => (h === "BizDt" ? "TradDt" : h)),
  ]) {
    await assert.rejects(
      parseUdiffZip(
        archive([syntheticRow(date, "FO")], headers),
        filename,
        "FO",
        date,
        "test",
      ),
      /schema/,
    );
  }
  await assert.rejects(
    parseUdiffZip(
      archive([syntheticRow(date, "FO")]),
      filename.replace("_F_", "_I_"),
      "FO",
      date,
      "test",
    ),
    /name/,
  );
});
test("reports reject mismatched dates, exchange, instrument codes and true duplicate identities", async () => {
  for (const extra of [
    { BizDt: "2026-10-25" },
    { TradDt: "2026-10-25" },
    { Src: "OTHER" },
    { Sgmt: "CM" },
    { FinInstrmTp: "UNKNOWN" },
  ] as Record<string, string>[]) {
    await assert.rejects(
      parseUdiffZip(
        archive([syntheticRow(date, "FO", extra)]),
        filename,
        "FO",
        date,
        "test",
      ),
    );
  }
  await assert.rejects(
    parseUdiffZip(
      archive([syntheticRow(date, "FO"), syntheticRow(date, "FO")]),
      filename,
      "FO",
      date,
      "test",
    ),
    /Duplicate/,
  );
  const adjusted = [
    syntheticRow(date, "FO", { XpryDt: "2026-11-23" }),
    syntheticRow(date, "FO", { XpryDt: "2026-12-29" }),
  ];
  assert.equal(
    (await parseUdiffZip(archive(adjusted), filename, "FO", date, "test"))
      .contracts.length,
    2,
  );
});
test("invalid amounts and units are reported without inventing zero; cash keeps EQ only", async () => {
  for (const extra of [
    { OpnIntrst: "-1" },
    { OpnIntrst: "" },
    { OpnIntrst: "123" },
    { ClsPric: "0" },
    { OptnTp: "CE" },
  ] as Record<string, string>[]) {
    const parsed = await parseUdiffZip(
      archive([syntheticRow(date, "FO", extra)]),
      filename,
      "FO",
      date,
      "test",
    );
    assert.equal(parsed.rejected.length, 1);
    assert.equal(parsed.contracts[0].oi, null);
  }
  const name = archiveName("CM", date);
  const bytes = syntheticZip([
    {
      name: name.slice(0, -4),
      data: syntheticCsv([
        syntheticRow(date, "CM"),
        syntheticRow(date, "CM", { SctySrs: "BE" }),
      ]),
    },
  ]);
  const parsed = await parseUdiffZip(bytes, name, "CM", date, "test");
  assert.equal(parsed.cash.length, 1);
  assert.equal(parsed.cash[0].close, 995);
  assert.equal(parsed.excluded, 1);
});
test("ZIP validation bounds expansion, checks CRC and rejects paths, encryption and extra members", async () => {
  const data = syntheticCsv([syntheticRow(date, "FO")]);
  for (const entries of [
    [{ name: "../" + member, data }],
    [{ name: member, data, badCrc: true }],
    [{ name: member, data, size: 50 * 1024 * 1024 }],
    [{ name: member, data, encrypted: true }],
    [
      { name: member, data },
      { name: "other.csv", data },
    ],
  ]) {
    await assert.rejects(readCsvZip(syntheticZip(entries), member));
  }
  await assert.rejects(readCsvZip(Buffer.from("not a zip"), member));
  await assert.rejects(readCsvZip(Buffer.alloc(13 * 1024 * 1024), member));
  await assert.rejects(
    parseUdiffZip(
      syntheticZip([{ name: member, data: Buffer.from([0xff, 0xfe]) }]),
      filename,
      "FO",
      date,
      "test",
    ),
  );
});
const now = () => new Date("2026-11-01T12:00:00Z");
function sectorCsv(rows = [["Synthetic Ltd.", "Capital Goods", "SYNTHETIC"]]) {
  const filler = Array.from({ length: 120 }, (_, i) => [
    "Filler " + i + ", Ltd.",
    "Services",
    "FILLER" + i,
  ]);
  return (
    SECTOR_HEADERS.join(",") +
    "\n" +
    [...rows, ...filler]
      .map(([name, industry, symbol]) =>
        ['"' + name + '"', industry, symbol, "EQ", "INE000000000"].join(","),
      )
      .join("\n") +
    "\n"
  );
}
function fakeNse(failMonth?: string, failSectors = false) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    fetcher: (async (input: string | URL | Request) => {
      const url = String(input);
      calls++;
      if (url === SECTOR_URL)
        return failSectors
          ? new Response("denied", { status: 403 })
          : new Response(sectorCsv(), {
              headers: { "content-type": "text/csv" },
            });
      const match = /_(FO|CM)_0_0_0_(\d{4})(\d{2})(\d{2})_F_0000.csv.zip$/.exec(
        url,
      );
      assert.ok(match);
      assert.ok(url.startsWith("https://archives.nseindia.com/content/"));
      const segment = match[1] as "FO" | "CM";
      const day = match[2] + "-" + match[3] + "-" + match[4];
      const month = day.slice(0, 7);
      if (month === failMonth)
        return new Response("Not available", { status: 404 });
      const rows =
        segment === "FO"
          ? [0, 1, 2].map((i) => {
              const expiry = officialCalendar(
                monthOffset(month, i),
              ).actualExpiry;
              return syntheticRow(day, segment, {
                XpryDt: expiry,
                FininstrmActlXpryDt: expiry,
                OpnIntrst: ["150000", "800000", "50000"][i],
                ClsPric: String(1000 + i * 8),
              });
            })
          : [syntheticRow(day, segment)];
      const name = archiveName(segment, day);
      const buffer = syntheticZip([
        { name: name.slice(0, -4), data: syntheticCsv(rows) },
      ]);
      return new Response(new Uint8Array(buffer), {
        headers: { "content-type": "application/zip" },
      });
    }) as typeof fetch,
  };
}
test("seven real-provider snapshots persist, restart, remain idempotent and supply six-month formulas", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rollover-db-"));
  const path = join(directory, "test.sqlite");
  let sql = sqliteDatabase(path);
  const remote = fakeNse();
  try {
    const provider = new NseBhavcopyProvider({
      sql,
      fetcher: remote.fetcher,
      now,
      intervalMs: 0,
    });
    await provider.initialize();
    await Promise.all([provider.sync(true), provider.sync(true)]);
    assert.equal(remote.calls, 15);
    assert.equal(provider.load().rows.length, 7);
    assert.ok(provider.load().rows.every((r) => r.sector === "Capital Goods"));
    // Imported final reports are immutable, so a scheduled sync downloads nothing.
    await provider.sync();
    assert.equal(remote.calls, 15);
    assert.equal(provider.load().rows.at(-1)?.metrics.rolloverPct.value, 85);
    assert.equal(provider.status.errors.length, 0);
    assert.equal(
      (await sql.query("SELECT * FROM rollover_reports")).length,
      14,
    );
    await provider.sync(true);
    assert.equal(
      (await sql.query("SELECT * FROM rollover_reports")).length,
      14,
    );
    await sql.close();
    sql = sqliteDatabase(path);
    const restarted = new NseBhavcopyProvider({
      sql,
      now,
      fetcher: remote.fetcher,
    });
    await restarted.initialize();
    assert.equal(restarted.load().rows.length, 7);
    assert.equal(restarted.load().rows[0].sector, "Capital Goods");
    assert.equal(restarted.load().rows.at(-1)?.evidence, "VERIFIED");
  } finally {
    await sql.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("failed NSE month is never filled from another day or replaced with demonstration data", async () => {
  const remote = fakeNse("2026-08");
  const provider = new NseBhavcopyProvider({
    fetcher: remote.fetcher,
    now,
    intervalMs: 0,
  });
  await provider.sync(true);
  const missing = provider.load().months.find((m) => m.month === "2026-08")!;
  assert.equal(missing.status, "MISSING");
  assert.equal(missing.lastSync, null);
  assert.ok(provider.status.errors.some((e) => e.month === "2026-08"));
  assert.ok(!provider.load().rows.some((r) => r.month === "2026-08"));
  assert.ok(provider.load().rows.every((r) => r.evidence !== "DEMO"));
});
test("refresh endpoint enforces origin and exposes progress without waiting for downloads", async () => {
  const provider = new NseBhavcopyProvider({
    fetcher: fakeNse().fetcher,
    now,
    intervalMs: 0,
  });
  const server = createApp(undefined, { nseRollovers: provider });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const base = "http://127.0.0.1:" + addr.port;
  try {
    assert.equal(
      (
        await fetch(base + "/api/rollovers/refresh", {
          method: "POST",
          headers: { origin: "https://other.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + "/api/rollovers/refresh", {
          method: "POST",
          headers: { origin: base },
        })
      ).status,
      202,
    );
    await provider.sync();
    const result = await (
      await fetch(base + "/api/rollovers?month=2026-10")
    ).json();
    assert.equal(result.rows[0].metrics.rolloverPct.value, 85);
    assert.equal(result.evidence, "VERIFIED");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("NSE sector list is strictly validated", () => {
  const parsed = parseSectorCsv(sectorCsv(), "2026-11-01T00:00:00Z");
  assert.equal(parsed.sectors.SYNTHETIC, "Capital Goods");
  assert.equal(parsed.sectors.FILLER0, "Services");
  assert.throws(
    () => parseSectorCsv(sectorCsv().replace("Industry", "Sector"), ""),
    /header/,
  );
  assert.throws(
    () =>
      parseSectorCsv(
        sectorCsv([
          ["A", "Power", "DUP"],
          ["B", "Power", "DUP"],
        ]),
        "",
      ),
    /Invalid/,
  );
  assert.throws(
    () => parseSectorCsv(SECTOR_HEADERS.join(",") + "\n", ""),
    /row count/,
  );
});
test("sector list failure is reported without blocking rollover imports", async () => {
  const provider = new NseBhavcopyProvider({
    fetcher: fakeNse(undefined, true).fetcher,
    now,
    intervalMs: 0,
  });
  await provider.sync(true);
  assert.equal(provider.load().rows.length, 7);
  assert.ok(provider.load().rows.every((r) => r.sector === "Unclassified"));
  assert.deepEqual(
    provider.status.errors.map((e) => e.month),
    ["sectors"],
  );
});
