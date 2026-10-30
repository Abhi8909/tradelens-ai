import test from 'node:test';
import assert from 'node:assert/strict';
import { MtfImportWorkspace, MTF_IMPORT_LIMITS, exportMtfCsv, parseMtfCsv, parseMtfImportDate, syntheticMtfImportCsv, type MtfImportMetadata } from '../src/mtf/index.ts';
const metadata: MtfImportMetadata = { tenantId: 'synthetic-tenant', accountId: 'synthetic-account', broker: 'Synthetic broker', snapshotDate: '2025-08-31', dateFormat: 'MM/DD/YYYY' };
const at = '2025-09-01T10:00:00Z';
const simple = (symbol = 'SYN-ONE', extra = '') => `Scrip,Buy Date,Buy Price,No of Shares,Current Price${extra}\n${symbol},08/01/2025,50,10,#N/A`;

test('MTF CSV acceptance: nine synthetic candidates, three chronology failures, trailing columns and footer', async () => {
  const workspace = new MtfImportWorkspace(); const preview = await workspace.preview(syntheticMtfImportCsv(), metadata, 'untrusted-old-name.csv');
  assert.equal(preview.headers.length, 20); assert.equal(preview.rows.length, 9);
  assert.equal(preview.rows.filter(r => r.issues.some(i => i.code === 'INVALID_CHRONOLOGY')).length, 3);
  assert.equal(preview.rows[6].parsed.lifecycleHint, 'CONVERSION_REQUIRES_CONFIRMATION');
  assert.equal(preview.metadata.snapshotDate, '2025-08-31'); assert.equal(preview.evidence, 'IMPORTED_UNVERIFIED');
  assert.equal(preview.rows[4].parsed.values.currentPrice, null);
  assert.ok(preview.skipped.some(s => s.reason === 'FOOTER'));
  assert.ok(preview.rows[0].issues.some(i => i.code === 'MISSING_FUNDED_BALANCE'));
});

test('MTF CSV handles BOM, CRLF, quoted commas/newlines and escaped quotes', () => {
  const rows = parseMtfCsv('\uFEFFScrip,Notes\r\nSYN-ONE,"comma, line\nwith ""quotes"""\r\n');
  assert.deepEqual(rows, [['Scrip', 'Notes'], ['SYN-ONE', 'comma, line\nwith "quotes"']]);
});

test('MTF CSV rejects malformed quoting, NUL, excessive cells/columns, oversized files and rows', () => {
  for (const text of ['a,"unterminated', 'a,un"quoted', 'a,"quoted"junk', 'a,\0']) assert.throws(() => parseMtfCsv(text));
  assert.throws(() => parseMtfCsv('x'.repeat(MTF_IMPORT_LIMITS.bytes + 1)));
  assert.throws(() => parseMtfCsv('x'.repeat(MTF_IMPORT_LIMITS.cellLength + 1)));
  assert.throws(() => parseMtfCsv(Array(65).fill('x').join(',')));
  assert.throws(() => parseMtfCsv('a\n'.repeat(5002)));
});

test('MTF date parsing is configured and strict, including leap years', () => {
  assert.equal(parseMtfImportDate('02/29/2024', 'MM/DD/YYYY'), '2024-02-29');
  assert.equal(parseMtfImportDate('2025-08-01', 'MM/DD/YYYY'), '2025-08-01');
  for (const s of ['02/29/2025', '13/01/2025', '8/1/2025', '2025-02-30']) assert.equal(parseMtfImportDate(s, 'MM/DD/YYYY'), null);
  assert.equal(parseMtfImportDate('08/01/2025', 'ISO'), null);
});

test('MTF CSV validates headers and retains unknown column evidence without prototype lookup', async () => {
  const w = new MtfImportWorkspace();
  await assert.rejects(w.preview('Scrip,Buy Date\nSYN,08/01/2025', metadata, 'a.csv'));
  await assert.rejects(w.preview('Scrip,Buy Date,Buy Price,No of Shares,Scrip\nSYN,08/01/2025,50,10,SYN', metadata, 'a.csv'));
  const preview = await w.preview('Scrip,Buy Date,Buy Price,No of Shares,__proto__\nSYN,08/01/2025,50,10,private-note', metadata, 'a.csv');
  assert.equal(preview.rows[0].raw[4], 'private-note'); assert.equal(preview.issues[0].code, 'UNKNOWN_COLUMNS_PRESERVED');
});

