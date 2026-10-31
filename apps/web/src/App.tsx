import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity, ArrowDownRight, ArrowRight, ArrowUpRight, BarChart3, Bell,
  BookOpen, CheckCircle2, ChevronRight, FlaskConical, Github, LayoutDashboard,
  History, LineChart, NotebookPen, PieChart, Search, ShieldCheck, Sparkles, Star, Wallet, AlertTriangle
} from 'lucide-react';
import type { PositionScenarioInput, PositionScenarioResult, StockSummary } from '../../../packages/core/src/types.ts';
import CandleChart from './CandleChart.tsx';
import { DataBanner, ProvenanceLine } from './DataSource.tsx';
import type { DataProvenance, ProviderInfo } from '../../../packages/core/src/marketData.ts';
import ThesisJournal from './ThesisJournal.tsx';
import PortfolioRisk from './PortfolioRisk.tsx';
import BacktestLab from './BacktestLab.tsx';
import ResearchAssistant from './ResearchAssistant.tsx';
import MtfTracker from './MtfTracker.tsx';

type Tab = 'overview' | 'screener' | 'simulator' | 'portfolio' | 'backtest' | 'journal' | 'research' | 'mtf' | 'roadmap';
type StockRow = StockSummary & { provenance?: DataProvenance };
type StocksPayload = { data: StockRow[]; count: number; source: string };
const rupees = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const nav: { id: Tab; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'screener', label: 'Stock screener', icon: Search },
  { id: 'simulator', label: 'Scenario lab', icon: FlaskConical },
  { id: 'portfolio', label: 'Portfolio risk', icon: PieChart },
  { id: 'backtest', label: 'Backtest', icon: History },
  { id: 'journal', label: 'Thesis journal', icon: NotebookPen },
  { id: 'research', label: 'Research assistant', icon: Sparkles },
  { id: 'mtf', label: 'MTF Tracker', icon: Wallet },
  { id: 'roadmap', label: 'Build roadmap', icon: BookOpen }
];

function Sparkline({ values, positive = true, height = 52 }: { values: number[]; positive?: boolean; height?: number }) {
  const width = 190;
  if (values.length < 2) return null;
  const low = Math.min(...values);
  const high = Math.max(...values);
  const range = high - low || 1;
  const points = values.map((v, i) => `${(i / (values.length - 1)) * width},${height - 5 - ((v - low) / range) * (height - 10)}`).join(' ');
  return <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Synthetic price trend sparkline">
    <polyline points={points} fill="none" stroke={positive ? '#48d9aa' : '#fa8290'} strokeWidth="2.8" strokeLinejoin="round" strokeLinecap="round" />
  </svg>;
}

function Metric({ label, value, sub, icon }: { label: string; value: string; sub: string; icon: ReactNode }) {
  return <div className="metric panel">
    <div className="metric-head"><span>{label}</span><span className="metric-icon">{icon}</span></div>
    <div className="metric-value">{value}</div><div className="metric-sub">{sub}</div>
  </div>;
}

function StockTable({ stocks, selected, onSelect, watchlist, onWatch }: {
  stocks: StockRow[]; selected: string; onSelect: (s: string) => void; watchlist: string[]; onWatch: (s: string) => void;
}) {
  return <div className="table-scroll"><table className="stock-table">
    <thead><tr><th>Company</th><th>Last price</th><th>Change</th><th>RSI (14)</th><th>Trend</th><th>20-day chart</th><th aria-label="Watchlist">Save</th></tr></thead>
    <tbody>{stocks.map(s => <tr key={s.symbol} className={selected === s.symbol ? 'selected' : ''}>
      <td><button className="stock-link" onClick={() => onSelect(s.symbol)}><span className="avatar">{(s.symbol.split('-')[1] || s.symbol).slice(0, 1)}</span><span><strong>{s.symbol}{s.provenance?.freshness === 'stale' && <em className="stale-tag">Stale</em>}</strong><small>{s.name}</small></span></button></td>
      <td className="num">{rupees.format(s.lastClose)}</td>
      <td className={`num ${s.changePct >= 0 ? 'up' : 'down'}`}>{s.changePct >= 0 ? <ArrowUpRight size={14}/> : <ArrowDownRight size={14}/>} {pct(s.changePct)}</td>
      <td><span className="rsi">{s.rsi14?.toFixed(1) ?? '–'}</span></td>
      <td><span className={`status ${s.trend === 'above-sma' ? 'bull' : 'bear'}`}>{s.trend === 'above-sma' ? 'Above SMA' : 'Below SMA'}</span></td>
      <td className="chart-cell"><Sparkline values={s.sparkline} positive={s.changePct >= 0}/></td>
      <td><button aria-label={watchlist.includes(s.symbol) ? `Remove ${s.symbol} from watchlist` : `Add ${s.symbol} to watchlist`} title="Save watchlist locally" className={`star-btn ${watchlist.includes(s.symbol) ? 'saved' : ''}`} onClick={() => onWatch(s.symbol)}><Star size={18} fill={watchlist.includes(s.symbol) ? 'currentColor' : 'none'}/></button></td>
    </tr>)}</tbody>
  </table>{stocks.length === 0 && <p className="empty">No instruments match your filters. Adjust your search or RSI range.</p>}</div>;
}

