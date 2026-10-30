import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle, ArrowRight, Plus, Trash2 } from 'lucide-react';
import type { BacktestResult, Condition, PeriodName } from '../../../packages/core/src/backtest.ts';
import type { DataProvenance } from '../../../packages/core/src/marketData.ts';
import type { Candle, StockSummary } from '../../../packages/core/src/types.ts';
import { ProvenanceLine } from './DataSource.tsx';

type Kind = Condition['kind'];
type ConditionDraft = { id: number; kind: Kind; a: string; b: string };
type BacktestResponse = { result: BacktestResult; provenance: DataProvenance };

const KINDS: { kind: Kind; label: string; a: string; b?: string; defaults: [string, string] }[] = [
  { kind: 'close-above-sma', label: 'Close above SMA', a: 'Period', defaults: ['20', ''] },
  { kind: 'close-below-sma', label: 'Close below SMA', a: 'Period', defaults: ['20', ''] },
  { kind: 'sma-cross-above', label: 'Fast SMA crosses above slow', a: 'Fast', b: 'Slow', defaults: ['5', '20'] },
  { kind: 'sma-cross-below', label: 'Fast SMA crosses below slow', a: 'Fast', b: 'Slow', defaults: ['5', '20'] },
  { kind: 'rsi-above', label: 'RSI above level', a: 'Period', b: 'Level', defaults: ['14', '60'] },
  { kind: 'rsi-below', label: 'RSI below level', a: 'Period', b: 'Level', defaults: ['14', '40'] },
  { kind: 'breakout-high', label: 'Close above prior N-day high', a: 'N days', defaults: ['10', ''] },
  { kind: 'breakdown-low', label: 'Close below prior N-day low', a: 'N days', defaults: ['10', ''] }
];
const PERIODS: { key: PeriodName; label: string }[] = [{ key: 'train', label: 'Train' }, { key: 'test', label: 'Test' }, { key: 'outOfSample', label: 'Out-of-sample' }];
const rupees = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const pct = (n: number | null) => n === null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const plain = (n: number | null, digits = 2) => n === null ? '—' : n.toFixed(digits);
const num = (s: string) => s.trim() === '' ? NaN : Number(s);
const optional = (s: string) => s.trim() === '' ? null : Number(s);
let nextId = 1;
const draft = (kind: Kind): ConditionDraft => { const k = KINDS.find(x => x.kind === kind)!; return { id: nextId++, kind, a: k.defaults[0], b: k.defaults[1] }; };

function toCondition(d: ConditionDraft): Condition {
  switch (d.kind) {
    case 'close-above-sma': case 'close-below-sma': return { kind: d.kind, period: num(d.a) };
    case 'sma-cross-above': case 'sma-cross-below': return { kind: d.kind, fast: num(d.a), slow: num(d.b) };
    case 'rsi-above': case 'rsi-below': return { kind: d.kind, period: num(d.a), level: num(d.b) };
    case 'breakout-high': case 'breakdown-low': return { kind: d.kind, lookback: num(d.a) };
  }
}

function ConditionList({ title, items, setItems, min }: { title: string; items: ConditionDraft[]; setItems: (f: (xs: ConditionDraft[]) => ConditionDraft[]) => void; min: number }) {
  return <div className="bt-conditions"><p className="eyebrow risk-sub">{title}</p>
    {items.map(d => { const k = KINDS.find(x => x.kind === d.kind)!; return <div key={d.id} className="bt-condition">
      <select aria-label={`${title} condition`} value={d.kind} onChange={e => { const next = draft(e.target.value as Kind); setItems(xs => xs.map(x => x.id === d.id ? { ...next, id: d.id } : x)); }}>
        {KINDS.map(x => <option key={x.kind} value={x.kind}>{x.label}</option>)}
      </select>
      <label><span>{k.a}</span><input type="number" step="any" value={d.a} onChange={e => setItems(xs => xs.map(x => x.id === d.id ? { ...x, a: e.target.value } : x))}/></label>
      {k.b ? <label><span>{k.b}</span><input type="number" step="any" value={d.b} onChange={e => setItems(xs => xs.map(x => x.id === d.id ? { ...x, b: e.target.value } : x))}/></label> : <span/>}
      <button type="button" className="icon-btn" aria-label={`Remove ${k.label}`} disabled={items.length <= min} onClick={() => setItems(xs => xs.filter(x => x.id !== d.id))}><Trash2 size={14}/></button>
    </div>; })}
    <button type="button" className="text-btn" disabled={items.length >= 5} onClick={() => setItems(xs => [...xs, draft('close-above-sma')])}><Plus size={14}/> Add condition</button>
  </div>;
}