test('MTF import normalizes Indian/western amounts and percent strings with decimal-safe deltas', async () => {
  const text = exportMtfCsv([['Scrip', 'Buy Date', 'Buy Price', 'No of Shares', 'Invested amount', 'Other Charges', 'Intreset Till Now', 'Total charges', 'New Buy Price', 'Percent'], ['SYN-ONE', '08/01/2025', '1,234.50', '100', '1,23,450.00', '10', '20', '30', '1234.80', '2.45%']]);
  const p = await new MtfImportWorkspace().preview(text, metadata, 'a.csv'); const row = p.rows[0];
  assert.equal(row.parsed.values.invested, '123450'); assert.equal(row.parsed.values.percent, '2.45');
  assert.equal(row.reconciliation.find(r => r.field === 'invested')!.delta, '0.00');
  assert.equal(row.reconciliation.find(r => r.field === 'adjustedPrice')!.recomputed, '1234.80');
});

test('MTF import flags invalid quantities, negative days/interest, impossible prices and chronology', async () => {
  const csv = 'Scrip,Buy Date,Buy Price,No of Shares,No of Days,Intreset Till Now,Exit Date\nSYN-ONE,08/20/2025,-50,0,-3,-10,08/01/2025';
  const p = await new MtfImportWorkspace().preview(csv, metadata, 'a.csv');
  for (const code of ['INVALID_BUY_PRICE', 'INVALID_QUANTITY', 'NEGATIVE_VALUE', 'INVALID_CHRONOLOGY']) assert.ok(p.rows[0].issues.some(i => i.code === code));
});

test('MTF import treats #N/A as missing and never imports spreadsheet P&L as realized', async () => {
  const p = await new MtfImportWorkspace().preview('Scrip,Buy Date,Buy Price,No of Shares,Current Price,P/L\nSYN-ONE,08/01/2025,50,10,#N/A,-500', metadata, 'a.csv');
  assert.equal(p.rows[0].parsed.values.currentPrice, null); assert.equal(p.rows[0].parsed.values.legacyPnl, '-500');
  assert.ok(p.rows[0].issues.some(i => i.code === 'LEGACY_PNL_NOT_REALIZED'));
});

test('MTF unusually high daily estimates and spreadsheet mismatches are unverified warnings', async () => {
  const p = await new MtfImportWorkspace().preview('Scrip,Buy Date,Buy Price,No of Shares,Per day,No of Days,Intreset Till Now\nSYN-ONE,08/01/2025,50,10,50,30,42', metadata, 'a.csv');
  assert.ok(p.rows[0].issues.some(i => i.code === 'IMPLAUSIBLE_DAILY_INTEREST'));
  assert.ok(p.rows[0].issues.some(i => i.code === 'RECONCILIATION_MISMATCH'));
  assert.equal(p.rows[0].reconciliation.find(r => r.field === 'interest')!.recomputed, '1500.00');
});

test('MTF corrections preserve raw evidence, record reason/time and revalidate the proposed row', async () => {
  const w = new MtfImportWorkspace(); const p = await w.preview(syntheticMtfImportCsv(), metadata, 'a.csv'); const bad = p.rows[7];
  const next = w.correct(p.id, bad.id, { exitDate: '08/25/2025' }, 'Synthetic date correction', at);
  const corrected = next.rows.find(r => r.id === bad.id)!;
  assert.equal(corrected.parsed.exitDate, '2025-08-25'); assert.equal(corrected.raw[16], '08/01/2025');
  assert.ok(!corrected.issues.some(i => i.code === 'INVALID_CHRONOLOGY'));
  assert.deepEqual(next.corrections[0], { rowId: bad.id, field: 'exitDate', before: '08/01/2025', after: '08/25/2025', reason: 'Synthetic date correction', at });
  assert.throws(() => w.correct(p.id, bad.id, { exitDate: '08/25/2025' }, '', at));
});