function StockDetail({ stock }: { stock: StockRow | undefined }) {
  if (!stock) return <div className="panel detail"><p className="muted">Choose an instrument.</p></div>;
  return <div className="panel detail">
    <div className="section-head"><div><p className="eyebrow">RESEARCH SNAPSHOT</p><h3>{stock.symbol}</h3><p className="muted">{stock.name} · {stock.sector}</p></div><span className="tag">Rules-based</span></div>
    <div className="detail-price"><div><span className="big-price">{rupees.format(stock.lastClose)}</span><div className={`change ${stock.changePct >= 0 ? 'up' : 'down'}`}>{pct(stock.changePct)} vs previous {stock.provenance?.kind === 'licensed' ? '' : `${stock.provenance?.kind === 'fixture' ? 'fixture' : 'demo'} `}close</div></div></div>
    <ProvenanceLine provenance={stock.provenance}/>
    <CandleChart symbol={stock.symbol}/>
    <div className="detail-kpis"><div><span>20-day SMA</span><strong>{stock.sma20 ? rupees.format(stock.sma20) : 'N/A'}</strong></div><div><span>RSI (14)</span><strong>{stock.rsi14?.toFixed(1) ?? 'N/A'}</strong></div></div>
    <div className="insight"><div className="insight-title"><Activity size={16}/> Deterministic insight</div><p>The {stock.provenance?.kind === 'licensed' ? 'latest' : stock.provenance?.kind === 'fixture' ? 'fixture' : 'demo'} closing price is <strong>{stock.trend === 'above-sma' ? 'above' : 'below'}</strong> its 20-day simple moving average. RSI is {stock.rsi14?.toFixed(1) ?? 'unavailable'}. This describes {stock.provenance?.kind === 'licensed' ? 'historical provider data as of the date shown' : 'synthetic data'} only; it is not a buy/sell recommendation.</p></div>
    <div className="coming"><Sparkles size={16}/><div><strong>Grounded research assistant</strong><p>Open Research assistant to review versioned price evidence and contrary observations. Offline mock by default; filings and news are not available.</p></div></div>
  </div>;
}

