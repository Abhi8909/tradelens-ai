import {
  monthOffset,
  snapshotBeforeExpiry,
} from "../../../../packages/core/src/rollovers.ts";
import type {
  ExpiryCalendar,
  RolloverDataset,
} from "../../../../packages/core/src/rolloverTypes.ts";
export const CALENDAR_REFERENCE =
  "NSE/FAOP/71777 + NSE/CMTR/71775 (2026); last-Tuesday rule NSE/FAOP/68747";
export const CALENDAR_URL =
  "https://archives.nseindia.com/content/circulars/FAOP71777.pdf";
const HOLIDAYS_2026 = new Set([
  "2026-01-26",
  "2026-03-03",
  "2026-03-26",
  "2026-03-31",
  "2026-04-03",
  "2026-04-14",
  "2026-05-01",
  "2026-05-28",
  "2026-06-26",
  "2026-09-14",
  "2026-10-02",
  "2026-10-20",
  "2026-11-10",
  "2026-11-24",
  "2026-12-25",
]);
export function officialCalendar(month: string): ExpiryCalendar {
  monthOffset(month, 0);
  if (!month.startsWith("2026-"))
    throw new Error(
      "Official trading calendar not configured for " + month.slice(0, 4),
    );
  const first = new Date(month + "-01T00:00:00Z");
  const end = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  );
  while (end.getUTCDay() !== 2) end.setUTCDate(end.getUTCDate() - 1);
  const sessions: string[] = [];
  for (let day = 1; day <= 31; day++) {
    const d = new Date(
      Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), day),
    );
    if (d.getUTCMonth() !== first.getUTCMonth()) break;
    const iso = d.toISOString().slice(0, 10);
    if (![0, 6].includes(d.getUTCDay()) && !HOLIDAYS_2026.has(iso))
      sessions.push(iso);
  }
  const actualExpiry = sessions
    .filter((d) => d <= end.toISOString().slice(0, 10))
    .at(-1);
  if (!actualExpiry) throw new Error("No actual expiry session");
  return {
    month,
    actualExpiry,
    tradingDates: sessions,
    evidence: "VERIFIED",
    reference: CALENDAR_REFERENCE + "; " + CALENDAR_URL,
  };
}
export function completedMonths(now = new Date(), count = 6): string[] {
  const day = new Date(now.getTime() + 19_800_000).toISOString().slice(0, 10);
  let end = day.slice(0, 7);
  // Finalize only after expiry day is over; final-file availability is checked separately.
  if (officialCalendar(end).actualExpiry >= day) end = monthOffset(end, -1);
  return Array.from({ length: count }, (_, i) =>
    monthOffset(end, i - count + 1),
  );
}
export function emptyNseDataset(now = new Date()): RolloverDataset {
  let requested: string[];
  try {
    requested = completedMonths(now);
  } catch {
    const end = monthOffset(
      new Date(now.getTime() + 19_800_000).toISOString().slice(0, 7),
      -1,
    );
    requested = Array.from({ length: 6 }, (_, i) => monthOffset(end, i - 5));
  }
  const months = requested.map((month) => {
    let calendar: ExpiryCalendar;
    try {
      calendar = officialCalendar(month);
    } catch {
      return {
        month,
        actualExpiry: "",
        snapshotDate: "",
        status: "MISSING" as const,
        evidence: "UNVERIFIED" as const,
        lastSync: null,
        issues: [
          "Official trading calendar must be updated for " + month.slice(0, 4),
        ],
      };
    }
    return {
      month,
      actualExpiry: calendar.actualExpiry,
      snapshotDate: snapshotBeforeExpiry(calendar),
      status: "MISSING" as const,
      evidence: "UNVERIFIED" as const,
      lastSync: null,
      issues: [
        "NSE final FO/CM reports have not been downloaded and validated.",
      ],
    };
  });
  return {
    evidence: "UNVERIFIED",
    calendarReference: CALENDAR_REFERENCE,
    rows: [],
    months,
  };
}
