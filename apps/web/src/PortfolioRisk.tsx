import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle, ArrowRight, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import type { PortfolioAnalysis, PortfolioScenarioResult, RiskCheck, RiskLimits, StockSummary } from '../../../packages/core/src/types.ts';

type Row = { id: number; symbol: string; sector: string; quantity: string; entryPrice: string; stopPrice: string; borrowedAmount: string; estimatedFees: string };
type ScenarioDraft = { id: number; name: string; market: string; holdingDays: string; interest: string; sector: string; sectorMove: string };
type LimitsDraft = Record<Exclude<keyof RiskLimits, 'requireStops'>, string> & { requireStops: boolean };
type PortfolioResponse = { analysis: PortfolioAnalysis; scenarios: PortfolioScenarioResult[]; worstScenario: string | null; checks: RiskCheck[] };

const rupees = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const pct = (n: number | null) => n === null ? '—' : `${n.toFixed(2)}%`;
const signedPct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const num = (s: string) => s.trim() === '' ? NaN : Number(s);
const LIMIT_FIELDS: { key: Exclude<keyof RiskLimits, 'requireStops'>; label: string; unit: string }[] = [
  { key: 'maxPositionPct', label: 'Max per position', unit: '% of capital' },
  { key: 'maxSectorPct', label: 'Max per sector', unit: '% of capital' },
  { key: 'maxLeverage', label: 'Max leverage', unit: '× capital' },
  { key: 'maxRiskPerPositionPct', label: 'Max risk per position', unit: '% of capital to stop' },
  { key: 'maxTotalRiskPct', label: 'Max total risk', unit: '% of capital, all stops hit' },
  { key: 'maxScenarioLossPct', label: 'Max scenario loss', unit: '% of capital' }
];
const CHECK_LABELS: Record<keyof RiskLimits, string> = {
  maxPositionPct: 'Position size', maxSectorPct: 'Sector concentration', maxLeverage: 'Leverage',
  maxRiskPerPositionPct: 'Risk per position', maxTotalRiskPct: 'Total risk to stops', maxScenarioLossPct: 'Scenario loss', requireStops: 'Stops set'
};
let nextId = 1;

function rowFor(stock: StockSummary, budget = 50000): Row {
  return {
    id: nextId++, symbol: stock.symbol, sector: stock.sector,
    quantity: String(Math.max(1, Math.floor(budget / stock.lastClose))), entryPrice: String(stock.lastClose),
    stopPrice: (stock.lastClose * 0.92).toFixed(2), borrowedAmount: '0', estimatedFees: '40'
  };
}
const scenarioDraft = (name: string, market: string, sector = '', sectorMove = ''): ScenarioDraft =>
  ({ id: nextId++, name, market, holdingDays: '30', interest: '12', sector, sectorMove });