function ScenarioLab({ stock }: { stock: StockSummary | undefined }) {
  const [input, setInput] = useState<PositionScenarioInput>({ budget: 100000, entryPrice: 120, movePct: -10, holdingDays: 60, borrowedAmount: 0, annualInterestPct: 12, estimatedFees: 80 });
  const [result, setResult] = useState<PositionScenarioResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => { if (stock) setInput(current => ({ ...current, entryPrice: stock.lastClose })); setResult(null); }, [stock?.symbol, stock?.lastClose]);
  function field(key: keyof PositionScenarioInput, label: string, helper?: string) {
    return <label className="form-field" key={key}><span>{label}</span><input type="number" step="any" value={input[key]} onChange={e => setInput(current => ({ ...current, [key]: Number(e.target.value) }))}/>{helper && <small>{helper}</small>}</label>;
  }
  async function submit(e: FormEvent) {
    e.preventDefault(); setLoading(true); setResult(null); setError('');
    try {
      const response = await fetch('/api/scenarios', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Scenario request failed');
      setResult(body.result as PositionScenarioResult);
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setLoading(false); }
  }
  return <div className="lab-layout"><div className="panel lab-form"><div className="section-head"><div><p className="eyebrow">TRADE PLANNING</p><h3>Hypothetical scenario</h3></div><span className="tag">No execution</span></div><p className="muted">Calculate what a user-defined price change would mean after estimated fees and simple-interest financing.</p>
    <form onSubmit={submit}><div className="form-grid">
      {field('budget', 'Total budget (₹)')}{field('entryPrice', 'Hypothetical entry price (₹)')}
      {field('movePct', 'Price move (%)', 'Example: -10 for a fall')}{field('holdingDays', 'Holding days')}
      {field('borrowedAmount', 'Borrowed MTF amount (₹)')}{field('annualInterestPct', 'Annual MTF rate (%)')}
      {field('estimatedFees', 'Estimated total fees (₹)', 'Enter your own broker cost estimate')}
    </div><button className="primary" type="submit" disabled={loading}>{loading ? 'Calculating…' : 'Calculate scenario'} <ArrowRight size={17}/></button></form>{error && <p role="alert" className="error">{error}</p>}</div>
    <div className="panel lab-result"><div className="section-head"><div><p className="eyebrow">SIMULATED RESULT</p><h3>Cost-aware outcome</h3></div><FlaskConical size={20} color="#86a4e6"/></div>
      {result ? <><div className="result-hero"><span>Estimated net P&L</span><strong className={result.netPnl >= 0 ? 'up' : 'down'}>{rupees.format(result.netPnl)}</strong><span className={result.netPnl >= 0 ? 'up' : 'down'}>{pct(result.netReturnPct)} of invested value</span></div>
        <div className="result-list">{[
          ['Whole shares', String(result.quantity)], ['Invested value', rupees.format(result.invested)],
          ['Unused budget', rupees.format(result.cashRemaining)], ['Hypothetical exit price', rupees.format(result.projectedExitPrice)],
          ['Gross P&L', rupees.format(result.grossPnl)], ['MTF interest', `−${rupees.format(result.financingCost)}`],
          ['Estimated fees', `−${rupees.format(result.estimatedFees)}`]
        ].map(([key, val]) => <div key={key}><span>{key}</span><strong>{val}</strong></div>)}</div>
      </> : <div className="result-empty"><FlaskConical size={38}/><strong>Your scenario appears here</strong><p>Adjust the assumptions and calculate to inspect a hypothetical result.</p></div>}
      <p className="tiny-note"><AlertTriangle size={14}/> Simplified simulation. Excludes slippage, taxes, variable financing terms, margin calls, and actual broker-specific charges unless included in the fees input. Not a prediction.</p>
    </div></div>;
}

function Roadmap() {
  const sections = [
    { id: '01', title: 'Real data provider', status: 'Next', text: 'Design a licensed market data adapter, instrument mapping, candle caching, gaps and corporate-action handling.' },
    { id: '02', title: 'Portfolio and MTF risk', status: 'Planned', text: 'CSV import using synthetic fixtures first; position concentration, sector exposure and borrowing costs.' },
    { id: '03', title: 'Backtesting engine', status: 'Planned', text: 'Point-in-time strategy rules, realistic fees, look-ahead bias protections, reproducible reports.' },
    { id: '04', title: 'Grounded AI research', status: 'Planned', text: 'LLM tool calling with traceable research sources, timestamps, counterarguments and explicit uncertainty.' },
    { id: '05', title: 'Production hardening', status: 'Planned', text: 'Authentication, authorization, Postgres, queue workers, observability, integration/E2E tests.' }
  ];
  return <div className="panel road"><p className="eyebrow">REAL ENGINEERING WORK REMAINING</p><h3>Build the next releases</h3><p className="muted">Pick one ticket, create a branch, implement tests, and open a pull request. See <code>docs/ROADMAP.md</code> and <code>CLAUDE.md</code> for acceptance criteria.</p>
    {sections.map(s => <div className="road-item" key={s.id}><span className="road-index">{s.id}</span><div><strong>{s.title}</strong><p>{s.text}</p></div><span className="tag">{s.status}</span></div>)}
  </div>;
}

