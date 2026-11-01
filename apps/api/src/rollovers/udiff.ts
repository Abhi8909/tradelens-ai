import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { Readable } from "node:stream";
import { fromBuffer } from "yauzl";
import { parse } from "csv-parse";
import { validDate } from "../../../../packages/core/src/rollovers.ts";
import type {
  RolloverContract,
  RolloverSource,
} from "../../../../packages/core/src/rolloverTypes.ts";
export const UDIFF_SCHEMA = "NSE_UDIFF_BHAVCOPY_34_V1";
export const FORMAT_REFERENCE =
  "https://archives.nseindia.com/web/mediaattachment/2026-06/UDiFF_trade_and_Bhavcopy_file_formats_20260630115803.xlsx";
export const FORMAT_SHA256 =
  "b9f2fa369af20381374cdb40c3ebc96c43029401e057225599cfe63b288ba3e8";
export const UDIFF_HEADERS =
  "TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4".split(
    ",",
  );
export type CashRow = {
  symbol: string;
  tradeDate: string;
  series: string;
  close: number | null;
  isin: string;
};
export type ParsedReport = {
  source: RolloverSource;
  segment: "FO" | "CM";
  date: string;
  rowCount: number;
  accepted: number;
  excluded: number;
  rejected: { line: number; reason: string; symbol: string }[];
  contracts: RolloverContract[];
  cash: CashRow[];
  bytes: number;
  filename: string;
};
export function archiveName(segment: "FO" | "CM", date: string) {
  if (!validDate(date)) throw new Error("Invalid report date");
  return (
    "BhavCopy_NSE_" +
    segment +
    "_0_0_0_" +
    date.replaceAll("-", "") +
    "_F_0000.csv.zip"
  );
}
export async function readCsvZip(
  buffer: Buffer,
  expected: string,
): Promise<Buffer> {
  if (buffer.length > 12 * 1024 * 1024)
    throw new Error("ZIP exceeds 12 MiB limit");
  return new Promise((resolve, reject) =>
    fromBuffer(
      buffer,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => {
        if (error || !zip) {
          reject(new Error("Invalid ZIP archive"));
          return;
        }
        let found = false;
        let data: Buffer | null = null;
        const fail = (message: string) => {
          zip.close();
          reject(new Error(message));
        };
        zip.on("error", () => fail("Invalid ZIP structure"));
        zip.on("entry", (entry) => {
          if (
            found ||
            entry.fileName !== expected ||
            entry.generalPurposeBitFlag & 1 ||
            entry.uncompressedSize > 40 * 1024 * 1024 ||
            (entry.compressionMethod !== 0 && entry.compressionMethod !== 8)
          ) {
            fail(
              "ZIP must contain exactly the expected final CSV, unencrypted and at most 40 MiB",
            );
            return;
          }
          found = true;
          zip.openReadStream(entry, (err, stream) => {
            if (err || !stream) {
              fail("Cannot read ZIP member");
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            stream.on("data", (chunk) => {
              size += chunk.length;
              if (size > 40 * 1024 * 1024) {
                stream.destroy();
                fail("Expanded CSV exceeds 40 MiB limit");
              } else chunks.push(Buffer.from(chunk));
            });
            stream.on("error", () => fail("Corrupt compressed CSV"));
            stream.on("end", () => {
              data = Buffer.concat(chunks);
              if (
                data.length !== entry.uncompressedSize ||
                crc32(data) !== entry.crc32
              ) {
                fail("ZIP size mismatch");
                return;
              }
              zip.readEntry();
            });
          });
        });
        zip.on("end", () => {
          if (data) resolve(data);
          else reject(new Error("ZIP has no final CSV"));
        });
        zip.readEntry();
      },
    ),
  );
}
const number = (text: string, integer = false): number | null => {
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) && (!integer || Number.isSafeInteger(n)) ? n : null;
};
export async function parseUdiffZip(
  buffer: Buffer,
  filename: string,
  segment: "FO" | "CM",
  date: string,
  reference: string,
  verified = false,
  receivedAt = new Date().toISOString(),
): Promise<ParsedReport> {
  if (filename !== archiveName(segment, date))
    throw new Error("Archive name does not match segment/date/final revision");
  const csv = await readCsvZip(buffer, filename.slice(0, -4));
  // Fatal UTF-8 decoding prevents replacement characters from silently altering identifiers.
  const text = new TextDecoder("utf-8", { fatal: true }).decode(csv);
  const result: ParsedReport = {
    segment,
    date,
    rowCount: 0,
    accepted: 0,
    excluded: 0,
    rejected: [],
    contracts: [],
    cash: [],
    bytes: buffer.length,
    filename,
    source: {
      id: createHash("sha256").update(buffer).digest("hex"),
      segment,
      reportDate: date,
      receivedAt,
      evidence: verified ? "VERIFIED" : "UNVERIFIED",
      reference,
      schemaVersion: UDIFF_SCHEMA,
      sha256: createHash("sha256").update(buffer).digest("hex"),
    },
  };
  const keys = new Set<string>();
  const parser = Readable.from([text]).pipe(
    parse({
      bom: true,
      columns: (headers) => {
        if (
          headers.length !== UDIFF_HEADERS.length ||
          headers.some((h: string, i: number) => h !== UDIFF_HEADERS[i])
        )
          throw new Error(
            "Unsupported UDiFF schema; exact 34-column NSE header expected",
          );
        return headers;
      },
      skip_empty_lines: true,
      relax_column_count: false,
      max_record_size: 64 * 1024,
    }),
  );
  for await (const row of parser) {
    result.rowCount++;
    if (result.rowCount > 250000) throw new Error("CSV exceeds 250,000 rows");
    if (
      row.TradDt !== date ||
      row.BizDt !== date ||
      row.Sgmt !== segment ||
      row.Src !== "NSE"
    )
      throw new Error(
        "Report contains mismatched trade/business date, segment or exchange",
      );
    const known = segment === "FO" ? ["STF", "STO", "IDF", "IDO"] : ["STK"];
    if (!known.includes(row.FinInstrmTp))
      throw new Error(
        "Unknown FinInstrmTp code: " + String(row.FinInstrmTp).slice(0, 12),
      );
    if (
      (segment === "FO" && row.FinInstrmTp !== "STF") ||
      (segment === "CM" && row.SctySrs !== "EQ")
    ) {
      result.excluded++;
      continue;
    }
    const symbol = row.TckrSymb;
    let reason = "";
    if (!/^[A-Z0-9&._-]{1,80}$/.test(symbol))
      reason = "Invalid underlying symbol";
    const price = number(row.ClsPric);
    if (price === null || price <= 0) reason = "Missing or invalid close price";
    if (segment === "FO") {
      const expiry = row.FininstrmActlXpryDt;
      const oi = number(row.OpnIntrst, true);
      const lot = number(row.NewBrdLotQty, true);
      if (!validDate(expiry) || !validDate(row.XpryDt) || expiry < date)
        reason = "Invalid actual/original expiry";
      if (oi === null || lot === null || lot <= 0 || oi % lot !== 0)
        reason = "Invalid OI/market-lot units";
      if (row.OptnTp !== "" || row.StrkPric !== "")
        reason = "Stock futures must not carry option fields";
      const key = symbol + ":" + row.XpryDt + ":" + expiry;
      if (keys.has(key)) throw new Error("Duplicate stock futures contract");
      keys.add(key);
      // Retain missing values in the normalized row so the scrip is excluded, never silently repaired.
      result.contracts.push({
        symbol,
        tradeDate: date,
        expiry,
        instrument: "STF",
        close: reason ? null : price,
        oi: reason ? null : oi,
        oiUnit: "SHARES",
        originalExpiry: row.XpryDt,
        instrumentId: row.FinInstrmId,
        marketLot: lot ?? undefined,
      });
    } else {
      const key = symbol;
      if (keys.has(key)) throw new Error("Duplicate EQ cash symbol");
      keys.add(key);
      if (!/^[A-Z0-9]{12}$/.test(row.ISIN))
        reason = "Missing or invalid cash ISIN";
      result.cash.push({
        symbol,
        tradeDate: date,
        series: "EQ",
        close: reason ? null : price,
        isin: row.ISIN,
      });
    }
    if (reason) {
      if (result.rejected.length < 2000)
        result.rejected.push({ line: result.rowCount + 1, reason, symbol });
    } else result.accepted++;
  }
  if (
    !result.rowCount ||
    !(segment === "FO" ? result.contracts.length : result.cash.length)
  )
    throw new Error("Report contains no eligible stock futures/EQ rows");
  return result;
}
