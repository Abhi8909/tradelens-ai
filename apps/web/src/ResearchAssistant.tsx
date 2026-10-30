import { useState, type FormEvent } from 'react';
import type { StockSummary } from '../../../packages/core/src/types.ts';
import type { runResearch } from '../../api/src/research.ts';

type Report = Awaited<ReturnType<typeof runResearch>>;
export default function ResearchAssistant({ stocks }: { stocks: StockSummary[] }) {
  const [symbol, setSymbol] = useState('');
  const [thesis, setThesis] = useState('');
  const [direction, setDirection] = useState('rising');
  const [action, setAction] = useState('review');
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setReport(null);
    try {
      const response = await fetch('/api/research', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbol: symbol || stocks[0]?.symbol, thesis, direction, action }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Research unavailable');
      setReport(body);
    } catch (e) { setError(e instanceof Error ? e.message : 'Research unavailable'); }
    finally { setBusy(false); }
  }
  return <div className="panel lab-form"><h3>Grounded research assistant</h3>
    <p className="muted">Review descriptive price evidence, or argue against a directional thesis. The default provider is an offline mock. This does not retrieve filings or news.</p>
    <p className="muted">Submitting sends your hypothesis to the API and its configured research provider. Reports are not saved on the server.</p>
    <form onSubmit={submit}><div className="form-grid">
      <label className="form-field">Instrument<select value={symbol || stocks[0]?.symbol || ''} onChange={e => setSymbol(e.target.value)}>{stocks.map(s => <option key={s.symbol}>{s.symbol}</option>)}</select></label>
      <label className="form-field">Thesis direction<select value={direction} onChange={e => setDirection(e.target.value)}><option value="rising">Rising</option><option value="falling">Falling</option></select></label>
      <label className="form-field">Hypothesis<textarea required maxLength={2000} value={thesis} onChange={e => setThesis(e.target.value)}/></label>
      <label className="form-field">Research action<select value={action} onChange={e => setAction(e.target.value)}><option value="review">Review evidence</option><option value="argue-against">Argue against my thesis</option></select></label>
    </div><button className="primary" disabled={busy || !stocks.length}>{busy ? 'Retrieving evidence…' : 'Research thesis'}</button></form>
    {error && <p role="alert" className="error">{error}</p>}
    {report && <section aria-live="polite"><h4>Evidence for {report.input.symbol} · {report.provider}</h4><p>Hypothesis reviewed: {report.input.thesis} ({report.input.direction})</p><p>{report.limitation}</p>
      {report.warnings.map(w => <p key={w}>{w}</p>)}
      {report.contradictory && <p>Trend and momentum disagree. Both observations are retained in the evidence record.</p>}
      {!report.citations.length && <p>No qualifying evidence found. This does not confirm the thesis.</p>}
      {report.citations.map(c => <article key={c.id}><p>{c.statement}</p><small>Citation: {c.id} · calculation: {c.tool}</small></article>)}
      <p>Source: {report.provenance.providerId} · {report.provenance.kind} · {report.provenance.exchange} · License: {report.provenance.license}</p>
      <p>Observed: {report.provenance.observedAt ?? 'unknown'} · Ingested: {report.provenance.ingestedAt}</p>
      <p style={{ overflowWrap: 'anywhere' }}>Input data version (SHA-256): {report.version}</p>
    </section>}
  </div>;
}