export default function App() {
  const [tab, setTab] = useState<Tab>(() => window.location.hash === '#mtf' ? 'mtf' : 'overview');
  const [stocks, setStocks] = useState<StockRow[]>([]);
  const [provider, setProvider] = useState<ProviderInfo | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState('DEMO-ALPHA');
  const [search, setSearch] = useState('');
  const [trend, setTrend] = useState('all');
  const [minRsi, setMinRsi] = useState('0');
  const [maxRsi, setMaxRsi] = useState('100');
  const [loadError, setLoadError] = useState('');
  const [watchlist, setWatchlist] = useState<string[]>(() => {
    try { const data: unknown = JSON.parse(localStorage.getItem('tradelens-demo-watchlist') ?? '[]'); return Array.isArray(data) ? data.filter((v): v is string => typeof v === 'string') : []; }
    catch { return []; }
  });
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal }).then(res => res.ok ? res.json() : null)
      .then(body => { if (body?.provider) setProvider(body.provider as ProviderInfo); }).catch(() => {});
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/stocks', { signal: controller.signal }).then(async res => { if (!res.ok) throw new Error('API unavailable'); return await res.json() as StocksPayload; })
      .then(body => setStocks(body.data)).catch(err => { if (!controller.signal.aborted) setLoadError(err instanceof Error ? err.message : 'Failed to load stocks'); });
    return () => controller.abort();
  }, []);
  const dataWord = provider?.kind === 'licensed' ? provider.exchange : provider?.kind === 'fixture' ? 'fixture' : 'demo';
  const modeLabel = provider === null ? 'CHECKING SOURCE' : provider.kind === 'licensed' ? 'LICENSED DATA' : provider.kind === 'fixture' ? 'FIXTURE MODE' : 'DEMO MODE';
  const selected = stocks.find(s => s.symbol === selectedSymbol) ?? stocks[0];
  const filtered = useMemo(() => stocks.filter(s => {
    const q = search.toLowerCase();
    const low = Number(minRsi); const high = Number(maxRsi);
    return (s.name.toLowerCase().includes(q) || s.symbol.toLowerCase().includes(q)) &&
      (trend === 'all' || s.trend === trend) && s.rsi14 !== null &&
      s.rsi14 >= (Number.isFinite(low) ? low : 0) && s.rsi14 <= (Number.isFinite(high) ? high : 100);
  }), [stocks, search, trend, minRsi, maxRsi]);
  const rising = stocks.filter(s => s.changePct > 0).length;
  const bullish = stocks.filter(s => s.trend === 'above-sma').length;
  const avgMove = stocks.length ? stocks.reduce((sum, s) => sum + s.changePct, 0) / stocks.length : 0;
  function toggleWatch(symbol: string) {
    setWatchlist(prev => { const next = prev.includes(symbol) ? prev.filter(item => item !== symbol) : [...prev, symbol]; localStorage.setItem('tradelens-demo-watchlist', JSON.stringify(next)); return next; });
  }
  function selectStock(symbol: string) { setSelectedSymbol(symbol); if (tab === 'screener') setTab('overview'); }
  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><div className="brand-mark"><LineChart size={23}/></div><div><strong>TradeLens <span>AI</span></strong><small>Research workspace</small></div></div>
      <div className="sidebar-heading">WORKSPACE</div>
      <nav aria-label="Main navigation">{nav.map(item => <button className={`nav-item ${tab === item.id ? 'active' : ''}`} key={item.id} onClick={() => setTab(item.id)}><item.icon size={18}/>{item.label}{tab === item.id && <ChevronRight size={15} className="nav-chevron"/>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="sidebar-info"><ShieldCheck size={19}/><div><strong>{tab === 'mtf' ? 'Manual position tracking' : 'Paper research mode'}</strong><small>{tab === 'mtf' ? 'No broker order execution' : 'No real orders or live data'}</small></div></div><a href="https://github.com" target="_blank" rel="noreferrer"><Github size={16}/> GitHub <ArrowRight size={14}/></a></div>
    </aside>
    <main className="main"><div className="topbar"><div><span className="breadcrumb">TradeLens AI</span><span className="crumb-arrow">/</span><strong>{nav.find(n => n.id === tab)?.label}</strong></div><div className="topbar-right"><span className="pill"><span className="dot"/> {tab === 'mtf' ? 'PRIVATE WORKSPACE' : modeLabel}</span><span className="avatar-user">TL</span></div></div>
      <div className="content">{tab !== 'mtf' && <DataBanner provider={provider}/>}
        <div className="page-heading"><div><p className="eyebrow">BUILD SMARTER RESEARCH</p><h1>{tab === 'overview' ? 'Market overview' : tab === 'screener' ? 'Stock screener' : tab === 'simulator' ? 'Scenario lab' : tab === 'portfolio' ? 'Portfolio risk' : tab === 'backtest' ? 'Backtest' : tab === 'journal' ? 'Thesis journal' : tab === 'research' ? 'Research assistant' : tab === 'mtf' ? 'MTF Tracker' : 'Product roadmap'}</h1><p className="muted">{tab === 'overview' ? `Explore ${dataWord} price data and rule-based research signals.` : tab === 'screener' ? `Filter ${provider?.kind === 'licensed' ? 'instruments' : 'synthetic instruments'} by moving-average trend and RSI.` : tab === 'simulator' ? 'Understand potential costs and outcomes before committing capital.' : tab === 'portfolio' ? 'Check concentration, leverage and your own risk limits across hypothetical positions and scenarios.' : tab === 'backtest' ? 'Test your own rules on past data, net of costs, with separate train, test and out-of-sample periods.' : tab === 'journal' ? 'Record a hypothesis with evidence for and against it, and keep every revision.' : tab === 'mtf' ? 'Add positions, track daily charges and see your cost-adjusted P/L.' : 'A transparent plan for turning this starter into a real product.'}</p></div><span className="header-stamp"><Bell size={17}/> Research prototype · v0.1</span></div>
        {loadError && <div role="alert" className="error-panel">Cannot load the API: {loadError}. Run <code>npm run dev:api</code> in another terminal or <code>npm run dev</code> from the repository root.</div>}
        {tab === 'overview' && <>
          <div className="metrics"><Metric label={provider?.kind === 'licensed' ? 'Instruments' : provider?.kind === 'fixture' ? 'Fixture instruments' : 'Demo instruments'} value={String(stocks.length).padStart(2, '0')} sub={provider?.kind === 'licensed' ? `${provider.exchange} · ${provider.name}` : 'Fictional companies'} icon={<BarChart3 size={20}/>}/><Metric label="Positive daily change" value={String(rising).padStart(2, '0')} sub={provider?.kind === 'licensed' ? 'Of listed instruments' : 'Of synthetic instruments'} icon={<ArrowUpRight size={20}/>}/><Metric label="Above 20-day SMA" value={String(bullish).padStart(2, '0')} sub="Rules-based signal" icon={<Activity size={20}/>}/><Metric label={`Average ${provider?.kind === 'licensed' ? '' : `${dataWord} `}change`} value={pct(avgMove)} sub={provider?.kind === 'licensed' ? 'Equal-weight; not an index' : 'Not a real market index'} icon={<LineChart size={20}/>}/></div>
          <div className="two-col"><div className="panel overview-table"><div className="section-head"><div><p className="eyebrow">STOCK UNIVERSE</p><h3>Explore instruments</h3></div><button className="text-btn" onClick={() => setTab('screener')}>Open screener <ArrowRight size={15}/></button></div><StockTable stocks={stocks} selected={selectedSymbol} onSelect={setSelectedSymbol} watchlist={watchlist} onWatch={toggleWatch}/></div><StockDetail stock={selected}/></div>
        </>}
        {tab === 'screener' && <div className="panel screen"><div className="section-head"><div><p className="eyebrow">SCREENING CONDITIONS</p><h3>Filter the universe</h3></div><span className="tag">{filtered.length} results</span></div><div className="filters"><label className="search-field"><Search size={18}/><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search a demo company" aria-label="Search demo stocks"/></label><label><span>20-day trend</span><select value={trend} onChange={e => setTrend(e.target.value)}><option value="all">All</option><option value="above-sma">Above SMA</option><option value="below-sma">Below SMA</option></select></label><label><span>Min RSI</span><input type="number" min="0" max="100" value={minRsi} onChange={e => setMinRsi(e.target.value)}/></label><label><span>Max RSI</span><input type="number" min="0" max="100" value={maxRsi} onChange={e => setMaxRsi(e.target.value)}/></label></div><StockTable stocks={filtered} selected={selectedSymbol} onSelect={selectStock} watchlist={watchlist} onWatch={toggleWatch}/></div>}
        {tab === 'simulator' && <ScenarioLab stock={selected}/>}
        {tab === 'portfolio' && <PortfolioRisk stocks={stocks}/>}
        {tab === 'backtest' && <BacktestLab stocks={stocks}/>}
        {tab === 'journal' && <ThesisJournal stocks={stocks} defaultSymbol={selected?.symbol ?? 'DEMO-ALPHA'}/>}
        {tab === 'research' && <ResearchAssistant stocks={stocks}/>}
        <div hidden={tab !== 'mtf'}><MtfTracker active={tab === 'mtf'}/></div>
        {tab === 'roadmap' && <Roadmap/>}
        <div className="footer"><span><CheckCircle2 size={15}/> {tab === 'mtf' ? 'Manual tracking · no order execution' : 'Read-only demo · no broker connection'}</span><span><Wallet size={15}/> {tab === 'mtf' ? 'Workspace · encrypted portfolio storage' : 'No personal financial data collected'}</span></div>
      </div>
    </main>
  </div>;
}
