import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
export const SECTOR_URL =
  "https://archives.nseindia.com/content/indices/ind_nifty500list.csv";
export const SECTOR_REFERENCE =
  "NSE Nifty 500 constituents, Industry column (current classification)";
export const SECTOR_HEADERS = [
  "Company Name",
  "Industry",
  "Symbol",
  "Series",
  "ISIN Code",
];
export const UNCLASSIFIED = "Unclassified";
export type SectorMap = {
  reference: string;
  url: string;
  sha256: string;
  fetchedAt: string;
  sectors: Record<string, string>;
};
export function parseSectorCsv(
  text: string,
  fetchedAt: string,
): SectorMap {
  const rows: string[][] = parse(text, {
    bom: true,
    skip_empty_lines: true,
    relax_column_count: false,
    max_record_size: 4096,
  });
  const [header, ...body] = rows;
  if (
    !header ||
    header.length !== SECTOR_HEADERS.length ||
    header.some((h, i) => h.trim() !== SECTOR_HEADERS[i])
  )
    throw new Error("Unsupported NSE index constituent header");
  if (body.length < 100 || body.length > 1000)
    throw new Error("Unexpected NSE index constituent row count");
  const sectors: Record<string, string> = {};
  for (const [, industry, symbol, series] of body) {
    const name = industry.trim();
    if (
      !/^[A-Z0-9&._-]{1,80}$/.test(symbol) ||
      !/^[A-Z0-9]{2}$/.test(series) ||
      !name ||
      name.length > 80 ||
      sectors[symbol]
    )
      throw new Error("Invalid NSE index constituent row: " + symbol.slice(0, 20));
    sectors[symbol] = name;
  }
  return {
    reference: SECTOR_REFERENCE,
    url: SECTOR_URL,
    sha256: createHash("sha256").update(text).digest("hex"),
    fetchedAt,
    sectors,
  };
}
export async function downloadSectors(
  fetcher: typeof fetch,
  fetchedAt: string,
): Promise<SectorMap> {
  const response = await fetcher(SECTOR_URL, {
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers: { Accept: "text/csv" },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("NSE sector list HTTP " + response.status);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 512 * 1024)
    throw new Error("NSE sector list exceeds 512 KiB");
  return parseSectorCsv(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    fetchedAt,
  );
}
