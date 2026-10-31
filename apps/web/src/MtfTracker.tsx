import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Plus, RefreshCw, Pencil, Wallet, TrendingUp, Receipt, CalendarDays, Info } from 'lucide-react';
import { calculateManualMtf, MANUAL_MTF_STORAGE_KEY, parseManualMtfStorage, summarizeManualMtf, validateManualMtfPosition, type ManualMtfPosition } from '../../../packages/core/src/mtf/manual.ts';
import { D, istDay } from '../../../packages/core/src/mtf/decimal.ts';
import type { MtfPrice } from '../../api/src/mtfQuotes.ts';

const inr = (value: string | null) => {
  if (value === null) return '—';
  const fixed = new D(value).toFixed(2); const [whole, fraction] = fixed.replace('-', '').split('.');
  return `${fixed.startsWith('-') ? '-' : ''}₹${new Intl.NumberFormat('en-IN').format(BigInt(whole))}.${fraction}`;
};
type QuoteState = 'LIVE' | 'DELAYED' | 'EOD' | 'MANUAL' | 'STALE' | 'UNAVAILABLE';
function PriceQuote({ price, source, state, at, closed }: { price: string | null; source: string; state: QuoteState; at: string | null; closed: boolean }) {
  if (closed) return <div className="mtf-quote mtf-quote-exited"><strong>—</strong><span>Exited position</span></div>;
  const label = source.startsWith('NSE official MCP') ? 'NSE' : state === 'MANUAL' ? 'Manual entry' : state === 'UNAVAILABLE' ? 'No quote' : 'Market feed';
  const status = { LIVE: 'Live', DELAYED: 'Delayed', EOD: 'LTP', MANUAL: 'Unverified', STALE: 'Stale', UNAVAILABLE: 'Unavailable' }[state];
  return <div className="mtf-quote">
    <strong className="mtf-quote-value">{inr(price)}</strong>
    <div className="mtf-quote-meta">
      <details className="mtf-quote-source"><summary aria-label={`Price source details: ${label}`}>{label}<Info size={13} aria-hidden="true"/></summary><div className="mtf-quote-provenance">{source}{state === 'EOD' && <span>Last traded price · end-of-day observation</span>}{at && <span>{new Date(at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</span>}</div></details>
      <span className={`mtf-quote-badge mtf-quote-${state.toLowerCase()}`}>{status}</span>
    </div>
  </div>;
}
const percent = (value: string | null) => value === null ? '—' : `${Number(value) > 0 ? '+' : ''}${value}%`;
const color = (value: string | null) => value === null ? '' : Number(value) < 0 ? 'down' : Number(value) > 0 ? 'up' : '';
const readableError = (error: unknown) => {
  const message = error instanceof Error ? error.message : 'Could not save position';
  return ({ INVALID_INPUT: 'Check the NSE scrip symbol and numeric amounts.', INVALID_CHRONOLOGY: 'Dates must run from purchase through exit, with neither date after today.', INVALID_QUANTITY: 'Quantity must be a positive whole number.' } as Record<string, string>)[message] ?? message;
};
const emptyForm = { symbol: '', boughtDate: '', quantity: '', buyPriceInr: '', interestPerDayInr: '', otherChargesInr: '0', currentPrice: '', exitDate: '' };
function load(today: string) {
  try { const raw = localStorage.getItem(MANUAL_MTF_STORAGE_KEY); return { rows: parseManualMtfStorage(raw, today), raw, error: '' }; }
  catch { return { rows: [] as ManualMtfPosition[], raw: null, error: 'Saved MTF data cannot be read safely. It has not been overwritten. Restore your browser data or download a backup before repairing it.' }; }
}
export default function MtfTracker({ active }: { active: boolean }) {
  const [now, setNow] = useState(() => new Date()); const today = istDay(now.toISOString());
  const [initial] = useState(() => load(today)); const [positions, setPositions] = useState(initial.rows);
  const stored = useRef(initial.raw); const [storageError, setStorageError] = useState(initial.error);
  const [form, setForm] = useState(emptyForm); const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState(''); const [prices, setPrices] = useState<Record<string, MtfPrice>>({});
  const [priceError, setPriceError] = useState(''); const [refreshing, setRefreshing] = useState(false); const [refreshKey, setRefreshKey] = useState(0);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const symbols = JSON.stringify([...new Set(positions.filter(p => !p.exitDate).map(p => p.symbol))].sort());
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    function changed(event: StorageEvent) {
      if (event.key !== MANUAL_MTF_STORAGE_KEY && event.key !== null) return;
      const next = load(istDay(new Date().toISOString()));
      if (next.error) setStorageError(next.error);
      else { setPositions(next.rows); stored.current = next.raw; setStorageError(''); setEditing(null); setForm(emptyForm); }
    }
    window.addEventListener('storage', changed); return () => window.removeEventListener('storage', changed);
  }, []);
  useEffect(() => {
    if (!active || symbols === '[]') return;
    const controller = new AbortController(); let running = false;
    async function refresh() {
      if (running) return; running = true; setRefreshing(true);
      try {
        const response = await fetch('/api/mtf/quotes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbols: JSON.parse(symbols) }), signal: controller.signal });
        const body = await response.json(); if (!response.ok) throw new Error(body.error ?? 'Price refresh failed');
        if (!controller.signal.aborted) {
          setPrices(Object.fromEntries((body.quotes as MtfPrice[]).map(q => [q.symbol, q])));
          setPriceError(body.unavailable?.length ? `No quote for: ${body.unavailable.join(', ')}. Enter a current price manually.` : '');
          setLastRefresh(new Date().toISOString()); setNow(new Date());
        }
      } catch (e) { if (!controller.signal.aborted) setPriceError(e instanceof Error ? e.message : 'Price refresh failed'); }
      finally { running = false; if (!controller.signal.aborted) setRefreshing(false); }
    }
    void refresh(); const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 150_000);
    function visible() { if (!document.hidden) void refresh(); }
    document.addEventListener('visibilitychange', visible);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [symbols, active, refreshKey]);
  function backup() {
    try {
      const raw = localStorage.getItem(MANUAL_MTF_STORAGE_KEY) ?? JSON.stringify({ version: 1, positions: [] });
      const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'mtf-private-backup.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setError('Could not download browser backup.'); }
  }
  function save(next: ManualMtfPosition[]) {
    if (storageError) throw new Error(storageError);
    if (localStorage.getItem(MANUAL_MTF_STORAGE_KEY) !== stored.current) throw new Error('MTF data changed in another tab. Reload before saving.');
    const serialized = JSON.stringify({ version: 1, positions: next });
    localStorage.setItem(MANUAL_MTF_STORAGE_KEY, serialized); stored.current = serialized; setPositions(next);
  }
  function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    try {
      if (!editing && positions.length >= 50) throw new Error('This local tracker supports up to 50 positions.');
      const previous = positions.find(p => p.id === editing);
      const manualPrice = form.currentPrice ? { priceInr: form.currentPrice, at: previous?.manualPrice?.priceInr === form.currentPrice ? previous.manualPrice.at : new Date().toISOString() } : null;
      const position: ManualMtfPosition = { id: editing ?? crypto.randomUUID(), symbol: form.symbol.trim().toUpperCase(), boughtDate: form.boughtDate, quantity: Number(form.quantity), buyPriceInr: form.buyPriceInr, interestPerDayInr: form.interestPerDayInr, otherChargesInr: form.otherChargesInr, exitDate: form.exitDate || null, manualPrice };
      validateManualMtfPosition(position, today);
      save(editing ? positions.map(p => p.id === editing ? position : p) : [...positions, position]); setForm(emptyForm); setEditing(null);
    } catch (e) { setError(`Could not save: ${readableError(e)}`); }
  }
  const rows = positions.map(position => {
    const quote = prices[position.symbol]; const age = quote ? now.getTime() - Date.parse(quote.marketAt) : Infinity;
    const fresh = quote && age >= 0 && age <= (quote.mode === 'EOD' ? 86_400_000 : 300_000);
    const manual = position.manualPrice;
    const current = fresh ? quote.priceInr : manual?.priceInr ?? null;
    return { position, result: calculateManualMtf(position, today, current), current,
      source: fresh ? quote.source : manual ? 'Manual entry · unverified' : quote ? quote.source : 'Price unavailable',
      quoteState: (fresh ? quote.mode : manual ? 'MANUAL' : quote ? 'STALE' : 'UNAVAILABLE') as QuoteState,
      priceAt: fresh ? quote.marketAt : manual?.at ?? quote?.marketAt ?? null };
  });
  const summary = summarizeManualMtf(rows.map(r => r.result));
  function field(key: keyof typeof form, label: string, type = 'number', required = true) {
    return <label>{label}<input required={required} type={type} step={key === 'quantity' ? '1' : '0.01'} min={type === 'number' ? (key === 'quantity' ? '1' : ['buyPriceInr', 'currentPrice'].includes(key) ? '0.01' : '0') : undefined} max={type === 'date' ? today : undefined} value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}/></label>;
  }
  return <div className="mtf-tracker">
    <div className="mtf-heading"><div><p className="eyebrow">YOUR POSITIONS · BROWSER LOCAL</p><h2>MTF portfolio</h2><p>As of {today} · Asia/Kolkata · flat daily-interest estimates</p></div><button className="mtf-secondary" disabled={refreshing || symbols === '[]'} onClick={() => setRefreshKey(k => k + 1)}><RefreshCw size={16}/>{refreshing ? 'Refreshing…' : 'Refresh prices'}</button></div>
    <button className="mtf-secondary mtf-backup" onClick={backup}>Download private backup</button>
    <p className="mtf-notice">Saved only in this browser. Only open scrip symbols are sent for prices. Prices refresh every 2½ minutes while this screen is open. NSE quotes are delayed, informational and for non-commercial use. Daily interest and charges are your estimates, not reconciled broker costs.</p>
    {storageError && <p className="error-panel" role="alert">{storageError}</p>}
    <section className="mtf-cards" aria-label="Open MTF totals">{[
      ['Open invested amount', inr(summary.investedInr), Wallet], ['Interest till now', inr(summary.interestInr), CalendarDays],
      ['Total charges', inr(summary.chargesInr), Receipt], ['Open net P/L', inr(summary.pnlInr), TrendingUp]
    ].map(([label, value, Icon]) => { const CardIcon = Icon as typeof Wallet; return <div className="panel mtf-card" key={String(label)}><span><CardIcon size={18}/>{String(label)}</span><strong className={label === 'Open net P/L' ? color(summary.pnlInr) : ''}>{String(value)}</strong>{label === 'Open net P/L' && <small className={color(summary.pnlPct)}>{percent(summary.pnlPct)} on cost including charges</small>}</div>; })}</section>
    <p className="mtf-coverage">{summary.count} open positions · {summary.priced}/{summary.count} priced{!summary.complete && ' · Totals are incomplete until every open position has a current price.'}{lastRefresh && ` · Last feed refresh ${new Date(lastRefresh).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`}</p>
    {summary.count > 0 && priceError && <p role="status" className="mtf-price-note">{priceError}</p>}
    <section className="panel mtf-editor"><h3>{editing ? 'Edit position' : 'Add a scrip'}</h3><form onSubmit={submit}><div className="mtf-form-grid">
      {field('symbol', 'Scrip symbol', 'text')}{field('boughtDate', 'Bought date', 'date')}{field('quantity', 'Quantity')}{field('buyPriceInr', 'Buying price (₹ / share)')}
      {field('interestPerDayInr', 'Interest per day (₹)')}{field('otherChargesInr', 'Other charges (₹)')}{field('currentPrice', 'Current price (₹, optional manual)', 'number', false)}{editing && field('exitDate', 'Exit date (optional)', 'date', false)}
    </div><p className="mtf-form-hint">Days = calendar days since purchase (purchase day = 0). Interest = days × daily amount. Highlighted adjusted price = (invested amount + charges) ÷ quantity.</p>
      <div className="mtf-form-actions"><button className="primary" disabled={!!storageError}><Plus size={16}/>{editing ? 'Save changes' : 'Add position'}</button>{editing && <button type="button" className="mtf-secondary" onClick={() => { setEditing(null); setForm(emptyForm); }}>Cancel edit</button>}</div></form>
    </section>
    {error && <p role="alert" className="error-panel">{error}</p>}
    <section className="panel mtf-positions"><div className="section-head"><h3>Positions</h3><span className="tag">Open + exited history</span></div>
      {!positions.length ? <div className="mtf-empty"><Wallet size={32}/><h3>Your positions will appear here</h3><p>Add a scrip above. No CSV upload is needed.</p></div> : <div className="table-scroll"><table className="mtf-position-table"><caption>Estimated charges and P/L. Exited rows are excluded from all open totals.</caption><thead><tr>{['Scrip / status', 'Bought / days', 'Qty', 'Buy price', 'Adjusted buy price', 'Current price', 'Net P/L', 'P/L %', 'Invested', 'Daily interest', 'Interest till now', 'Other charges', 'Total charges'].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{rows.map(({ position: p, result: r, current, source, quoteState, priceAt }) => <tr key={p.id} className={r.closed ? 'mtf-closed' : ''}>
        <td><strong>{p.symbol}</strong><span className={`mtf-status ${r.closed ? 'closed' : ''}`}>{r.closed ? 'EXITED' : 'OPEN'}</span><button className="mtf-edit" aria-label={`Edit ${p.symbol}`} onClick={() => { setEditing(p.id); setForm({ symbol: p.symbol, boughtDate: p.boughtDate, quantity: String(p.quantity), buyPriceInr: p.buyPriceInr, interestPerDayInr: p.interestPerDayInr, otherChargesInr: p.otherChargesInr, currentPrice: p.manualPrice?.priceInr ?? '', exitDate: p.exitDate ?? '' }); }}><Pencil size={13}/> Edit</button></td>
        <td>{p.boughtDate}<small>{r.days} days{r.closed && ' · frozen at exit'}</small></td><td>{p.quantity}</td><td>{inr(p.buyPriceInr)}</td>
        <td className="mtf-adjusted"><strong>{inr(r.adjustedBuyPriceInr)}</strong><small>₹{r.adjustedBuyPriceInr} / share</small></td><td className="mtf-quote-cell"><PriceQuote price={current} source={source} state={quoteState} at={priceAt} closed={r.closed}/></td><td className={r.closed ? '' : color(r.pnlInr)}>{inr(r.pnlInr)}</td><td className={r.closed ? '' : color(r.pnlPct)}>{percent(r.pnlPct)}</td><td>{inr(r.investedInr)}</td><td>{inr(p.interestPerDayInr)}</td><td>{inr(r.interestInr)}</td><td>{inr(p.otherChargesInr)}</td><td>{inr(r.totalChargesInr)}</td>
      </tr>)}</tbody><tfoot><tr><td colSpan={4}>OPEN TOTALS</td><td colSpan={2}>{summary.priced}/{summary.count} priced</td><td className={color(summary.pnlInr)}>{inr(summary.pnlInr)}</td><td className={color(summary.pnlPct)}>{percent(summary.pnlPct)}</td><td>{inr(summary.investedInr)}</td><td>—</td><td>{inr(summary.interestInr)}</td><td>—</td><td>{inr(summary.chargesInr)}</td></tr></tfoot></table></div>}
    </section>
  </div>;
}