test('MTF confirmation is transactional: a rejected selected row leaves every record untouched', async () => {
  const w = new MtfImportWorkspace(); const p = await w.preview(syntheticMtfImportCsv(), metadata, 'a.csv');
  assert.throws(() => w.confirm(p.id, [{ rowId: p.rows[0].id, mode: 'ACCEPT_UNVERIFIED' }, { rowId: p.rows[8].id, mode: 'ACCEPT_UNVERIFIED' }], at));
  assert.equal(w.records.length, 0);
  const receipt = w.confirm(p.id, [{ rowId: p.rows[0].id, mode: 'ACCEPT_UNVERIFIED' }, { rowId: p.rows[8].id, mode: 'REVIEW' }], at);
  assert.equal(receipt.recordIds.length, 2); assert.equal(w.records[1].disposition, 'NEEDS_REVIEW');
  assert.ok(w.records.every(r => r.evidence === 'IMPORTED_UNVERIFIED'));
});

test('MTF duplicate import and confirmation retries do not create repeated records', async () => {
  const w = new MtfImportWorkspace(); const p = await w.preview(simple(), metadata, 'a.csv');
  const selected = [{ rowId: p.rows[0].id, mode: 'ACCEPT_UNVERIFIED' as const }];
  const receipt = w.confirm(p.id, selected, at);
  const again = await w.preview(simple(), metadata, 'different-name.csv'); assert.equal(again.id, p.id);
  assert.deepEqual(w.confirm(again.id, selected, at), receipt); assert.equal(w.records.length, 1);
  const reformatted = await w.preview(simple().replaceAll('\n', '\r\n'), metadata, 'b.csv');
  assert.throws(() => w.confirm(reformatted.id, [{ rowId: reformatted.rows[0].id, mode: 'REVIEW' }], at));
  assert.equal(w.records.length, 1);
  assert.throws(() => w.correct(p.id, p.rows[0].id, { quantity: '20' }, 'change', at));
});

test('MTF duplicated rows and multiple same-symbol purchases require review, not symbol-only matching', async () => {
  const csv = `${simple()}\nSYN-ONE,08/01/2025,50,10,#N/A\nSYN-ONE,08/02/2025,50,20,#N/A`;
  const w = new MtfImportWorkspace(); const p = await w.preview(csv, metadata, 'a.csv');
  assert.ok(p.rows[0].issues.some(i => i.code === 'DUPLICATE_ROW'));
  assert.ok(p.rows.every(r => r.issues.some(i => i.code === 'AMBIGUOUS_LOT_MAPPING')));
  assert.throws(() => w.confirm(p.id, p.rows.slice(0, 2).map(r => ({ rowId: r.id, mode: 'REVIEW' })), at));
  assert.equal(w.records.length, 0);
});

test('MTF returned previews and records are detached; editing them cannot bypass validation', async () => {
  const w = new MtfImportWorkspace(); const p = await w.preview(syntheticMtfImportCsv(), metadata, 'a.csv');
  p.rows[8].issues = []; p.rows[8].fields.exitDate = '08/25/2025';
  assert.throws(() => w.confirm(p.id, [{ rowId: p.rows[8].id, mode: 'ACCEPT_UNVERIFIED' }], at));
  w.confirm(p.id, [{ rowId: p.rows[0].id, mode: 'REVIEW' }], at);
  const records = w.records; records[0].row.parsed.symbol = 'MUTATED'; assert.notEqual(w.records[0].row.parsed.symbol, 'MUTATED');
});

test('MTF confirmation history rejects unknown rows, duplicate selections and backdated corrections', async () => {
  const w = new MtfImportWorkspace(); const p = await w.preview(simple(), metadata, 'a.csv');
  w.correct(p.id, p.rows[0].id, { quantity: '11' }, 'Quantity correction', at);
  assert.throws(() => w.correct(p.id, p.rows[0].id, { quantity: '12' }, 'Backdated', '2025-08-31T10:00:00Z'));
  assert.throws(() => w.confirm(p.id, [{ rowId: 'unknown', mode: 'REVIEW' }], at));
  assert.throws(() => w.confirm(p.id, [{ rowId: p.rows[0].id, mode: 'REVIEW' }, { rowId: p.rows[0].id, mode: 'REVIEW' }], at));
});

test('MTF missing-symbol rows are retained as rejected candidates rather than silently dropped', async () => {
  const p = await new MtfImportWorkspace().preview('Scrip,Buy Date,Buy Price,No of Shares\n,08/01/2025,50,10', metadata, 'a.csv');
  assert.equal(p.rows.length, 1); assert.ok(p.rows[0].issues.some(i => i.code === 'INVALID_SYMBOL'));
});

