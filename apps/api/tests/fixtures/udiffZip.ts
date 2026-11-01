import { crc32, deflateRawSync } from "node:zlib";
import { UDIFF_HEADERS } from "../../src/rollovers/udiff.ts";
export function syntheticCsv(
  rows: Record<string, string>[],
  headers = UDIFF_HEADERS,
): Buffer {
  const cell = (value: string) => '"' + value.replaceAll('"', '""') + '"';
  return Buffer.from(
    headers.map(cell).join(",") +
      "\r\n" +
      rows
        .map((r) => headers.map((h) => cell(r[h] ?? "")).join(","))
        .join("\r\n") +
      "\r\n",
  );
}
export function syntheticRow(
  date: string,
  segment: "FO" | "CM",
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    TradDt: date,
    BizDt: date,
    Sgmt: segment,
    Src: "NSE",
    FinInstrmTp: segment === "FO" ? "STF" : "STK",
    FinInstrmId: "synthetic-id",
    ISIN: segment === "CM" ? "SYNTHETIC001" : "",
    TckrSymb: "SYNTHETIC",
    SctySrs: segment === "CM" ? "EQ" : "",
    XpryDt: segment === "FO" ? "2026-10-27" : "",
    FininstrmActlXpryDt: segment === "FO" ? "2026-10-27" : "",
    ClsPric: segment === "FO" ? "1000" : "995",
    OpnIntrst: segment === "FO" ? "150000" : "",
    NewBrdLotQty: segment === "FO" ? "100" : "1",
    SsnId: segment === "FO" ? "F1" : "N1",
    ...extra,
  };
}
export function syntheticZip(
  entries: {
    name: string;
    data: Buffer;
    badCrc?: boolean;
    size?: number;
    encrypted?: boolean;
  }[],
): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = deflateRawSync(entry.data);
    const crc = entry.badCrc ? 123 : crc32(entry.data);
    const size = entry.size ?? entry.data.length;
    const flags = entry.encrypted ? 1 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const index = Buffer.alloc(46);
    index.writeUInt32LE(0x02014b50, 0);
    index.writeUInt16LE(20, 4);
    index.writeUInt16LE(20, 6);
    index.writeUInt16LE(flags, 8);
    index.writeUInt16LE(8, 10);
    index.writeUInt32LE(crc, 16);
    index.writeUInt32LE(data.length, 20);
    index.writeUInt32LE(size, 24);
    index.writeUInt16LE(name.length, 28);
    index.writeUInt32LE(offset, 42);
    central.push(index, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
