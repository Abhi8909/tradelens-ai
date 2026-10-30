/** Bounded RFC-style CSV tokenizer. Raw cells remain private browser-local evidence. */
export const MTF_IMPORT_LIMITS = { bytes: 1_048_576, rows: 5000, columns: 64, cellLength: 16_384 } as const;
export class MtfImportError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; this.name = 'MtfImportError'; }
}
export function importAssert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new MtfImportError(code);
}
export function parseMtfCsv(text: string): string[][] {
  importAssert(typeof text === 'string' && new TextEncoder().encode(text).length <= MTF_IMPORT_LIMITS.bytes, 'FILE_TOO_LARGE');
  importAssert(!text.includes('\0'), 'INVALID_CONTENT');
  const input = text.replace(/^\uFEFF/, '');
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let state: 'plain' | 'quoted' | 'after-quote' = 'plain';
  function pushCell() {
    importAssert(cell.length <= MTF_IMPORT_LIMITS.cellLength && row.length < MTF_IMPORT_LIMITS.columns, 'CELL_OR_COLUMN_LIMIT');
    row.push(cell); cell = ''; state = 'plain';
  }
  function pushRow() {
    pushCell(); rows.push(row); row = [];
    importAssert(rows.length <= MTF_IMPORT_LIMITS.rows + 1, 'ROW_LIMIT');
  }
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (state === 'quoted') {
      if (ch === '"') { if (input[i + 1] === '"') { cell += '"'; i++; } else state = 'after-quote'; }
      else cell += ch;
    } else if (ch === ',') pushCell();
    else if (ch === '\r' || ch === '\n') { pushRow(); if (ch === '\r' && input[i + 1] === '\n') i++; }
    else if (state === 'after-quote') importAssert(false, 'MALFORMED_CSV');
    else if (ch === '"') { importAssert(cell === '', 'MALFORMED_CSV'); state = 'quoted'; }
    else cell += ch;
    importAssert(cell.length <= MTF_IMPORT_LIMITS.cellLength, 'CELL_OR_COLUMN_LIMIT');
  }
  importAssert(state !== 'quoted', 'MALFORMED_CSV');
  if (cell || row.length || state === 'after-quote') pushRow();
  return rows;
}
export async function mtfChecksum(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
export function exportMtfCsv(rows: readonly (readonly string[])[]): string {
  return rows.map(row => row.map(cell => {
    // Quoting alone does not stop spreadsheet formula evaluation.
    const safe = /^\s*[=+\-@]/.test(cell) || /^[\t\r\n]/.test(cell) ? `'${cell}` : cell;
    return `"${safe.replaceAll('"', '""')}"`;
  }).join(',')).join('\r\n');
}