test('MTF export neutralizes formula prefixes even with whitespace, commas, quotes and newlines', () => {
  const cells = ['=1+1', '+cmd', '-cmd', '@SUM(1)', '   =cmd', '\tformula', 'safe,"text"', 'safe\ntext'];
  const result = parseMtfCsv(exportMtfCsv([cells]))[0];
  for (let i = 0; i < 6; i++) assert.ok(result[i].startsWith("'"));
  assert.deepEqual(result.slice(6), cells.slice(6));
});

test('MTF metadata requires explicit account, broker and valid snapshot date; scope isolates duplicates', async () => {
  const w = new MtfImportWorkspace();
  await assert.rejects(w.preview(simple(), { ...metadata, snapshotDate: '2025-02-30' }, 'a.csv'));
  await assert.rejects(w.preview(simple(), { ...metadata, accountId: '' }, 'a.csv'));
  const p = await w.preview(simple(), metadata, 'a.csv'); w.confirm(p.id, [{ rowId: p.rows[0].id, mode: 'REVIEW' }], at);
  const other = await w.preview(simple(), { ...metadata, accountId: 'other-local-account' }, 'a.csv');
  w.confirm(other.id, [{ rowId: other.rows[0].id, mode: 'REVIEW' }], at); assert.equal(w.records.length, 2);
  w.clear(); assert.deepEqual(w.previews, []); assert.equal(w.records.length, 0);
});

test('MTF numeric-only footer rows are skipped without dropping missing-symbol trade evidence', async () => {
  const csv = 'Scrip,Buy Date,Buy Price,No of Shares,Invested amount\nSYN-ONE,08/01/2025,50,10,500\n,,,,500\n,08/01/2025,50,10,500';
  const p = await new MtfImportWorkspace().preview(csv, metadata, 'a.csv');
  assert.equal(p.rows.length, 2); assert.ok(p.skipped.some(s => s.reason === 'FOOTER'));
  assert.ok(p.rows[1].issues.some(i => i.code === 'INVALID_SYMBOL'));
});

test('MTF irregular column counts remain visible and block automatic acceptance', async () => {
  const w = new MtfImportWorkspace(); const p = await w.preview(`${simple()},unexpected-private-cell`, metadata, 'a.csv');
  assert.equal(p.rows[0].raw.at(-1), 'unexpected-private-cell');
  assert.ok(p.rows[0].issues.some(i => i.code === 'COLUMN_COUNT_MISMATCH'));
  assert.throws(() => w.confirm(p.id, [{ rowId: p.rows[0].id, mode: 'ACCEPT_UNVERIFIED' }], at));
});

test('MTF decimal parser rejects malformed grouping, exponent notation and fractional shares', async () => {
  for (const [price, quantity] of [['"12,34"', '10'], ['1e3', '10'], ['50', '1.5']]) {
    const p = await new MtfImportWorkspace().preview(`Scrip,Buy Date,Buy Price,No of Shares\nSYN-ONE,08/01/2025,${price},${quantity}`, metadata, 'a.csv');
    assert.equal(p.rows[0].confidence, 'NEEDS_REVIEW');
  }
});

test('MTF concurrent previews share one job and retain corrected audit evidence', async () => {
  const w = new MtfImportWorkspace(); const [a, b] = await Promise.all([w.preview(simple(), metadata, 'a.csv'), w.preview(simple(), metadata, 'b.csv')]);
  assert.equal(a.id, b.id); assert.equal(w.previews.length, 1);
  w.correct(a.id, a.rows[0].id, { quantity: '12' }, 'Synthetic quantity correction', at);
  const reloaded = await w.preview(simple(), metadata, 'renamed.csv'); assert.equal(reloaded.corrections.length, 1);
  assert.equal(reloaded.rows[0].parsed.quantity, 12);
});

test('MTF zero quote/exit prices and fractional day counts are blocked, not accepted as legitimate prices', async () => {
  const p = await new MtfImportWorkspace().preview('Scrip,Buy Date,Buy Price,No of Shares,Current Price,Sell Price,No of Days\nSYN-ONE,08/01/2025,50,10,0,0,1.5', metadata, 'a.csv');
  for (const code of ['INVALID_QUOTE_PRICE', 'INVALID_SELL_PRICE', 'INVALID_DAY_COUNT']) assert.ok(p.rows[0].issues.some(i => i.code === code));
  assert.equal(p.rows[0].parsed.values.currentPrice, null);
});
