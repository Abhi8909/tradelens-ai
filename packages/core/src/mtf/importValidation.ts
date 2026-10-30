import { D, calendarDate, dayNumber } from './decimal.ts';
import type { MtfImportField, MtfImportIssue, MtfImportMetadata, MtfImportRow, MtfParsedRow, MtfReconciliation } from './importTypes.ts';

export const MTF_CSV_HEADERS: Record<string, MtfImportField> = {
  'scrip': 'symbol', 'buy date': 'buyDate', 'no of days': 'days', 'per day': 'perDay',
  'intreset till now': 'interest', 'interest till now': 'interest', 'other charges': 'otherCharges',
  'total charges': 'totalCharges', 'buy price': 'buyPrice', 'no of shares': 'quantity', 'new buy price': 'adjustedPrice',
  'current price': 'currentPrice', 'invested amount': 'invested', 'final total amount (charges + investment)': 'totalCost',
  'unreleased p/l': 'unrealized', 'unrealized p/l': 'unrealized', 'percent': 'percent', 'sell price': 'sellPrice',
  'exit date': 'exitDate', 'p/l': 'legacyPnl', 'note': 'note', 'notes': 'note',
};
const numeric: MtfImportField[] = ['days', 'perDay', 'interest', 'otherCharges', 'totalCharges', 'buyPrice', 'quantity', 'adjustedPrice', 'currentPrice', 'invested', 'totalCost', 'unrealized', 'percent', 'sellPrice', 'legacyPnl'];
export const MTF_IMPORT_FIELDS: MtfImportField[] = ['symbol', 'buyDate', ...numeric, 'exitDate', 'note'];
const missing = (v: string) => !v.trim() || v.trim().toUpperCase() === '#N/A';
function decimalText(raw: string, field: MtfImportField): string | null {
  if (missing(raw)) return null;
  const base = raw.trim().replace(/^₹\s*/, '');
  const text = field === 'percent' ? base.replace(/%$/, '') : base;
  // Accept plain, western or Indian grouping; do not repair malformed commas.
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})(?:\.\d{1,8})?$/.test(text)) return null;
  const value = new D(text.replaceAll(',', ''));
  if (value.abs().gte('1000000000000000')) return null;
  return value.toFixed();
}
export function parseMtfImportDate(raw: string, format: MtfImportMetadata['dateFormat']): string | null {
  if (missing(raw)) return null;
  let date = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    if (format !== 'MM/DD/YYYY' || !/^\d{2}\/\d{2}\/\d{4}$/.test(date)) return null;
    date = `${date.slice(6)}-${date.slice(0, 2)}-${date.slice(3, 5)}`;
  }
  try { return calendarDate(date); } catch { return null; }
}
/** Spreadsheet consistency checks are reconciliation evidence, never broker-verified calculations. */
export function validateMtfImportRow(row: Pick<MtfImportRow, 'fields'>, metadata: MtfImportMetadata): Pick<MtfImportRow, 'parsed' | 'issues' | 'reconciliation' | 'confidence'> {
  const fields = row.fields; const issues: MtfImportIssue[] = []; const reconciliation: MtfReconciliation[] = [];
  const values: MtfParsedRow['values'] = {};
  const add = (code: string, severity: MtfImportIssue['severity'], field?: MtfImportField) => issues.push({ code, severity, field });
  const symbol = (fields.symbol ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 .&_-]{0,49}$/.test(symbol)) add('INVALID_SYMBOL', 'ERROR', 'symbol');
  for (const field of numeric) {
    const raw = fields[field] ?? ''; const value = decimalText(raw, field); values[field] = value;
    if (!missing(raw) && value === null) add('INVALID_NUMBER', 'ERROR', field);
    if (value !== null && !['unrealized', 'percent', 'legacyPnl'].includes(field) && new D(value).lt(0)) add('NEGATIVE_VALUE', 'ERROR', field);
  }
  const buyDate = parseMtfImportDate(fields.buyDate ?? '', metadata.dateFormat);
  const exitDate = parseMtfImportDate(fields.exitDate ?? '', metadata.dateFormat);
  if (!buyDate) add('INVALID_BUY_DATE', 'ERROR', 'buyDate');
  if (!missing(fields.exitDate ?? '') && !exitDate) add('INVALID_EXIT_DATE', 'ERROR', 'exitDate');
  if (buyDate && (buyDate > metadata.snapshotDate || (exitDate && exitDate < buyDate))) add('INVALID_CHRONOLOGY', 'ERROR', 'exitDate');
  if (exitDate && exitDate > metadata.snapshotDate) add('INVALID_CHRONOLOGY', 'ERROR', 'exitDate');
  const q = values.quantity === null || values.quantity === undefined ? null : new D(values.quantity);
  if (!q || !q.isInteger() || q.lte(0) || q.gt(1_000_000_000)) add('INVALID_QUANTITY', 'ERROR', 'quantity');
  const quantity = q?.isInteger() && q.gt(0) && q.lte(1_000_000_000) ? q.toNumber() : null;
  if (!values.buyPrice || new D(values.buyPrice).lte(0)) add('INVALID_BUY_PRICE', 'ERROR', 'buyPrice');
  if (values.currentPrice && new D(values.currentPrice).lte(0)) add('INVALID_QUOTE_PRICE', 'ERROR', 'currentPrice');
  if (values.sellPrice && new D(values.sellPrice).lte(0)) add('INVALID_SELL_PRICE', 'ERROR', 'sellPrice');
  if (values.days && !new D(values.days).isInteger()) add('INVALID_DAY_COUNT', 'ERROR', 'days');
  if (!values.currentPrice || new D(values.currentPrice).lte(0)) { values.currentPrice = null; add('MISSING_QUOTE', 'WARNING', 'currentPrice'); }
  else add('UNVERIFIED_QUOTE_DATE', 'WARNING', 'currentPrice');
  add('MISSING_FUNDED_BALANCE', 'WARNING'); add('MISSING_RATE_POLICY', 'WARNING'); add('UNRESOLVED_INSTRUMENT', 'WARNING', 'symbol');
  if (values.otherCharges && new D(values.otherCharges).gt(0)) add('UNALLOCATED_CHARGE', 'WARNING', 'otherCharges');
  const conversion = /converted\s+to\s+delivery/i.test(fields.note ?? '');
  if (exitDate || values.sellPrice || conversion) add('UNMATCHED_EXIT', 'WARNING', 'exitDate');
  if (values.legacyPnl !== null && values.legacyPnl !== undefined) add('LEGACY_PNL_NOT_REALIZED', 'WARNING', 'legacyPnl');
  const check = (field: MtfImportField, expected: InstanceType<typeof D>, method: string, precision = 2) => {
    const raw = values[field]; if (raw === null || raw === undefined) return;
    const actual = new D(raw); const rounded = expected.toDecimalPlaces(precision); const delta = actual.sub(rounded);
    reconciliation.push({ field, imported: actual.toFixed(precision), recomputed: rounded.toFixed(precision), delta: delta.toFixed(precision), method });
    if (delta.abs().gt(new D(10).pow(-precision))) add('RECONCILIATION_MISMATCH', 'WARNING', field);
  };
  const validBuy = values.buyPrice && new D(values.buyPrice).gt(0) && quantity !== null;
  const purchase = validBuy ? new D(values.buyPrice!).mul(quantity!) : null;
  if (buyDate) check('days', new D(dayNumber(exitDate && exitDate >= buyDate ? exitDate : metadata.snapshotDate) - dayNumber(buyDate)), 'calendar days; not broker interest-bearing days', 0);
  if (values.days && values.perDay && new D(values.days).gte(0) && new D(values.perDay).gte(0)) check('interest', new D(values.days).mul(values.perDay), 'imported days × imported daily estimate; unverified');
  if (values.interest && values.otherCharges) check('totalCharges', new D(values.interest).add(values.otherCharges), 'imported interest + imported other charges');
  if (purchase) {
    check('invested', purchase, 'original buy price × snapshot quantity');
    if (values.perDay && new D(values.perDay).gt(purchase.mul('0.01'))) add('IMPLAUSIBLE_DAILY_INTEREST', 'WARNING', 'perDay');
    if (values.totalCharges) {
      const basis = purchase.add(values.totalCharges); check('totalCost', basis, 'purchase + imported charges');
      check('adjustedPrice', basis.div(quantity!), '(purchase + imported charges) / quantity');
      if (values.currentPrice) {
        const pnl = new D(values.currentPrice).mul(quantity!).sub(basis); check('unrealized', pnl, 'imported quote × quantity − imported cost basis');
        if (basis.gt(0)) check('percent', pnl.div(basis).mul(100), 'imported unrealized P&L / imported cost basis × 100');
      }
    }
  }
  return { parsed: { symbol, buyDate, exitDate, quantity, values, lifecycleHint: conversion ? 'CONVERSION_REQUIRES_CONFIRMATION' : exitDate || values.sellPrice ? 'EXIT_REQUIRES_CONFIRMATION' : 'OPEN' }, issues, reconciliation,
    confidence: issues.some(i => i.severity === 'ERROR') ? 'NEEDS_REVIEW' : 'UNVERIFIED' };
}