export default function PortfolioRisk({ stocks }: { stocks: StockSummary[] }) {
  const [capital, setCapital] = useState('500000');
  const [rows, setRows] = useState<Row[]>([]);
  const [scenarios, setScenarios] = useState<ScenarioDraft[]>(() => [scenarioDraft('Flat', '0'), scenarioDraft('Market −10%', '-10'), scenarioDraft('Sector shock', '-3', '', '-20'), scenarioDraft('Rally +8%', '8')]);
  const [limits, setLimits] = useState<LimitsDraft>({ maxPositionPct: '20', maxSectorPct: '35', maxLeverage: '1.5', maxRiskPerPositionPct: '1', maxTotalRiskPct: '5', maxScenarioLossPct: '10', requireStops: true });
  const [result, setResult] = useState<PortfolioResponse | null>(null);
  const [ranWith, setRanWith] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (stocks.length < 3 || rows.length > 0) return;
    setRows([rowFor(stocks[0], 120000), rowFor(stocks[1], 90000), rowFor(stocks[2], 60000)]);
    setScenarios(ss => ss.map(s => s.name === 'Sector shock' && !s.sector ? { ...s, sector: stocks[0].sector } : s));
  }, [stocks, rows.length]);

  const sectors = useMemo(() => [...new Set(rows.map(r => r.sector))], [rows]);
  const request = useMemo(() => ({
    portfolio: {
      capital: num(capital),
      positions: rows.map(r => ({ symbol: r.symbol, sector: r.sector, quantity: num(r.quantity), entryPrice: num(r.entryPrice), stopPrice: r.stopPrice.trim() === '' ? null : num(r.stopPrice), borrowedAmount: num(r.borrowedAmount), estimatedFees: num(r.estimatedFees) }))
    },
    scenarios: scenarios.map(s => ({
      name: s.name, marketMovePct: num(s.market), holdingDays: num(s.holdingDays), annualInterestPct: num(s.interest),
      sectorMovesPct: s.sector && sectors.includes(s.sector) && s.sectorMove.trim() !== '' ? { [s.sector]: num(s.sectorMove) } : {}
    })),
    limits: { ...Object.fromEntries(LIMIT_FIELDS.map(f => [f.key, limits[f.key].trim() === '' ? null : num(limits[f.key])])), requireStops: limits.requireStops }
  }), [capital, rows, scenarios, limits, sectors]);
  const requestJson = JSON.stringify(request);
  const stale = result !== null && ranWith !== requestJson;

  async function run(e: FormEvent) {
    e.preventDefault(); setLoading(true); setErrors([]);
    try {
      const response = await fetch('/api/portfolio-scenarios', { method: 'POST', headers: { 'content-type': 'application/json' }, body: requestJson });
      const body = await response.json();
      if (!response.ok) { setErrors(body.details ?? [body.error ?? 'Request failed']); return; }
      setResult(body as PortfolioResponse); setRanWith(requestJson);
    } catch (err) { setErrors([err instanceof Error ? err.message : 'Request failed']); }
    finally { setLoading(false); }
  }

  const updateRow = (id: number, patch: Partial<Row>) => setRows(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r));
  const updateScenario = (id: number, patch: Partial<ScenarioDraft>) => setScenarios(ss => ss.map(s => s.id === id ? { ...s, ...patch } : s));
  const unused = stocks.filter(s => !rows.some(r => r.symbol === s.symbol));
  const cell = (value: string, onChange: (v: string) => void, label: string, placeholder?: string) =>
    <input type="number" step="any" aria-label={label} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)}/>;

  return <form className="risk-page" onSubmit={run}>
    <div className="panel risk-inputs">
      <div className="section-head"><div><p className="eyebrow">HYPOTHETICAL HOLDINGS</p><h3>Positions</h3></div><span className="tag">Synthetic data · long only</span></div>
      <label className="form-field risk-capital"><span>Account capital (₹)</span><input type="number" step="any" value={capital} onChange={e => setCapital(e.target.value)}/></label>
      <div className="table-scroll"><table className="risk-table">
        <thead><tr><th>Instrument</th><th>Qty</th><th>Entry ₹</th><th>Stop ₹</th><th>Borrowed MTF ₹</th><th>Fees ₹ (round trip)</th><th aria-label="Remove"/></tr></thead>
        <tbody>{rows.map(r => <tr key={r.id}>
          <td><select aria-label="Instrument" value={r.symbol} onChange={e => { const s = stocks.find(x => x.symbol === e.target.value); if (s) updateRow(r.id, { symbol: s.symbol, sector: s.sector, entryPrice: String(s.lastClose), stopPrice: (s.lastClose * 0.92).toFixed(2) }); }}>
            {[stocks.find(s => s.symbol === r.symbol), ...unused].filter((s): s is StockSummary => !!s).map(s => <option key={s.symbol} value={s.symbol}>{s.symbol}</option>)}
          </select><small>{r.sector}</small></td>
          <td>{cell(r.quantity, v => updateRow(r.id, { quantity: v }), `${r.symbol} quantity`)}</td>
          <td>{cell(r.entryPrice, v => updateRow(r.id, { entryPrice: v }), `${r.symbol} entry price`)}</td>
          <td>{cell(r.stopPrice, v => updateRow(r.id, { stopPrice: v }), `${r.symbol} stop price`, 'none')}</td>
          <td>{cell(r.borrowedAmount, v => updateRow(r.id, { borrowedAmount: v }), `${r.symbol} borrowed amount`)}</td>
          <td>{cell(r.estimatedFees, v => updateRow(r.id, { estimatedFees: v }), `${r.symbol} fees`)}</td>
          <td><button type="button" className="icon-btn" aria-label={`Remove ${r.symbol}`} onClick={() => setRows(rs => rs.filter(x => x.id !== r.id))}><Trash2 size={15}/></button></td>
        </tr>)}</tbody>
      </table></div>
      <button type="button" className="text-btn" disabled={!unused.length} onClick={() => unused[0] && setRows(rs => [...rs, rowFor(unused[0])])}><Plus size={15}/> Add position</button>

      <div className="risk-split">
        <div><p className="eyebrow risk-sub">YOUR RISK LIMITS</p><p className="muted">Leave blank to skip a limit.</p>
          <div className="limit-grid">{LIMIT_FIELDS.map(f => <label key={f.key} className="form-field"><span>{f.label}</span>
            <input type="number" step="any" value={limits[f.key]} onChange={e => setLimits(l => ({ ...l, [f.key]: e.target.value }))}/><small>{f.unit}</small></label>)}
            <label className="check-field"><input type="checkbox" checked={limits.requireStops} onChange={e => setLimits(l => ({ ...l, requireStops: e.target.checked }))}/> Every position needs a stop</label>
          </div>
        </div>
        <div><p className="eyebrow risk-sub">SCENARIOS TO COMPARE</p><p className="muted">Hypothetical price moves, not forecasts. A sector move overrides the market move for that sector.</p>
          {scenarios.map(s => <div key={s.id} className="scenario-row">
            <input aria-label="Scenario name" value={s.name} onChange={e => updateScenario(s.id, { name: e.target.value })}/>
            <label><span>Market %</span>{cell(s.market, v => updateScenario(s.id, { market: v }), `${s.name} market move`)}</label>
            <label><span>Sector</span><select value={s.sector} onChange={e => updateScenario(s.id, { sector: e.target.value })}><option value="">—</option>{sectors.map(x => <option key={x}>{x}</option>)}</select></label>
            <label><span>Sector %</span>{cell(s.sectorMove, v => updateScenario(s.id, { sectorMove: v }), `${s.name} sector move`)}</label>
            <label><span>Days</span>{cell(s.holdingDays, v => updateScenario(s.id, { holdingDays: v }), `${s.name} holding days`)}</label>
            <label><span>MTF %/yr</span>{cell(s.interest, v => updateScenario(s.id, { interest: v }), `${s.name} interest`)}</label>
            <button type="button" className="icon-btn" aria-label={`Remove scenario ${s.name}`} onClick={() => setScenarios(ss => ss.filter(x => x.id !== s.id))}><Trash2 size={15}/></button>
          </div>)}
          <button type="button" className="text-btn" disabled={scenarios.length >= 4} onClick={() => setScenarios(ss => [...ss, scenarioDraft(`Scenario ${ss.length + 1}`, '0')])}><Plus size={15}/> Add scenario</button>
        </div>
      </div>
      {errors.length > 0 && <div role="alert" className="error"><ul>{errors.map(e => <li key={e}>{e}</li>)}</ul></div>}
      <button className="primary" type="submit" disabled={loading || rows.length === 0}>{loading ? 'Analysing…' : 'Analyse portfolio'} <ArrowRight size={17}/></button>
    </div>

    {result && <div className={`risk-results ${stale ? 'is-stale' : ''}`}>
      {stale && <p className="stale-note" role="status"><AlertTriangle size={14}/> Inputs changed since this analysis. Run it again to update.</p>}
      <div className="metrics">
        {[
          ['Gross exposure', rupees.format(result.analysis.grossExposure), `${result.analysis.leverage.toFixed(2)}× capital`],
          ['Cash remaining', rupees.format(result.analysis.cashRemaining), `${rupees.format(result.analysis.borrowedTotal)} borrowed`],
          ['Effective positions', result.analysis.effectivePositions.toFixed(2), `of ${result.analysis.positions.length} · HHI ${result.analysis.herfindahl.toFixed(3)}`],
          ['Risk if all stops hit', result.analysis.totalRiskToStop === null ? 'Unknown' : rupees.format(result.analysis.totalRiskToStop), result.analysis.totalRiskToStop === null ? `No stop: ${result.analysis.positionsWithoutStop.join(', ')}` : `${pct(result.analysis.totalRiskToStopPct)} of capital, incl. fees`]
        ].map(([label, value, sub]) => <div key={label} className="metric panel"><div className="metric-head"><span>{label}</span></div><div className="metric-value risk-value">{value}</div><div className="metric-sub">{sub}</div></div>)}
      </div>

      <div className="risk-grid">
        <div className="panel risk-checks"><div className="section-head"><div><p className="eyebrow">LIMIT CHECKS</p><h3>{result.checks.filter(c => c.status === 'breach').length} breached</h3></div><ShieldAlert size={18} color="#86a4e6"/></div>
          {result.checks.length === 0 && <p className="muted">No limits set.</p>}
          {result.checks.map(c => <div key={c.id} className={`check-item ${c.status}`}><span className="check-status">{c.status === 'not-evaluable' ? "Can't check" : c.status === 'breach' ? 'Breach' : 'Pass'}</span><div><strong>{CHECK_LABELS[c.id]}</strong><p>{c.message}</p></div></div>)}
        </div>
        <div className="panel"><div className="section-head"><div><p className="eyebrow">SECTOR EXPOSURE</p><h3>% of capital</h3></div></div>
          {result.analysis.sectors.map(s => <div key={s.sector} className="bar-row"><div className="bar-label"><span>{s.sector}</span><strong>{pct(s.capitalPct)}</strong></div>
            <div className="bar-track"><div className="bar-fill" style={{ width: `${Math.min(100, s.capitalPct)}%` }}/></div><small>{s.symbols.join(', ')} · {pct(s.weightPct)} of exposure</small></div>)}
        </div>
      </div>

      <div className="panel"><div className="section-head"><div><p className="eyebrow">SCENARIO COMPARISON</p><h3>Net of fees and simple-interest financing</h3></div>{result.worstScenario && <span className="tag">Worst: {result.worstScenario}</span>}</div>
        <div className="table-scroll"><table className="risk-table compare">
          <thead><tr><th/>{result.scenarios.map(s => <th key={s.name}>{s.name}</th>)}</tr></thead>
          <tbody>
            <tr><td>Net P&L</td>{result.scenarios.map(s => <td key={s.name} className={s.netPnl >= 0 ? 'up' : 'down'}>{rupees.format(s.netPnl)}</td>)}</tr>
            <tr><td>Return on capital</td>{result.scenarios.map(s => <td key={s.name} className={s.returnOnCapitalPct >= 0 ? 'up' : 'down'}>{signedPct(s.returnOnCapitalPct)}</td>)}</tr>
            <tr><td>Ending cash</td>{result.scenarios.map(s => <td key={s.name}>{rupees.format(s.endingCash)}</td>)}</tr>
            <tr><td>MTF interest</td>{result.scenarios.map(s => <td key={s.name}>−{rupees.format(s.financingCost)}</td>)}</tr>
            <tr><td>Fees</td>{result.scenarios.map(s => <td key={s.name}>−{rupees.format(s.estimatedFees)}</td>)}</tr>
            <tr><td>Worst position</td>{result.scenarios.map(s => <td key={s.name}>{s.worstPosition}</td>)}</tr>
            <tr><td>Warnings</td>{result.scenarios.map(s => { const short = s.positions.filter(p => p.loanShortfall > 0).map(p => p.symbol); return <td key={s.name} className="warn-cell">{[s.lossExceedsCapital && 'Loss exceeds capital', short.length && `Proceeds don't repay MTF loan: ${short.join(', ')}`].filter(Boolean).join('; ') || '—'}</td>; })}</tr>
          </tbody>
        </table></div>
        <p className="tiny-note"><AlertTriangle size={14}/> Hypothetical calculation on synthetic prices. Positions are valued at entry price. Excludes slippage, taxes, gaps through stops, margin calls and broker-specific charges unless included in fees. Not a forecast or recommendation.</p>
      </div>
    </div>}
  </form>;
}