function EquityChart({ points }: { points: BacktestResult['periods']['train']['equityCurve'] }) {
  if (points.length < 2) return null;
  const width = 600, height = 170;
  const values = points.flatMap(p => [p.equity, p.benchmark]);
  const lo = Math.min(...values), hi = Math.max(...values), range = hi - lo || 1;
  const line = (key: 'equity' | 'benchmark') => points.map((p, i) => `${(i / (points.length - 1)) * width},${height - 6 - ((p[key] - lo) / range) * (height - 12)}`).join(' ');
  const last = points[points.length - 1];
  return <figure className="bt-chart">
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`Equity from ${points[0].date} to ${last.date}: strategy ${rupees.format(last.equity)}, buy-and-hold ${rupees.format(last.benchmark)}`}>
      <polyline points={line('benchmark')} fill="none" stroke="#8190ad" strokeWidth="1.5" strokeDasharray="4 4" vectorEffect="non-scaling-stroke"/>
      <polyline points={line('equity')} fill="none" stroke="#5d83f3" strokeWidth="2.2" vectorEffect="non-scaling-stroke"/>
    </svg>
    <figcaption><span className="key strategy"/> Strategy <span className="key benchmark"/> Buy-and-hold, same costs · {points[0].date} → {last.date}</figcaption>
  </figure>;
}

