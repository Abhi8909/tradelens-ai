import type { MtfScope } from './types.ts';
export type MtfImportField = 'symbol' | 'buyDate' | 'days' | 'perDay' | 'interest' | 'otherCharges' | 'totalCharges' | 'buyPrice' | 'quantity' | 'adjustedPrice' | 'currentPrice' | 'invested' | 'totalCost' | 'unrealized' | 'percent' | 'sellPrice' | 'exitDate' | 'legacyPnl' | 'note';
export type MtfImportMetadata = MtfScope & { broker: string; snapshotDate: string; dateFormat: 'MM/DD/YYYY' | 'ISO'; };
export type MtfImportIssue = { code: string; severity: 'ERROR' | 'WARNING'; field?: MtfImportField };
export type MtfReconciliation = { field: MtfImportField; imported: string; recomputed: string; delta: string; method: string };
export type MtfParsedRow = {
  symbol: string; buyDate: string | null; exitDate: string | null; quantity: number | null;
  values: Partial<Record<MtfImportField, string | null>>;
  lifecycleHint: 'OPEN' | 'EXIT_REQUIRES_CONFIRMATION' | 'CONVERSION_REQUIRES_CONFIRMATION';
};
export type MtfImportCorrection = { rowId: string; field: MtfImportField; before: string; after: string; reason: string; at: string };
export type MtfImportRow = {
  id: string; recordNumber: number; fingerprint: string; raw: string[];
  fields: Partial<Record<MtfImportField, string>>; parsed: MtfParsedRow; issues: MtfImportIssue[];
  reconciliation: MtfReconciliation[]; confidence: 'NEEDS_REVIEW' | 'UNVERIFIED';
};
export type MtfImportPreview = {
  id: string; checksum: string; importerVersion: 'mtf-csv-v1'; filename: string; metadata: MtfImportMetadata;
  headers: string[]; rows: MtfImportRow[]; skipped: { recordNumber: number; reason: 'BLANK' | 'FOOTER' }[];
  issues: MtfImportIssue[]; corrections: MtfImportCorrection[]; evidence: 'IMPORTED_UNVERIFIED';
};
export type MtfImportSelection = { rowId: string; mode: 'ACCEPT_UNVERIFIED' | 'REVIEW' };
export type MtfImportedRecord = {
  id: string; previewId: string; fingerprint: string; metadata: MtfImportMetadata; row: MtfImportRow;
  disposition: 'ACCEPTED_UNVERIFIED' | 'NEEDS_REVIEW'; evidence: 'IMPORTED_UNVERIFIED'; confirmedAt: string;
};
export type MtfImportReceipt = { id: string; previewId: string; recordIds: string[]; confirmedAt: string };
