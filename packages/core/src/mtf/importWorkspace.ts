import { calendarDate, instant } from './decimal.ts';
import { importAssert, mtfChecksum, parseMtfCsv } from './csv.ts';
import { MTF_CSV_HEADERS, MTF_IMPORT_FIELDS, validateMtfImportRow } from './importValidation.ts';
import type { MtfImportedRecord, MtfImportField, MtfImportMetadata, MtfImportPreview, MtfImportReceipt, MtfImportRow, MtfImportSelection } from './importTypes.ts';

const headerField = (key: string) => Object.hasOwn(MTF_CSV_HEADERS, key) ? MTF_CSV_HEADERS[key] : null;
const normalizeHeader = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
const positionKey = (row: MtfImportRow) => JSON.stringify([row.parsed.symbol.toUpperCase(), row.parsed.buyDate, row.parsed.quantity, row.parsed.values.buyPrice]);
const scopeKey = (metadata: MtfImportMetadata) => JSON.stringify([metadata.tenantId, metadata.accountId]);
function validateMetadata(metadata: MtfImportMetadata) {
  for (const v of [metadata.tenantId, metadata.accountId, metadata.broker]) importAssert(typeof v === 'string' && !!v.trim() && v.length <= 120, 'INVALID_METADATA');
  calendarDate(metadata.snapshotDate);
  importAssert(['ISO', 'MM/DD/YYYY'].includes(metadata.dateFormat), 'INVALID_METADATA');
}

/** Private in-memory staging store. Never uploads, logs or persists personal CSV data.
 * Detached previews/records cannot bypass validation or mutate this workspace. */