export default function BacktestLab({ stocks }: { stocks: StockSummary[] }) {
  const [symbol, setSymbol] = useState('');
  const [name, setName] = useState('Trend follow');
  const [entry, setEntry] = useState<ConditionDraft[]>(() => [draft('close-above-sma'), { ...draft('rsi-above'), a: '14', b: '50' }]);
  const [exit, setExit] = useState<ConditionDraft[]>(() => [draft('close-below-sma')]);
  const [risk, setRisk] = useState({ stop: '5', target: '', maxHold: '20' });
  const [sizing, setSizing] = useState({ mode: 'fraction' as 'fraction' | 'risk', value: '1' });
  const [costs, setCosts] = useState({ capital: '100000', perOrder: '20', buyPct: '0.12', sellPct: '0.12', slippageBps: '10' });
  const [periods, setPeriods] = useState({ trainEnd: '', testEnd: '' });
  const [dates, setDates] = useState<string[]>([]);
  const [result, setResult] = useState<BacktestResponse | null>(null);
  const [view, setView] = useState<PeriodName>('outOfSample');
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => { if (!symbol && stocks.length) setSymbol(stocks[0].symbol); }, [stocks, symbol]);
  useEffect(() => {
    if (!symbol) return;
    const controller = new AbortController();
    fetch(`/api/stocks/${encodeURIComponent(symbol)}/candles?limit=90`, { signal: controller.signal }).then(r => r.ok ? r.json() : null).then(body => {
      const ds = ((body?.candles ?? []) as Candle[]).map(c => c.date);
      setDates(ds);
      if (ds.length >= 6) setPeriods({ trainEnd: ds[Math.floor(ds.length * 0.6) - 1], testEnd: ds[Math.floor(ds.length * 0.8) - 1] });
    }).catch(() => {});
    return () => controller.abort();
  }, [symbol]);

  const request = useMemo(() => ({
    symbol,
    config: {
      initialCapital: num(costs.capital),
      strategy: { name, entry: entry.map(toCondition), exit: exit.map(toCondition), stopLossPct: optional(risk.stop), takeProfitPct: optional(risk.target), maxHoldingDays: optional(risk.maxHold) },
      sizing: sizing.mode === 'fraction' ? { mode: 'fraction', fraction: num(sizing.value) } : { mode: 'risk', riskPct: num(sizing.value) },
      costs: { perOrder: num(costs.perOrder), buyPct: num(costs.buyPct), sellPct: num(costs.sellPct), slippageBps: num(costs.slippageBps) },
      periods
    }
  }), [symbol, name, entry, exit, risk, sizing, costs, periods]);

  async function run(e: FormEvent) {
    e.preventDefault(); setLoading(true); setErrors([]);
    try {
      const response = await fetch('/api/backtests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
      const body = await response.json();
      if (!response.ok) { setErrors(body.details ?? [body.error ?? 'Backtest failed']); setResult(null); return; }
      setResult(body as BacktestResponse);
    } catch (err) { setErrors([err instanceof Error ? err.message : 'Backtest failed']); }
    finally { setLoading(false); }
  }

  const field = (label: string, value: string, onChange: (v: string) => void, helper?: string) =>
    <label className="form-field"><span>{label}</span><input type="number" step="any" value={value} onChange={e => onChange(e.target.value)}/>{helper && <small>{helper}</small>}</label>;
  const selected = result?.result.periods[view];
  const rows: [string, (m: BacktestResult['periods']['train']['metrics']) => string][] = [
    ['Dates', m => `${m.startDate} → ${m.endDate}`], ['Sessions', m => String(m.sessions)], ['Trades', m => String(m.trades)],
    ['Net return', m => pct(m.totalReturnPct)], ['Buy-and-hold return', m => pct(m.benchmarkReturnPct)], ['Excess vs buy-and-hold', m => pct(m.excessReturnPct)],
    ['Max drawdown', m => `${m.maxDrawdownPct.toFixed(2)}%`], ['Buy-and-hold max drawdown', m => `${m.benchmarkMaxDrawdownPct.toFixed(2)}%`],
    ['Win rate (95% range)', m => m.winRatePct === null ? '—' : `${m.winRatePct.toFixed(0)}% (${m.winRate95![0].toFixed(0)}–${m.winRate95![1].toFixed(0)}%)`],
    ['Average win / loss', m => `${m.avgWin === null ? '—' : rupees.format(m.avgWin)} / ${m.avgLoss === null ? '—' : rupees.format(m.avgLoss)}`],
    ['Payoff ratio', m => plain(m.payoffRatio)], ['Profit factor', m => plain(m.profitFactor)], ['Expectancy per trade', m => m.expectancy === null ? '—' : rupees.format(m.expectancy)],
    ['Time in market', m => `${m.exposurePct.toFixed(1)}%`], ['Turnover', m => `${m.turnover.toFixed(2)}×`],
    ['Fees + slippage', m => `${rupees.format(m.totalFees + m.totalSlippage)} (${m.costDragPct.toFixed(2)}% of capital)`], ['Skipped entries (size < 1 share)', m => String(m.skippedEntries)]
  ];

  return <div className="bt-page">
    <form className="panel bt-form" onSubmit={run}>
      <div className="section-head"><div><p className="eyebrow">HISTORICAL SIMULATION</p><h3>Rules to test</h3></div><span className="tag">Long only · next-open fills</span></div>
      <div className="bt-grid">
        <label className="form-field"><span>Instrument</span><select value={symbol} onChange={e => setSymbol(e.target.value)}>{stocks.map(s => <option key={s.symbol}>{s.symbol}</option>)}</select><small>{dates.length ? `${dates.length} recent sessions visible here; the backtest uses all history the source provides` : ''}</small></label>
        <label className="form-field"><span>Strategy name</span><input value={name} maxLength={60} onChange={e => setName(e.target.value)}/></label>
      </div>
      <ConditionList title="ENTER WHEN ALL ARE TRUE AT A CLOSE" items={entry} setItems={setEntry} min={1}/>
      <ConditionList title="EXIT WHEN ANY IS TRUE AT A CLOSE" items={exit} setItems={setExit} min={0}/>
      <div className="bt-grid four">
        {field('Stop loss %', risk.stop, v => setRisk(r => ({ ...r, stop: v })), 'Blank = none')}
        {field('Take profit %', risk.target, v => setRisk(r => ({ ...r, target: v })), 'Blank = none')}
        {field('Max holding days', risk.maxHold, v => setRisk(r => ({ ...r, maxHold: v })), 'Blank = none')}
        <label className="form-field"><span>Sizing</span><select value={sizing.mode} onChange={e => setSizing({ mode: e.target.value as 'fraction' | 'risk', value: '1' })}><option value="fraction">Fraction of equity</option><option value="risk">% of equity at risk to stop</option></select>
          <input type="number" step="any" aria-label="Sizing value" value={sizing.value} onChange={e => setSizing(z => ({ ...z, value: e.target.value }))}/><small>{sizing.mode === 'fraction' ? '0–1 (1 = all cash)' : 'e.g. 1 = 1% of equity'}</small></label>
      </div>
      <div className="bt-grid four">
        {field('Capital ₹', costs.capital, v => setCosts(c => ({ ...c, capital: v })))}
        {field('Fee per order ₹', costs.perOrder, v => setCosts(c => ({ ...c, perOrder: v })))}
        {field('Buy-side charges %', costs.buyPct, v => setCosts(c => ({ ...c, buyPct: v })), 'Your estimate (STT, stamp duty, etc.)')}
        {field('Sell-side charges %', costs.sellPct, v => setCosts(c => ({ ...c, sellPct: v })))}
        {field('Slippage (bps)', costs.slippageBps, v => setCosts(c => ({ ...c, slippageBps: v })), '10 bps = 0.10% per fill')}
        <label className="form-field"><span>Train ends</span><input type="date" value={periods.trainEnd} onChange={e => setPeriods(p => ({ ...p, trainEnd: e.target.value }))}/></label>
        <label className="form-field"><span>Test ends</span><input type="date" value={periods.testEnd} onChange={e => setPeriods(p => ({ ...p, testEnd: e.target.value }))}/><small>Later sessions are out-of-sample</small></label>
      </div>
      <p className="muted">Fix the periods before looking at results. Tuning rules until the out-of-sample number looks good turns it into another training set.</p>
      {errors.length > 0 && <div role="alert" className="error"><ul>{errors.map(e => <li key={e}>{e}</li>)}</ul></div>}
      <button className="primary" type="submit" disabled={loading || !symbol}>{loading ? 'Running…' : 'Run backtest'} <ArrowRight size={17}/></button>
    </form>

    {result && <div className="bt-results">
      {result.result.warnings.length > 0 && <div className="panel bt-warnings" role="status">{result.result.warnings.map(w => <p key={w}><AlertTriangle size={14}/> {w}</p>)}</div>}
      <div className="panel"><div className="section-head"><div><p className="eyebrow">RESULTS BY PERIOD</p><h3>{name} on {request.symbol}</h3></div><span className="tag">Net of fees and slippage</span></div>
        <div className="table-scroll"><table className="risk-table compare bt-table">
          <thead><tr><th/>{PERIODS.map(p => <th key={p.key}>{p.label}</th>)}</tr></thead>
          <tbody>{rows.map(([label, f]) => <tr key={label}><td>{label}</td>{PERIODS.map(p => <td key={p.key}>{f(result.result.periods[p.key].metrics)}</td>)}</tr>)}</tbody>
        </table></div>
      </div>
      <div className="panel"><div className="section-head"><div><p className="eyebrow">EQUITY CURVE AND TRADES</p><h3>{PERIODS.find(p => p.key === view)!.label} period</h3></div>
        <div className="range-group" role="group" aria-label="Period">{PERIODS.map(p => <button key={p.key} type="button" className={`range-btn ${view === p.key ? 'active' : ''}`} aria-pressed={view === p.key} onClick={() => setView(p.key)}>{p.label}</button>)}</div></div>
        {selected && <><EquityChart points={selected.equityCurve}/>
          {selected.trades.length === 0 ? <p className="muted">No trades in this period.</p> :
          <div className="table-scroll"><table className="risk-table bt-trades">
            <thead><tr><th>Entry</th><th>Exit</th><th>Qty</th><th>Entry ₹</th><th>Exit ₹</th><th>Reason</th><th>Days</th><th>Costs ₹</th><th>Net P&L</th></tr></thead>
            <tbody>{selected.trades.map(t => <tr key={t.entryDate}><td>{t.entryDate}</td><td>{t.exitDate}</td><td>{t.quantity}</td><td>{t.entryPrice.toFixed(2)}</td><td>{t.exitPrice.toFixed(2)}</td><td>{t.exitReason}</td><td>{t.barsHeld}</td><td>{(t.fees + t.slippage).toFixed(2)}</td><td className={t.netPnl >= 0 ? 'up' : 'down'}>{rupees.format(t.netPnl)} ({pct(t.returnPct)})</td></tr>)}</tbody>
          </table></div>}</>}
        <ProvenanceLine provenance={result.provenance}/>
        <p className="tiny-note"><AlertTriangle size={14}/> Hypothetical historical simulation · run {result.result.runId} · {result.result.engineVersion} · data {result.result.dataFirstDate} → {result.result.dataLastDate}. Signals use each day's close and fill at the next open; a gap through a stop fills at the open; if stop and target fall in one bar the stop is assumed. Prices are not adjusted for splits or dividends. Past results do not predict future returns.</p>
      </div>
    </div>}
  </div>;
}
