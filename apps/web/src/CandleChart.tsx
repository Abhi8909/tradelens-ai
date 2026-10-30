import { useEffect, useId, useMemo, useState } from 'react';
import { CANDLE_RANGES, candleGeometry, summarizeCandles, type CandleRange, type CandleShape } from '../../../packages/core/src/chart.ts';
import type { Candle } from '../../../packages/core/src/types.ts';

type CandlesPayload = { source: string; symbol: string; requested: number; count: number; candles: Candle[] };
const WIDTH = 600;
const HEIGHT = 160;
const COLORS = { up: '#48d9aa', down: '#fa8290', flat: '#8190ad' };
const rupees = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

export default function CandleChart({ symbol }: { symbol: string }) {
  const [range, setRange] = useState<CandleRange>(60);
  const [payload, setPayload] = useState<CandlesPayload | null>(null);
  const [error, setError] = useState('');
  const summaryId = useId();

  useEffect(() => {
    const controller = new AbortController();
    setPayload(null); setError('');
    fetch(`/api/stocks/${encodeURIComponent(symbol)}/candles?limit=${range}`, { signal: controller.signal })
      .then(async res => { const body = await res.json(); if (!res.ok) throw new Error(body.error ?? 'Candle request failed'); return body as CandlesPayload; })
      .then(setPayload)
      .catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Failed to load candles'); });
    return () => controller.abort();
  }, [symbol, range]);

  const candles = useMemo(() => payload?.candles ?? [], [payload]);
  const summary = useMemo(() => summarizeCandles(candles), [candles]);
  const shapes = useMemo((): CandleShape[] | Error => {
    try { return candleGeometry(candles, WIDTH, HEIGHT, 6); } catch (err) { return err instanceof Error ? err : new Error('Invalid candles'); }
  }, [candles]);

  let body;
  if (error) body = <p role="alert" className="chart-state error">Cannot load candles: {error}</p>;
  else if (!payload) body = <p className="chart-state muted" aria-live="polite">Loading {range} demo sessions…</p>;
  else if (shapes instanceof Error) body = <p role="alert" className="chart-state error">Chart hidden: {shapes.message}.</p>;
  else if (!summary) body = <p className="chart-state muted">No demo candles are available for {symbol}.</p>;
  else body = <>
    <svg className="candle-svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-labelledby={summaryId}>
      {shapes.map(s => <g key={s.date} fill={COLORS[s.direction]} stroke={COLORS[s.direction]}>
        <title>{s.date}</title>
        <line x1={s.x} x2={s.x} y1={s.wickTop} y2={s.wickBottom} strokeWidth="1" vectorEffect="non-scaling-stroke"/>
        <rect x={s.x - s.bodyWidth / 2} y={s.bodyTop} width={s.bodyWidth} height={s.bodyHeight} stroke="none"/>
      </g>)}
    </svg>
    <p id={summaryId} className="chart-summary">
      {symbol}, {summary.sessions} synthetic sessions from {summary.firstDate} to {summary.lastDate}: opened at {rupees.format(summary.firstOpen)} and
      closed at {rupees.format(summary.lastClose)} ({pct(summary.changePct)}). Range high {rupees.format(summary.high)} on {summary.highDate},
      low {rupees.format(summary.low)} on {summary.lowDate}. {summary.upSessions} up and {summary.downSessions} down sessions.
    </p>
    {payload.count < payload.requested && <p className="chart-note">Only {payload.count} of {payload.requested} requested sessions exist in the demo history.</p>}
  </>;

  return <div className="candle-chart">
    <div className="chart-toolbar">
      <span className="chart-label">Daily candles · demo data</span>
      <div className="range-group" role="group" aria-label="Chart range">
        {CANDLE_RANGES.map(r => <button key={r} type="button" className={`range-btn ${r === range ? 'active' : ''}`} aria-pressed={r === range} onClick={() => setRange(r)}>{r}D</button>)}
      </div>
    </div>
    <div className="candle-plot">{body}</div>
  </div>;
}
