import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Plus, RefreshCw, Wallet, TrendingUp, Receipt, CalendarDays, Database, Search, Download, Settings2, ShieldCheck, ArrowUpRight, Pencil } from 'lucide-react';
import { D, istDay } from '../../../packages/core/src/mtf/decimal.ts';
import { MANUAL_MTF_STORAGE_KEY, parseManualMtfStorage } from '../../../packages/core/src/mtf/manual.ts';
import { dailyBurn, type MtfAccount, type PortfolioDocument } from '../../../packages/core/src/mtf/dashboard.ts';
import { PriceQuote, inr } from './MtfQuote.tsx';
import { downloadPrivate, mtfRequest, openMtfWorkspace, type DashboardRow, type MtfUser } from './MtfWorkspace.ts';
import MtfDetails from './MtfDetails.tsx';

type Summary = { openLots: number; quoteCoverage: { valued: number; required: number }; remainingPurchaseCostInr: string | null; openInterestInr: string | null; openIncurredCostsInr: string | null; fundedOutstandingInr: string | null; marketValueInr: string | null; grossUnrealizedPnlInr: string | null; costAdjustedUnrealizedPnlInr: string | null; pnlPct: string | null; dailyInterestInr: string | null; initialOwnFundsInr: string | null; actualInterestInr: string | null; estimatedInterestInr: string | null };
const emptyForm = { symbol: '', boughtDate: '', quantity: '', buyPriceInr: '', interestPerDayInr: '', otherChargesInr: '0', currentPrice: '', exitDate: '', fundedInr: '', dailyRatePct: '', sellFixed: '', sellPct: '', reason: '', isin: '', startOffset: '1', includeExit: 'yes', rounding: 'DAILY:HALF_UP' };
const pct = (v: string | null | undefined) => v == null ? '—' : `${new D(v).gt(0) ? '+' : ''}${v}%`;
const color = (v: string | null | undefined) => v == null ? '' : new D(v).lt(0) ? 'down' : new D(v).gt(0) ? 'up' : '';
const statusLabel = (s: string) => ({ OPEN_MTF: 'OPEN', PARTIALLY_SOLD: 'PARTIAL', CLOSED_SOLD: 'EXITED', CONVERTED_TO_DELIVERY: 'CONVERTED', NEEDS_REVIEW: 'REVIEW' }[s] ?? s);
export default function MtfTracker({ active }: { active: boolean }) {
  const draftId = useRef(crypto.randomUUID());
  const loadSequence = useRef(0);
  const [user, setUser] = useState<MtfUser | null>(null); const [ready, setReady] = useState(false);
  const [accounts, setAccounts] = useState<MtfAccount[]>([]); const [accountId, setAccountId] = useState('');
  const [rows, setRows] = useState<DashboardRow[]>([]); const [summary, setSummary] = useState<Summary | null>(null); const [history, setHistory] = useState<{ at: string; summary: Summary }[]>([]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [note, setNote] = useState('');
  const [form, setForm] = useState(emptyForm); const [editing, setEditing] = useState<PortfolioDocument | null>(null); const [showEditor, setShowEditor] = useState(true);
  const [tab, setTab] = useState('open'); const [search, setSearch] = useState(''); const [sort, setSort] = useState('symbol'); const [page, setPage] = useState(1);
  const [today, setToday] = useState(() => istDay(new Date().toISOString())); const [asOfDay, setAsOfDay] = useState(today); const [selected, setSelected] = useState<string | null>(null);
  const [columns, setColumns] = useState(['quantity', 'adjusted', 'price', 'charges', 'pnl']);
  const [broker, setBroker] = useState<{ configured: boolean; connected: boolean; expiresAt: string | null; lastSync: string | null; holdings: { symbol: string; quantity: number; averagePriceInr: string; isin: string; origin?: string }[] } | null>(null);
  const [showSettings, setShowSettings] = useState(false); const [newAccount, setNewAccount] = useState('');
  const [migrationCount, setMigrationCount] = useState(0); const [migrationError, setMigrationError] = useState('');
  const asOfQuery = asOfDay === today ? '' : `&asOf=${encodeURIComponent(`${asOfDay}T23:59:59.999+05:30`)}`;
  useEffect(() => { const timer = setInterval(() => setToday(istDay(new Date().toISOString())), 30_000); return () => clearInterval(timer); }, []);
  useEffect(() => { if (!active || ready) return; openMtfWorkspace().then(data => { setUser(data.user); setReady(true); }).catch(e => { setError(e.message); setReady(true); }); }, [active, ready]);
  useEffect(() => {
    if (!user) return;
    mtfRequest('accounts', user).then(data => { setAccounts(data.accounts); setAccountId(current => data.accounts.some((a: MtfAccount) => a.id === current) ? current : data.accounts[0]?.id ?? ''); }).catch(e => setError(e.message));
    try { const saved = parseManualMtfStorage(localStorage.getItem(MANUAL_MTF_STORAGE_KEY), today); setMigrationCount(saved.length); } catch { setMigrationError('Browser-saved positions could not be validated. They remain untouched; download their private backup before repair.'); }
  }, [user, today]);
  useEffect(() => {
    loadSequence.current++; setRows([]); setSummary(null); setHistory([]); setBroker(null);
    setSelected(null); setEditing(null); setForm(emptyForm); draftId.current = crypto.randomUUID();
  }, [user?.id, accountId]);
  const load = useCallback(async () => {
    if (!user || !accountId) return;
    const sequence = ++loadSequence.current;
    const result = await mtfRequest(`summary?accountId=${accountId}${asOfQuery}`, user); if (sequence !== loadSequence.current) return; setRows(result.rows); setSummary(result.summary);
    const [timeline, connection] = await Promise.all([mtfRequest(`history?accountId=${accountId}`, user), mtfRequest(`broker/status?accountId=${accountId}`, user)]);
    if (sequence !== loadSequence.current) return; setHistory(timeline.history); setBroker(connection);
  }, [user, accountId, asOfQuery]);
  useEffect(() => { if (active) { setError(''); void load().catch(e => setError(e.message)); } }, [active, load]);
  const refresh = useCallback(async () => {
    if (!user || !accountId) return; setBusy(true);
    try { const result = await mtfRequest('refresh', user, { accountId }); await load(); setNote(result.quoteWarning ?? 'Prices and portfolio snapshot updated.'); }
    catch (e) { setNote(e instanceof Error ? e.message : 'Quote refresh unavailable'); }
    finally { setBusy(false); }
  }, [user, accountId, load]);
  useEffect(() => {
    if (!active || !user || !accountId || asOfDay !== today) return;
    void refresh(); const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 150_000); return () => clearInterval(timer);
  }, [active, user, accountId, asOfDay, today, refresh]);
  async function save(event: FormEvent) {
    event.preventDefault(); if (!user) return; setBusy(true); setError('');
    try {
      const position = { id: editing?.id ?? draftId.current, symbol: form.symbol.trim().toUpperCase(), boughtDate: form.boughtDate, quantity: Number(form.quantity), buyPriceInr: form.buyPriceInr, interestPerDayInr: form.interestPerDayInr, otherChargesInr: form.otherChargesInr, exitDate: form.exitDate || null, manualPrice: form.currentPrice ? { priceInr: form.currentPrice, at: new Date().toISOString() } : null };
      const fees = form.sellFixed !== '' || form.sellPct !== '' ? { id: `user-fees-${Date.now()}`, effectiveFrom: position.boughtDate, effectiveTo: null, source: { kind: 'MANUAL_UNVERIFIED', reference: 'User-estimated sale charges' }, roundingMode: 'HALF_UP', lines: [{ id: 'sale-estimate', kind: 'OTHER', fixedInr: form.sellFixed || '0', turnoverFraction: new D(form.sellPct || '0').div(100).toFixed(), capInr: null }] } : null;
      await mtfRequest(editing ? `positions/${editing.id}` : 'positions', user, { accountId, position, fundedInr: form.fundedInr || null, dailyFraction: form.dailyRatePct ? new D(form.dailyRatePct).div(100).toFixed() : null, sellFees: fees, instrument: form.isin ? { id: `NSE:${form.isin}`, exchange: 'NSE', isin: form.isin.toUpperCase(), symbol: position.symbol, aliases: [] } : undefined, interestPolicy: { startOffsetDays: Number(form.startOffset), includeExitDay: form.includeExit === 'yes', rounding: { timing: form.rounding.split(':')[0], mode: form.rounding.split(':')[1] } }, version: editing?.version, reason: form.reason || 'New manual position' }, editing ? 'PATCH' : 'POST');
      draftId.current = crypto.randomUUID(); setForm(emptyForm); setEditing(null); setShowEditor(false); await load(); setNote('Position saved to your workspace database.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save position'); } finally { setBusy(false); }
  }
  function edit(document: PortfolioDocument) { setEditing(document); const p = document.position; const fees = document.sellFees?.lines[0]; setForm({ ...emptyForm, isin: document.instrument?.isin ?? '', startOffset: String(document.interestPolicy?.startOffsetDays ?? 1), includeExit: document.interestPolicy?.includeExitDay === false ? 'no' : 'yes', rounding: `${document.interestPolicy?.rounding.timing??'DAILY'}:${document.interestPolicy?.rounding.mode??'HALF_UP'}`, symbol: p.symbol, boughtDate: p.boughtDate, quantity: String(p.quantity), buyPriceInr: p.buyPriceInr, interestPerDayInr: p.interestPerDayInr, otherChargesInr: p.otherChargesInr, currentPrice: p.manualPrice?.priceInr ?? '', exitDate: p.exitDate ?? '', fundedInr: document.fundedInr ?? '', dailyRatePct: document.dailyFraction === null ? '' : new D(document.dailyFraction).mul(100).toFixed(), sellFixed: fees?.fixedInr ?? '', sellPct: fees ? new D(fees.turnoverFraction).mul(100).toFixed() : '' }); setShowEditor(true); }
  async function migrate() {
    if (!user) return; setBusy(true); setError('');
    try { const original = localStorage.getItem(MANUAL_MTF_STORAGE_KEY); const positions = parseManualMtfStorage(original, today); await mtfRequest('migrate', user, { accountId, positions: positions.map(position => ({ position })) }, 'POST', `browser-migration-${user.id}-${accountId}`); setMigrationCount(0); await load(); setNote('Browser positions copied to the database. Original browser data is retained as your backup.'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Migration failed; browser data is unchanged'); } finally { setBusy(false); }
  }
  async function brokerAction(action: string) {
    if (!user) return; setBusy(true); setError('');
    try { const result = await mtfRequest(`broker/${action}`, user, { accountId, consent: true }); if (result.url) { window.location.assign(result.url); return; } if(result.warning)setNote(result.warning); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Broker request failed'); } finally { setBusy(false); }
  }
  const display = useMemo(() => {
    const filtered = rows.filter(row => { const state = row.snapshot.status; return (tab === 'all' || tab === 'open' && ['OPEN_MTF', 'PARTIALLY_SOLD'].includes(state) || tab === 'closed' && state === 'CLOSED_SOLD' || tab === 'converted' && state === 'CONVERTED_TO_DELIVERY' || tab === 'review' && (state === 'NEEDS_REVIEW' || row.snapshot.issues.some(i => !['MISSING_QUOTE'].includes(i.code)))) && row.document.position.symbol.toLowerCase().includes(search.toLowerCase()); });
    return filtered.sort((a, b) => sort === 'symbol' ? a.document.position.symbol.localeCompare(b.document.position.symbol) : sort === 'interest' ? new D(b.snapshot.metrics?.openInterestInr ?? 0).cmp(a.snapshot.metrics?.openInterestInr ?? 0) : new D(b.snapshot.metrics?.costAdjustedUnrealizedPnlInr ?? '-99999999999999').cmp(a.snapshot.metrics?.costAdjustedUnrealizedPnlInr ?? '-99999999999999'));
  }, [rows, tab, search, sort]);
  const pageRows = display.slice((page - 1) * 50, page * 50);
  useEffect(() => setPage(1), [tab, search, sort, accountId]);
  if (!ready) return <div className="panel mtf-auth" role="status">Loading your private workspace…</div>;
  if (!user) return <section className="panel mtf-auth"><p role="alert">{error || 'Could not open your MTF workspace.'}</p><button className="mtf-secondary" onClick={() => { setError(''); setReady(false); }}>Retry</button></section>;
  const cards = [ ['Open invested amount', summary?.remainingPurchaseCostInr, Wallet], ['Interest till now', summary?.openInterestInr, CalendarDays], ['Total charges', summary?.openIncurredCostsInr, Receipt], ['Open net P/L', summary?.costAdjustedUnrealizedPnlInr, TrendingUp], ['Market value', summary?.marketValueInr, TrendingUp], ['Broker funding', summary?.fundedOutstandingInr, Database], ['Own contribution', summary?.initialOwnFundsInr, Wallet], ['Daily interest burn', summary?.dailyInterestInr, CalendarDays] ];
  const definitions: [string, string][] = [['bought','Bought / days'],['quantity','Holding'],['buy','Buy price'],['adjusted','Adjusted buy price'],['price','Current price'],['pnl', ['closed','converted'].includes(tab)?'Realized P/L':'Net P/L'],['pct','P/L %'],['invested','Invested'],['interest','Interest till now'],['charges','Financing & charges'],['funding','Funded balance'],['gross','Gross P/L'],['breakeven','Exit break-even'],['net','Net liquidation estimate']];
  const headerHints: Record<string, string> = { adjusted: 'incl. interest & charges', price: 'latest quote', pnl: ['closed','converted'].includes(tab) ? 'after all costs' : 'after interest & charges', charges: 'interest + other costs' };
  function rowPct(row: DashboardRow) { const m = row.snapshot.metrics;
    if (['CLOSED_SOLD','CONVERTED_TO_DELIVERY'].includes(row.snapshot.status)) {
      // Summary rows omit exit allocations, so use total purchase basis only for fully sold lots.
      if (row.snapshot.status !== 'CLOSED_SOLD' || m?.realizedPnlInr == null) return null;
      const basis = new D(m.grossPurchaseNotionalInr).add(m.interestAccruedInr ?? 0).add(m.totalOtherChargesInr);
      return basis.gt(0) ? new D(m.realizedPnlInr).div(basis).mul(100).toFixed(2) : null;
    }
    return m?.costAdjustedUnrealizedPnlInr != null && new D(m.remainingPurchaseCostInr).add(m.openIncurredCostsInr ?? 0).gt(0) ? new D(m.costAdjustedUnrealizedPnlInr).div(new D(m.remainingPurchaseCostInr).add(m.openIncurredCostsInr ?? 0)).mul(100).toFixed(2) : null; }
  function positionIdentity(row: DashboardRow) {
    const { document, snapshot } = row;
    const canEdit = !document.events.length && !document.rateChanges?.length;
    const bought = new Date(`${document.position.boughtDate}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    return <div className="mtf-row-identity">
      <div className="mtf-scrip-avatar" aria-hidden="true">{document.position.symbol.slice(0, 2)}</div>
      <div className="mtf-row-instrument">
        <div className="mtf-row-title"><strong>{document.position.symbol}</strong><span className={`mtf-status ${['CLOSED_SOLD','CONVERTED_TO_DELIVERY'].includes(snapshot.status) ? 'closed' : snapshot.status === 'NEEDS_REVIEW' ? 'review' : ''}`}>{statusLabel(snapshot.status)}</span></div>
        <span className="mtf-row-meta">{bought} <span aria-hidden="true">·</span> {snapshot.metrics?.daysHeld ?? '—'} days</span>
        <div className="mtf-row-actions"><button className="mtf-edit" onClick={() => setSelected(document.id)}>Details<ArrowUpRight size={13} aria-hidden="true"/></button>{canEdit && <button className="mtf-edit" aria-label={`Edit ${document.position.symbol}`} onClick={() => edit(document)}><Pencil size={12} aria-hidden="true"/>Edit</button>}</div>
      </div>
    </div>;
  }
  function cell(row: DashboardRow, key: string) {
    const m = row.snapshot.metrics; const p = row.document.position;
    const closed = ['CLOSED_SOLD','CONVERTED_TO_DELIVERY'].includes(row.snapshot.status);
    const invested = closed ? m?.grossPurchaseNotionalInr : m?.remainingPurchaseCostInr;
    const interest = closed ? m?.interestAccruedInr : m?.openInterestInr;
    const totalCharges = closed && m?.interestAccruedInr != null ? new D(m.interestAccruedInr).add(m.totalOtherChargesInr).toFixed(2) : m?.openIncurredCostsInr;
    const pnl = closed ? row.document.events.some(e => e.kind === 'SELL') ? m?.realizedPnlInr : null : m?.costAdjustedUnrealizedPnlInr;
    if (key === 'bought') return <div className="mtf-row-stack"><span>{p.boughtDate}</span><small>{m?.daysHeld ?? '—'} days</small></div>;
    if (key === 'quantity') return <div className="mtf-row-stack"><strong>{new Intl.NumberFormat('en-IN').format(closed ? p.quantity : m?.quantityOpen ?? 0)} <span className="mtf-unit">shares</span></strong><small>{inr(invested ?? null)} invested</small></div>;
    if (key === 'adjusted') {
      const extra = m?.costAdjustedPriceInr ? new D(m.costAdjustedPriceInr).sub(p.buyPriceInr) : null;
      return <div className="mtf-row-stack mtf-cost-stack"><strong className={m?.costAdjustedPriceInr ? 'mtf-cost-price' : undefined}>{inr(m?.costAdjustedPriceInr ?? null)}</strong><small>Buy {inr(p.buyPriceInr)}</small>{extra ? <small className="mtf-cost-added">{extra.gte(0) ? '+' : '−'}{inr(extra.abs().toFixed(2))} costs / share</small> : <small className="mtf-row-hint">{closed ? 'No open shares' : 'Not available'}</small>}</div>;
    }
    if (key === 'price') return <PriceQuote price={m?.grossMarketValueInr != null && m.quantityOpen ? new D(m.grossMarketValueInr).div(m.quantityOpen).toFixed(2) : null} source={row.snapshot.quote?.source.reference ?? 'Unavailable'} state={row.snapshot.quoteState === 'MISSING' || row.snapshot.quoteState === 'MISMATCH' || row.snapshot.quoteState === 'DEMO' ? 'UNAVAILABLE' : row.snapshot.quoteState} at={row.snapshot.quote?.marketAt ?? null} closed={closed}/>;
    if (key === 'pnl') {
      const returnPct = rowPct(row);
      // Say why P/L is missing instead of showing empty placeholders.
      const missing = pnl != null ? null : !closed ? 'Needs a current price' : row.snapshot.status === 'CONVERTED_TO_DELIVERY' ? 'Moved to delivery, not sold' : 'Sale price not recorded';
      return <div className="mtf-row-stack mtf-return-stack"><strong className={color(pnl)}>{inr(pnl ?? null)}</strong>{returnPct !== null && <span className={`mtf-return-pill ${color(returnPct)}`}>{pct(returnPct)}</span>}{missing ? <small className={`mtf-row-hint${closed ? '' : ' warn'}`}>{missing}</small> : closed && <small>Realized sale P/L</small>}</div>;
    }
    if (key === 'charges') {
      const other = totalCharges != null && interest != null ? new D(totalCharges).sub(interest).toFixed(2) : null;
      return <div className="mtf-row-stack mtf-charge-stack"><strong>{inr(totalCharges ?? null)}</strong><small>Interest {inr(interest ?? null)} <span aria-hidden="true">·</span> Other {inr(other)}</small><small>{closed ? 'Accrual stopped' : `${inr(dailyBurn(row.document,m,asOfDay))} / day`}</small></div>;
    }
    if (key === 'pct') return <span className={color(rowPct(row))}>{pct(rowPct(row))}</span>;
    const values: Record<string,string|null|undefined> = { buy:p.buyPriceInr, invested, interest, funding:m?.fundedOutstandingInr, gross:m?.grossUnrealizedPnlInr, breakeven:m?.estimatedBreakEvenPriceInr, net:m?.estimatedNetExitPnlInr };
    return <span className={['gross','net'].includes(key) ? color(values[key]) : ''}>{inr(values[key] ?? null)}</span>;
  }
  return <div className="mtf-tracker mtf-dashboard">
    <header className="mtf-heading"><div><p className="eyebrow">PRIVATE PORTFOLIO COMMAND CENTER</p><h2>MTF portfolio</h2><p>As of {asOfDay} · Asia/Kolkata</p></div><div className="mtf-toolbar"><button className="mtf-secondary" onClick={() => { setShowEditor(s => !s); setEditing(null); setForm(emptyForm); }}><Plus size={16}/>Add scrip</button><button className="mtf-secondary" disabled={busy} onClick={refresh}><RefreshCw size={16}/>Refresh prices</button><button className="mtf-secondary" onClick={() => setShowSettings(s => !s)}><Settings2 size={16}/>Settings</button></div></header>
    <div className="mtf-workspace-bar"><label>Portfolio account<select value={accountId} onChange={e => { loadSequence.current++; setAccountId(e.target.value); setSelected(null); setRows([]); setSummary(null); setEditing(null); setForm(emptyForm); }}>{accounts.map(a => <option value={a.id} key={a.id}>{a.label}</option>)}</select></label><label>Valuation date<input type="date" max={today} value={asOfDay} onChange={e => setAsOfDay(e.target.value || today)}/></label><button className="mtf-secondary" onClick={async () => { try { downloadPrivate(await mtfRequest(`export?accountId=${accountId}`, user), 'mtf-private-report.json'); } catch (e) { setError((e as Error).message); } }}><Download size={16}/>Export private report</button></div>
    <p className="mtf-notice"><ShieldCheck size={16}/> Saved to your workspace database. NSE quotes are informational/non-commercial and refresh every 2½ minutes. Flat daily estimates and user-attested statement charges are labelled separately.</p>
    {migrationCount > 0 && <div className="mtf-migration"><p>{migrationCount} browser-saved positions are available. Review your selected account before copying them to the database.</p><button className="mtf-secondary" onClick={migrate} disabled={busy}>Copy {migrationCount} browser positions</button></div>}{migrationError && <p role="alert" className="error-panel">{migrationError}</p>}
    {error && <p role="alert" className="error-panel">{error}</p>}{note && <p role="status" className="mtf-price-note">{note}</p>}
    <section className="mtf-cards" aria-label="Open MTF totals">{cards.map(([label, value, Icon]) => { const CardIcon = Icon as typeof Wallet; return <div className="panel mtf-card" key={String(label)}><span><CardIcon size={18}/>{String(label)}</span><strong className={label === 'Open net P/L' ? color(value as string | null) : ''}>{inr(value as string | null ?? null)}</strong>{label === 'Open net P/L' && <small className={color(summary?.pnlPct)}>{pct(summary?.pnlPct)} on cost including charges</small>}</div>; })}</section>
    <div className="mtf-coverage">{summary?.openLots ?? 0} open positions · {summary?.quoteCoverage.valued ?? 0}/{summary?.quoteCoverage.required ?? 0} priced · Billed interest {inr(summary?.actualInterestInr ?? null)} / estimated {inr(summary?.estimatedInterestInr ?? null)}{summary && summary.quoteCoverage.valued < summary.quoteCoverage.required && ' · Partial quote coverage'}</div>
    {showSettings && <section className="panel mtf-editor"><h3>Accounts & read-only broker connection</h3><div className="mtf-settings-grid"><form onSubmit={async e => { e.preventDefault(); try { const result = await mtfRequest('accounts', user, { label: newAccount }); setAccounts(a => [...a, result.account]); setAccountId(result.account.id); setNewAccount(''); } catch (e) { setError((e as Error).message); } }}><label>New account label<input required maxLength={80} value={newAccount} onChange={e => setNewAccount(e.target.value)}/></label><button className="mtf-secondary">Create portfolio account</button></form><div><strong>Zerodha Kite · {broker?.connected ? 'Connected' : 'Disconnected'}</strong><p>{broker?.lastSync ? `Last synced ${new Date(broker.lastSync).toLocaleString('en-IN')}` : 'No broker snapshot yet.'}</p><p>Connection reads holdings and MTF net positions. It cannot place orders, sell, or convert shares at your broker.</p>{!broker?.configured && <p>Kite developer credentials must be configured by your website administrator.</p>}<div className="mtf-toolbar"><button className="mtf-secondary" disabled={!broker?.configured || busy} onClick={() => brokerAction('connect')}>Consent & connect Kite</button><button className="mtf-secondary" disabled={!broker?.connected || busy} onClick={() => brokerAction('sync')}>Sync read-only portfolio</button><button className="mtf-secondary" disabled={!broker?.connected || busy} onClick={() => brokerAction('disconnect')}>Disconnect</button></div></div></div>{broker?.holdings.length ? <div><h4>Broker snapshot · needs review</h4><p>Purchase dates and funded history are not supplied. Holdings and net positions can overlap; match each candidate to existing lots before adding.</p>{broker.holdings.map((h,i) => <p key={i}>{h.symbol} · {h.origin === 'NET_POSITION' ? 'Net position' : 'Holding'} · {h.quantity} shares · average {inr(h.averagePriceInr)} <button className="text-btn" onClick={() => { setForm({ ...emptyForm, isin: h.isin, symbol: h.symbol, quantity: String(h.quantity), buyPriceInr: h.averagePriceInr }); setEditing(null); setShowEditor(true); }}>Review as new lot</button></p>)}</div> : null}</section>}
    {showEditor && <section className="panel mtf-editor"><h3>{editing ? 'Edit position' : 'Add a scrip'}</h3><form onSubmit={save}><div className="mtf-form-grid">{([
      ['symbol','Scrip symbol','text',true],['boughtDate','Bought date','date',true],['quantity','Quantity','number',true],['buyPriceInr','Buying price (₹ / share)','number',true],['interestPerDayInr','Interest per day (₹)','number',true],['otherChargesInr','Other charges (₹)','number',true],['currentPrice','Current price (₹, optional manual)','number',false], ...(editing ? [['exitDate','Exit date (optional)','date',false],['reason','Change reason','text',true]] : [])
    ] as [keyof typeof form,string,string,boolean][]).map(([key,label,type,required]) => <label key={key}>{label}<input required={required} type={type} step={type === 'number' ? key === 'quantity' ? '1' : '0.01' : undefined} min={type === 'number' ? key === 'quantity' ? '1' : '0' : undefined} max={type === 'date' ? today : undefined} value={form[key]} onChange={e => setForm(f => ({ ...f,[key]:e.target.value }))}/></label>)}</div><details><summary>Funding and sale-cost estimates (optional)</summary><p>Enter funded principal and daily rate together to calculate interest from funding. Leave both blank to retain your flat daily estimate.</p><div className="mtf-form-grid">{(['fundedInr','dailyRatePct','sellFixed','sellPct'] as const).map((key,i) => <label key={key}>{['Initial funded principal (₹)','Daily funding rate (%)','Estimated fixed sale costs (₹)','Estimated sale turnover charges (%)'][i]}<input type="number" min="0" step="0.0001" value={form[key]} onChange={e => setForm(f => ({...f,[key]:e.target.value}))}/></label>)}<label>ISIN (optional)<input maxLength={12} value={form.isin} onChange={e=>setForm(f=>({...f,isin:e.target.value.toUpperCase()}))}/></label><label>Interest starts<select value={form.startOffset} onChange={e=>setForm(f=>({...f,startOffset:e.target.value}))}><option value="1">T+1 calendar day</option><option value="0">Purchase day</option></select></label><label>Exit-day interest<select value={form.includeExit} onChange={e=>setForm(f=>({...f,includeExit:e.target.value}))}><option value="yes">Include closing day</option><option value="no">Exclude repaid principal on closing day</option></select></label><label>Interest rounding<select value={form.rounding} onChange={e=>setForm(f=>({...f,rounding:e.target.value}))}>{['DAILY:HALF_UP','DAILY:HALF_EVEN','DAILY:DOWN','TOTAL:HALF_UP','TOTAL:HALF_EVEN','TOTAL:DOWN'].map(v=><option key={v} value={v}>{v.replace(':',' · ').replaceAll('_',' ')}</option>)}</select></label></div></details><p className="mtf-form-hint">Days are calendar days since purchase (purchase day = 0). Adjusted price = (remaining purchase cost + incurred costs) ÷ remaining shares.</p><div className="mtf-toolbar"><button className="primary" disabled={busy}>{editing ? 'Save changes' : 'Add position'}</button>{editing && <button type="button" className="mtf-secondary" onClick={() => { setEditing(null); setForm(emptyForm); }}>Cancel edit</button>}</div></form></section>}
    <section className="panel mtf-positions"><div className="mtf-position-header"><div className="mtf-tabs" role="tablist" aria-label="Position lifecycle">{[['open','Open'],['closed','Closed'],['converted','Converted'],['review','Needs review'],['all','All history']].map(([id,label]) => <button role="tab" aria-selected={tab===id} key={id} onClick={()=>setTab(id)}>{label}</button>)}</div><div className="mtf-position-tools"><label className="mtf-search"><Search size={16}/><input aria-label="Search positions" placeholder="Search scrip" value={search} onChange={e=>setSearch(e.target.value)}/></label><select aria-label="Sort positions" value={sort} onChange={e=>setSort(e.target.value)}><option value="symbol">Scrip A–Z</option><option value="pnl">Highest P/L</option><option value="interest">Highest accrued interest</option></select><details className="mtf-column-picker"><summary>Columns</summary>{definitions.map(([id,label])=><label key={id}><input type="checkbox" checked={columns.includes(id)} onChange={()=>setColumns(c=>c.includes(id)?c.filter(k=>k!==id):[...c,id])}/>{label}</label>)}</details></div></div>
      {!display.length ? <div className="mtf-empty"><Wallet size={32}/><h3>No positions in this view</h3><p>Add a scrip or change the search/status filter.</p></div> : <><div className="table-scroll mtf-desktop-table"><table className="mtf-position-table"><caption>Account-scoped estimates. Closed/converted records never enter open totals.</caption><thead><tr><th>Scrip / status</th>{definitions.filter(([id])=>columns.includes(id)).map(([id,label])=><th key={id}>{label}{headerHints[id] && <small className="mtf-th-hint">{headerHints[id]}</small>}</th>)}</tr></thead><tbody>{pageRows.map(row=><tr key={row.document.id} className={['CLOSED_SOLD','CONVERTED_TO_DELIVERY'].includes(row.snapshot.status)?'mtf-closed':''}><td>{positionIdentity(row)}</td>{definitions.filter(([id])=>columns.includes(id)).map(([id])=><td key={id} className={id==='adjusted'?'mtf-adjusted':id==='price'?'mtf-quote-cell':''}>{cell(row,id)}</td>)}</tr>)}</tbody></table></div><div className="mtf-mobile-cards">{pageRows.map(row=><article key={row.document.id} className={`mtf-mobile-position ${['CLOSED_SOLD','CONVERTED_TO_DELIVERY'].includes(row.snapshot.status)?'mtf-closed':''}`}><header>{positionIdentity(row)}</header><dl>{['quantity','adjusted','price','charges','pnl'].map(key=><div key={key}><dt>{definitions.find(([id])=>id===key)?.[1]}</dt><dd>{cell(row,key)}</dd></div>)}</dl></article>)}</div><div className="mtf-pagination"><button disabled={page===1} onClick={()=>setPage(p=>p-1)}>Previous</button><span>{display.length} positions · page {page} of {Math.max(1,Math.ceil(display.length/50))}</span><button disabled={page*50>=display.length} onClick={()=>setPage(p=>p+1)}>Next</button></div></>}
    </section>
    <section className="panel mtf-editor"><h3>Cost burn & observed portfolio history</h3><div className="mtf-settings-grid"><div><p>Daily estimated financing burn by open lot</p>{rows.filter(r=>['OPEN_MTF','PARTIALLY_SOLD'].includes(r.snapshot.status)).map(r=>{const daily=dailyBurn(r.document,r.snapshot.metrics,asOfDay);return <div className="mtf-burn-row" key={r.document.id}><span>{r.document.position.symbol}</span><strong>{inr(daily)}/day</strong></div>;})}</div><div><p>Recorded daily snapshots · no fabricated pre-connection history</p>{history.length ? history.slice(-14).map((h,i)=><div className="mtf-burn-row" key={i}><time>{istDay(h.at)}</time><span className={color(h.summary.costAdjustedUnrealizedPnlInr)}>{inr(h.summary.costAdjustedUnrealizedPnlInr)}</span></div>) : <p>No snapshots yet. Refresh prices to record the first observation.</p>}</div></div></section>
    {selected && <MtfDetails id={selected} asOfQuery={asOfQuery} accountId={accountId} user={user} onClose={()=>setSelected(null)} onChange={load}/>}
  </div>;
}