export class MtfImportWorkspace {
  #previews = new Map<string, MtfImportPreview>();
  #records: MtfImportedRecord[] = [];
  #receipts = new Map<string, { selection: string; receipt: MtfImportReceipt }>();
  get records(): MtfImportedRecord[] { return structuredClone(this.#records); }
  get previews(): MtfImportPreview[] { return structuredClone([...this.#previews.values()]); }
  clear() { this.#previews.clear(); this.#records = []; this.#receipts.clear(); }

  async preview(text: string, metadata: MtfImportMetadata, filename: string): Promise<MtfImportPreview> {
    validateMetadata(metadata); importAssert(typeof filename === 'string' && filename.length <= 255, 'INVALID_FILENAME');
    const matrix = parseMtfCsv(text);
    const headerIndex = matrix.findIndex(row => row.some(v => v.trim()));
    importAssert(headerIndex >= 0, 'EMPTY_CSV');
    const headers = matrix[headerIndex]; const mapping = headers.map((h, i) => headerField(normalizeHeader(h)) ?? (!h.trim() && i === 18 ? 'note' : null));
    const recognized = mapping.filter((v): v is MtfImportField => v !== null);
    importAssert(new Set(recognized).size === recognized.length, 'DUPLICATE_HEADER');
    importAssert(['symbol', 'buyDate', 'quantity', 'buyPrice'].every(k => recognized.includes(k as MtfImportField)), 'MISSING_HEADERS');
    const checksum = await mtfChecksum(text);
    const id = await mtfChecksum(JSON.stringify(['mtf-csv-v1', checksum, metadata.tenantId, metadata.accountId, metadata.broker, metadata.snapshotDate, metadata.dateFormat]));
    const prior = this.#previews.get(id); if (prior) return structuredClone(prior);
    const preview: MtfImportPreview = { id, checksum, importerVersion: 'mtf-csv-v1', filename, metadata: structuredClone(metadata), headers: [...headers],
      rows: [], skipped: [], issues: [], corrections: [], evidence: 'IMPORTED_UNVERIFIED' };
    if (headers.some(h => h.trim() && !headerField(normalizeHeader(h)))) preview.issues.push({ code: 'UNKNOWN_COLUMNS_PRESERVED', severity: 'WARNING' });
    const symbolIndex = mapping.indexOf('symbol');
    for (let index = headerIndex + 1; index < matrix.length; index++) {
      const raw = matrix[index]; const recordNumber = index + 1;
      if (raw.every(v => !v.trim())) { preview.skipped.push({ recordNumber, reason: 'BLANK' }); continue; }
      const symbol = (raw[symbolIndex] ?? '').trim();
      const noTradeFields = ['buyDate', 'buyPrice', 'quantity', 'sellPrice', 'exitDate'].every(field => !(raw[mapping.indexOf(field as MtfImportField)] ?? '').trim());
      // Only clearly labelled aggregate rows are skipped. Missing-symbol data remains a rejected candidate.
      if ((!symbol && noTradeFields) || (!symbol && raw.some(v => /^(grand\s+)?total(?:\s|:|$)|^summary$/i.test(v.trim()))) || /^(grand\s+)?total$|^summary$/i.test(symbol)) { preview.skipped.push({ recordNumber, reason: 'FOOTER' }); continue; }
      const fields: MtfImportRow['fields'] = {};
      mapping.forEach((field, i) => { if (field) fields[field] = raw[i] ?? ''; });
      const fingerprint = await mtfChecksum(JSON.stringify(Array.from({ length: headers.length }, (_, i) => (raw[i] ?? '').trim())));
      const row: MtfImportRow = { id: `${id}:${recordNumber}`, recordNumber, fingerprint, raw: [...raw], fields,
        ...validateMtfImportRow({ fields }, metadata) };
      if (raw.length > headers.length && raw.slice(headers.length).some(v => v.trim())) row.issues.push({ code: 'COLUMN_COUNT_MISMATCH', severity: 'ERROR' });
      preview.rows.push(row);
    }
    importAssert(preview.rows.length > 0, 'NO_POSITION_ROWS');
    this.#refresh(preview);
    const concurrent = this.#previews.get(id); if (concurrent) return structuredClone(concurrent);
    this.#previews.set(id, preview);
    return structuredClone(preview);
  }

  #refresh(preview: MtfImportPreview) {
    const fingerprintCounts = new Map<string, number>(); const symbolCounts = new Map<string, number>();
    const scoped = this.#records.filter(r => scopeKey(r.metadata) === scopeKey(preview.metadata));
    const existingFingerprints = new Set(scoped.map(r => r.fingerprint));
    const existingPositions = new Set(scoped.map(r => positionKey(r.row)));
    for (const row of preview.rows) {
      Object.assign(row, validateMtfImportRow(row, preview.metadata));
      fingerprintCounts.set(row.fingerprint, (fingerprintCounts.get(row.fingerprint) ?? 0) + 1);
      const symbol = row.parsed.symbol.toUpperCase(); symbolCounts.set(symbol, (symbolCounts.get(symbol) ?? 0) + 1);
    }
    for (const row of preview.rows) {
      if (row.raw.length > preview.headers.length && row.raw.slice(preview.headers.length).some(v => v.trim())) row.issues.push({ code: 'COLUMN_COUNT_MISMATCH', severity: 'ERROR' });
      if (fingerprintCounts.get(row.fingerprint)! > 1) row.issues.push({ code: 'DUPLICATE_ROW', severity: 'ERROR' });
      if (symbolCounts.get(row.parsed.symbol.toUpperCase())! > 1) row.issues.push({ code: 'AMBIGUOUS_LOT_MAPPING', severity: 'ERROR', field: 'symbol' });
      if (existingFingerprints.has(row.fingerprint)) row.issues.push({ code: 'ALREADY_IMPORTED', severity: 'ERROR' });
      else if (existingPositions.has(positionKey(row))) row.issues.push({ code: 'POSSIBLE_DUPLICATE_POSITION', severity: 'ERROR' });
      row.confidence = row.issues.some(i => i.severity === 'ERROR') ? 'NEEDS_REVIEW' : 'UNVERIFIED';
    }
  }

  correct(previewId: string, rowId: string, changes: Partial<Record<MtfImportField, string>>, reason: string, at: string): MtfImportPreview {
    const stored = this.#previews.get(previewId); importAssert(stored, 'UNKNOWN_PREVIEW');
    importAssert(!this.#receipts.has(previewId), 'ALREADY_CONFIRMED'); instant(at);
    importAssert(typeof reason === 'string' && !!reason.trim() && reason.length <= 500, 'CORRECTION_REASON_REQUIRED');
    const entries = Object.entries(changes); importAssert(entries.length > 0 && entries.every(([k, v]) => MTF_IMPORT_FIELDS.includes(k as MtfImportField) && typeof v === 'string' && v.length <= 16_384), 'INVALID_CORRECTION');
    const next = structuredClone(stored); const row = next.rows.find(r => r.id === rowId); importAssert(row, 'UNKNOWN_ROW');
    const previous = next.corrections.at(-1); if (previous) importAssert(instant(at) >= instant(previous.at), 'INVALID_AUDIT_CHRONOLOGY');
    for (const [key, after] of entries) {
      const field = key as MtfImportField; const before = row.fields[field] ?? '';
      if (before === after) continue;
      next.corrections.push({ rowId, field, before, after, reason: reason.trim(), at }); row.fields[field] = after;
    }
    this.#refresh(next); this.#previews.set(previewId, next); return structuredClone(next);
  }

  confirm(previewId: string, selection: MtfImportSelection[], at: string): MtfImportReceipt {
    const stored = this.#previews.get(previewId); importAssert(stored, 'UNKNOWN_PREVIEW'); instant(at);
    importAssert(Array.isArray(selection) && selection.length > 0 && selection.length <= stored.rows.length, 'INVALID_SELECTION');
    const ids = new Set(selection.map(s => s.rowId)); importAssert(ids.size === selection.length, 'DUPLICATE_SELECTION');
    importAssert(selection.every(s => ['REVIEW', 'ACCEPT_UNVERIFIED'].includes(s.mode)), 'INVALID_SELECTION');
    const key = JSON.stringify(selection.map(s => [s.rowId, s.mode]).sort(([a], [b]) => a.localeCompare(b)));
    const prior = this.#receipts.get(previewId);
    if (prior) { importAssert(prior.selection === key, 'CONFIRMATION_CONFLICT'); return structuredClone(prior.receipt); }
    const lastCorrection = stored.corrections.at(-1); if (lastCorrection) importAssert(instant(at) >= instant(lastCorrection.at), 'INVALID_AUDIT_CHRONOLOGY');
    const preview = structuredClone(stored); this.#refresh(preview);
    const records: MtfImportedRecord[] = []; const fingerprints = new Set<string>();
    for (const selected of selection) {
      const row = preview.rows.find(r => r.id === selected.rowId); importAssert(row, 'UNKNOWN_ROW');
      importAssert(!fingerprints.has(row.fingerprint) && !row.issues.some(i => i.code === 'ALREADY_IMPORTED'), 'DUPLICATE_IMPORT'); fingerprints.add(row.fingerprint);
      importAssert(selected.mode === 'REVIEW' || !row.issues.some(i => i.severity === 'ERROR'), 'ROW_REQUIRES_REVIEW');
      records.push({ id: `${previewId}:${row.recordNumber}`, previewId, fingerprint: row.fingerprint, metadata: structuredClone(preview.metadata), row: structuredClone(row),
        disposition: selected.mode === 'REVIEW' ? 'NEEDS_REVIEW' : 'ACCEPTED_UNVERIFIED', evidence: 'IMPORTED_UNVERIFIED', confirmedAt: at });
    }
    // Commit only after every selected row passes validation; no partial writes on error.
    const receipt: MtfImportReceipt = { id: `confirmation:${previewId}`, previewId, recordIds: records.map(r => r.id), confirmedAt: at };
    this.#records = [...this.#records, ...records]; this.#previews.set(previewId, preview);
    this.#receipts.set(previewId, { selection: key, receipt });
    return structuredClone(receipt);
  }
}
