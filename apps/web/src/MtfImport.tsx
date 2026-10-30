import { useEffect, useState, type FormEvent } from 'react';
import { MTF_IMPORT_FIELDS, MTF_IMPORT_LIMITS, MtfImportWorkspace, exportMtfCsv, syntheticMtfImportCsv, type MtfImportField, type MtfImportPreview, type MtfImportSelection } from '../../../packages/core/src/mtf/index.ts';

function download(content: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function MtfImport() {
  const [workspace] = useState(() => new MtfImportWorkspace());
  const [preview, setPreview] = useState<MtfImportPreview | null>(null);
  const [account, setAccount] = useState(''); const [broker, setBroker] = useState(''); const [snapshotDate, setSnapshotDate] = useState('');
  const [dateFormat, setDateFormat] = useState<'MM/DD/YYYY' | 'ISO'>('MM/DD/YYYY');
  const [file, setFile] = useState<File | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [selection, setSelection] = useState<Record<string, MtfImportSelection['mode'] | ''>>({});
  const [rowId, setRowId] = useState(''); const [field, setField] = useState<MtfImportField>('buyDate'); const [value, setValue] = useState(''); const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false); const [message, setMessage] = useState('');
  useEffect(() => {
    if (!preview) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [preview]);
  function show(next: MtfImportPreview) {
    setPreview(next); setRowId(next.rows[0]?.id ?? ''); setSelection({}); setConfirmed(workspace.records.some(r => r.previewId === next.id)); setMessage(workspace.records.some(r => r.previewId === next.id) ? 'This file was already confirmed locally; no duplicate records added.' : ''); setError('');
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (!file) throw new Error('Choose a CSV file');
      if (file.size > MTF_IMPORT_LIMITS.bytes) throw new Error('FILE_TOO_LARGE');
      show(await workspace.preview(await file.text(), { tenantId: 'browser-local', accountId: account.trim(), broker: broker.trim(), snapshotDate, dateFormat }, file.name));
    } catch (e) { setError(e instanceof Error ? e.message : 'Import preview failed'); }
    finally { setBusy(false); }
  }
  async function loadDemo() {
    setBusy(true); setError('');
    try {
      setAccount('synthetic-account'); setBroker('Synthetic broker'); setSnapshotDate('2025-08-31'); setDateFormat('MM/DD/YYYY');
      show(await workspace.preview(syntheticMtfImportCsv(), { tenantId: 'browser-local', accountId: 'synthetic-account', broker: 'Synthetic broker', snapshotDate: '2025-08-31', dateFormat: 'MM/DD/YYYY' }, 'synthetic-mtf-demo.csv'));
    } catch (e) { setError(e instanceof Error ? e.message : 'Demo unavailable'); }
    finally { setBusy(false); }
  }
  const selectedRow = preview?.rows.find(row => row.id === rowId);
  function correct(event: FormEvent) {
    event.preventDefault(); if (!preview) return;
    try { setPreview(workspace.correct(preview.id, rowId, { [field]: value }, reason, new Date().toISOString())); setReason(''); setMessage('Correction recorded; original raw cells retained.'); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'Correction failed'); }
  }
  function confirm() {
    if (!preview) return;
    try {
      const rows = Object.entries(selection).filter(([, mode]) => mode).map(([rowId, mode]) => ({ rowId, mode: mode as MtfImportSelection['mode'] }));
      const receipt = workspace.confirm(preview.id, rows, new Date().toISOString());
      setConfirmed(true); setMessage(`Confirmed ${receipt.recordIds.length} rows locally as imported/unverified. No trades or portfolio totals were created.`); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Confirmation failed; no rows saved'); }
  }
  function clear() { workspace.clear(); setPreview(null); setFile(null); setMessage('Local import data cleared.'); setError(''); }
  return <div className="mtf-import">
    <section className="panel mtf-import-card"><div className="section-head"><h3>Local CSV import</h3><span className="tag">Phase 2 · Imported unverified</span></div>
      <p>Preview, correct and confirm spreadsheet evidence. Files stay in browser memory and are never uploaded. Download your private audit before refreshing or closing this page. Confirmed records are not restored after a reload.</p>
      <form onSubmit={submit}><div className="mtf-import-grid">
        <label>Account label<input required maxLength={120} value={account} onChange={e => setAccount(e.target.value)}/></label>
        <label>Broker label<input required maxLength={120} value={broker} onChange={e => setBroker(e.target.value)}/></label>
        <label>Snapshot date<input required type="date" value={snapshotDate} onChange={e => setSnapshotDate(e.target.value)}/></label>
        <label>CSV date format<select value={dateFormat} onChange={e => setDateFormat(e.target.value as typeof dateFormat)}><option value="MM/DD/YYYY">MM/DD/YYYY (ISO also accepted)</option><option value="ISO">ISO YYYY-MM-DD only</option></select></label>
        <label>Positions CSV (max 1 MiB)<input type="file" accept=".csv,text/csv" onChange={e => setFile(e.target.files?.[0] ?? null)}/></label>
      </div><div className="mtf-import-actions"><button className="primary" disabled={busy}>{busy ? 'Parsing…' : 'Preview CSV'}</button><button type="button" className="text-btn" disabled={busy} onClick={loadDemo}>Load synthetic example</button></div></form>
      <p>Snapshot date and account are explicit inputs. The filename is never used to infer dates, broker rules, or ownership.</p>
    </section>
    {error && <p role="alert" className="error-panel">{error}</p>}
    {message && <p role="status">{message}</p>}
    {preview && <>
      <section className="panel mtf-import-card"><h3>Import preview: {preview.rows.length} candidate rows</h3>
        <p>{preview.filename} · Snapshot {preview.metadata.snapshotDate} · {preview.metadata.broker} · {preview.metadata.accountId}</p>
        <p>{preview.rows.filter(r => r.issues.some(i => i.code === 'INVALID_CHRONOLOGY')).length} rows with invalid chronology. {preview.skipped.length} blank/footer records skipped.</p>
        <p className="mtf-fingerprint">SHA-256: {preview.checksum} · {preview.importerVersion}</p>
        <p>Funding, instruments and broker statements remain unverified. Exit dates and conversion notes require matching evidence; they never finalize a closed or converted trade.</p>
        {preview.issues.map((issue, i) => <p key={i}>{issue.code}</p>)}
        <div className="table-scroll"><table className="risk-table mtf-preview-table"><caption>Private imported positions; no live prices or reconciled charges</caption><thead><tr><th>CSV record / scrip</th><th>Buy / exit date</th><th>Qty / buy price (₹)</th><th>Lifecycle hint</th><th>Validation</th><th>Selection</th></tr></thead><tbody>
          {preview.rows.map(row => <tr key={row.id}><td><button className="text-btn" onClick={() => { setRowId(row.id); setValue(row.fields[field] ?? ''); }}>Record {row.recordNumber}: {row.parsed.symbol || 'Missing scrip'}</button></td>
            <td>{row.parsed.buyDate ?? 'Invalid'}<br/>{row.parsed.exitDate ?? 'No exit'}</td><td>{row.parsed.quantity ?? 'Invalid'} / {row.parsed.values.buyPrice ?? 'Invalid'}</td>
            <td>{row.parsed.lifecycleHint}<br/><strong>{row.confidence}</strong></td><td><details><summary>{row.issues.filter(i => i.severity === 'ERROR').length} errors / {row.issues.filter(i => i.severity === 'WARNING').length} warnings</summary><ul>{row.issues.map((issue, i) => <li key={i}>{issue.severity}: {issue.code}{issue.field ? ` (${issue.field})` : ''}</li>)}</ul></details></td>
            <td><select aria-label={`Selection for record ${row.recordNumber}`} disabled={confirmed} value={selection[row.id] ?? ''} onChange={e => setSelection(current => ({ ...current, [row.id]: e.target.value as MtfImportSelection['mode'] | '' }))}><option value="">Skip</option><option value="REVIEW">Import for review</option><option value="ACCEPT_UNVERIFIED" disabled={row.issues.some(i => i.severity === 'ERROR')}>Accept unverified</option></select></td></tr>)}
        </tbody></table></div>
        <div className="mtf-import-actions"><button className="primary" disabled={confirmed || !Object.values(selection).some(Boolean)} onClick={confirm}>Confirm selected rows locally</button><button className="text-btn" onClick={() => download(JSON.stringify({ previews: workspace.previews, records: workspace.records }, null, 2), 'mtf-private-audit.json', 'application/json')}>Download private audit</button><button className="text-btn" onClick={() => download(exportMtfCsv([['Record', 'Scrip', 'Evidence', 'Issues'], ...preview.rows.map(row => [String(row.recordNumber), row.parsed.symbol, 'IMPORTED_UNVERIFIED', row.issues.map(i => i.code).join('; ')])]), 'mtf-validation.csv', 'text/csv')}>Export validation CSV</button><button className="text-btn" onClick={clear}>Clear local data</button></div>
      </section>
      {selectedRow && <section className="panel mtf-import-card"><h3>Inspect and correct record {selectedRow.recordNumber}</h3>
        <form onSubmit={correct}><div className="mtf-import-grid"><label>Correction field<select disabled={confirmed} value={field} onChange={e => { const f = e.target.value as MtfImportField; setField(f); setValue(selectedRow.fields[f] ?? ''); }}>{MTF_IMPORT_FIELDS.map(f => <option key={f}>{f}</option>)}</select></label>
          <label>Corrected value<small>Current staged value: {selectedRow.fields[field] || '(blank)'}</small><input disabled={confirmed} value={value} onChange={e => setValue(e.target.value)}/></label><label>Correction reason<input required disabled={confirmed} maxLength={500} value={reason} onChange={e => setReason(e.target.value)}/></label></div><button className="primary" disabled={confirmed}>Record correction</button></form>
        <h4>Imported vs recomputed spreadsheet values</h4><p>These checks explain spreadsheet arithmetic, not actual broker funding, fees or realized P&amp;L.</p>
        <div className="table-scroll"><table className="risk-table"><thead><tr><th>Field</th><th>Imported</th><th>Recomputed</th><th>Delta</th><th>Method</th></tr></thead><tbody>{selectedRow.reconciliation.map(item => <tr key={item.field}><td>{item.field}</td><td>{item.imported}</td><td>{item.recomputed}</td><td>{item.delta}</td><td>{item.method}</td></tr>)}</tbody></table></div>
        <details><summary>Original raw cells (private)</summary><pre>{JSON.stringify({ headers: preview.headers, cells: selectedRow.raw }, null, 2)}</pre></details>
        <h4>Correction history</h4>{preview.corrections.filter(c => c.rowId === rowId).map((c, i) => <p key={i}>{c.at}: {c.field} “{c.before}” → “{c.after}” · {c.reason}</p>)}
      </section>}
    </>}
  </div>;
}
