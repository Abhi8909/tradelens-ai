import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKTEST_ENGINE_VERSION, evaluateCondition, runBacktest, validateBacktestConfig, wilsonInterval,
  type BacktestConfig, type Condition, type Strategy
} from '../src/backtest.ts';
import type { Candle } from '../src/types.ts';

const near = (actual: number | null, expected: number, eps = 1e-9, label = '') =>
  assert.ok(actual !== null && Math.abs(actual - expected) <= eps * Math.max(1, Math.abs(expected)), `${label} expected ${expected}, got ${actual}`);
const bar = (date: string, open: number, high: number, low: number, close: number): Candle => ({ date, open, high, low, close, volume: 1000 });

// Reference fixture, computed by hand (see comments). Weekday dates; periods: train ≤ 01-14, test ≤ 01-16, then out-of-sample.
const REFERENCE: Candle[] = [
  bar('2026-01-05', 100, 101, 99, 100),
  bar('2026-01-06', 100, 101, 99, 100),
  bar('2026-01-07', 100, 103, 100, 102), // close 102 > prior 2 highs (101) → buy next open
  bar('2026-01-08', 104, 106, 103, 105), // BUY 95 @ 104
  bar('2026-01-09', 105, 108, 104, 107),
  bar('2026-01-12', 110, 116, 109, 115), // target 114.40 hit intraday; close 115 > 108 → buy next open
  bar('2026-01-13', 115, 116, 114, 115), // BUY 94 @ 115, stop 109.25
  bar('2026-01-14', 108, 109, 100, 101), // gaps below the stop → sell at the open, 108
  bar('2026-01-15', 101, 102, 100, 101),
  bar('2026-01-16', 101, 102, 100, 101),
  bar('2026-01-19', 101, 102, 100, 101),
  bar('2026-01-20', 101, 102, 100, 101)
];
const breakout: Strategy = { name: 'Breakout', entry: [{ kind: 'breakout-high', lookback: 2 }], exit: [], stopLossPct: 5, takeProfitPct: 10, maxHoldingDays: null };
const config = (overrides: Partial<BacktestConfig> = {}, strategy: Partial<Strategy> = {}): BacktestConfig => ({
  initialCapital: 10000, strategy: { ...breakout, ...strategy }, sizing: { mode: 'fraction', fraction: 1 },
  costs: { perOrder: 20, buyPct: 0.1, sellPct: 0.1, slippageBps: 0 }, periods: { trainEnd: '2026-01-14', testEnd: '2026-01-16' },
  ...overrides
});

test('reference fixture: fills, costs, exits and metrics match hand calculation', () => {
  const r = runBacktest(config(), REFERENCE);
  const train = r.periods.train;
  assert.equal(train.trades.length, 2);
  const [t1, t2] = train.trades;
  // Trade 1: qty = floor((10000 − 20) / (104 × 1.001)) = 95; fees 29.88 + 30.868; target 104 × 1.10 = 114.4
  assert.deepEqual([t1.entryDate, t1.entryPrice, t1.quantity, t1.exitDate, t1.exitReason, t1.barsHeld], ['2026-01-08', 104, 95, '2026-01-12', 'target', 3]);
  near(t1.exitPrice, 114.4);
  near(t1.fees, 29.88 + 30.868);
  near(t1.netPnl, 927.252);
  // Trade 2: qty = floor((10927.252 − 20) / (115 × 1.001)) = 94; stop 109.25; gap open 108 fills at 108
  assert.deepEqual([t2.entryDate, t2.quantity, t2.exitDate, t2.exitPrice, t2.exitReason, t2.barsHeld], ['2026-01-13', 94, '2026-01-14', 108, 'stop', 2]);
  near(t2.netPnl, -718.962);
  const m = train.metrics;
  near(m.finalEquity, 10208.29);
  near(m.totalReturnPct, 2.0829);
  near(m.maxDrawdownPct, (718.962 / 10927.252) * 100);
  assert.equal(m.winRatePct, 50);
  near(m.payoffRatio, 927.252 / 718.962);
  near(m.profitFactor, 927.252 / 718.962);
  near(m.expectancy, (927.252 - 718.962) / 2);
  near(m.exposurePct, 37.5, 1e-12, 'in market at the close of 3 of 8 sessions');
  near(m.totalFees, 29.88 + 30.868 + 30.81 + 30.152);
  // Benchmark: 99 @ 100 on the first open, sold at the last close 101 → 10039.101
  near(m.benchmarkReturnPct, 0.39101);
  near(m.excessReturnPct, 2.0829 - 0.39101);
  assert.deepEqual(train.equityCurve.map((p) => Math.round(p.equity * 1000) / 1000),
    [10000, 10000, 10000, 10065.12, 10255.12, 10927.252, 10896.442, 10208.29]);
  assert.equal(r.periods.test.trades.length, 0);
  assert.equal(r.periods.outOfSample.trades.length, 0);
  assert.deepEqual([r.periods.test.metrics.startDate, r.periods.outOfSample.metrics.startDate], ['2026-01-15', '2026-01-19']);
  assert.ok(r.warnings.some((w) => /No trades in the test period/.test(w)));
  assert.ok(r.warnings.some((w) => /Only 2 trades in the train period/.test(w)));
});

test('slippage moves every fill against the trader and is reported separately from fees', () => {
  const r = runBacktest(config({ costs: { perOrder: 0, buyPct: 0, sellPct: 0, slippageBps: 10 } }), REFERENCE);
  const t1 = r.periods.train.trades[0];
  near(t1.entryPrice, 104 * 1.001);
  near(t1.exitPrice, 114.4 * 0.999, 1e-9, 'target is set from the raw entry price');
  near(t1.slippage, t1.quantity * (104 * 0.001 + 114.4 * 0.001));
  near(t1.netPnl, t1.grossPnl - t1.slippage - t1.fees);
  assert.equal(t1.fees, 0);
});

test('stop and target inside the same bar resolve to the stop', () => {
  const candles = [...REFERENCE.slice(0, 4), bar('2026-01-09', 105, 120, 90, 105), ...REFERENCE.slice(5)];
  const t1 = runBacktest(config(), candles).periods.train.trades[0];
  assert.equal(t1.exitReason, 'stop');
  near(t1.exitPrice, 98.8);
  assert.equal(t1.exitDate, '2026-01-09');
});

test('stop is checked on the entry bar after the open fill', () => {
  const candles = [...REFERENCE.slice(0, 3), bar('2026-01-08', 104, 105, 95, 96), ...REFERENCE.slice(4)];
  const t1 = runBacktest(config(), candles).periods.train.trades[0];
  assert.deepEqual([t1.entryDate, t1.exitDate, t1.exitReason, t1.barsHeld], ['2026-01-08', '2026-01-08', 'stop', 1]);
  near(t1.exitPrice, 98.8);
});

test('max holding days and rule exits fill at the next open', () => {
  const held = runBacktest(config({}, { stopLossPct: null, takeProfitPct: null, maxHoldingDays: 2 }), REFERENCE).periods.train.trades[0];
  assert.deepEqual([held.entryDate, held.exitDate, held.exitPrice, held.exitReason], ['2026-01-08', '2026-01-12', 110, 'max-hold']);
  const rule = runBacktest(config({}, { stopLossPct: null, takeProfitPct: null, exit: [{ kind: 'rsi-above', period: 2, level: 90 }] }), REFERENCE).periods.train.trades[0];
  assert.equal(rule.exitReason, 'rule');
  assert.equal(rule.exitPrice, REFERENCE.find((c) => c.date === rule.exitDate)!.open);
});

test('positions never carry across period boundaries', () => {
  const r = runBacktest(config({ periods: { trainEnd: '2026-01-09', testEnd: '2026-01-14' } }), REFERENCE);
  const last = r.periods.train.trades.at(-1)!;
  assert.deepEqual([last.exitDate, last.exitPrice, last.exitReason], ['2026-01-09', 107, 'end-of-period']);
  assert.equal(r.periods.test.equityCurve[0].equity, 10000, 'each period starts flat with the initial capital');
});

test('risk sizing limits the loss to the stop and needs a stop', () => {
  const r = runBacktest(config({ sizing: { mode: 'risk', riskPct: 1 } }), REFERENCE);
  const t1 = r.periods.train.trades[0];
  assert.equal(t1.quantity, Math.floor(100 / (104 - 98.8)));
  const invalid = validateBacktestConfig({ ...config({ sizing: { mode: 'risk', riskPct: 1 } }), strategy: { ...breakout, stopLossPct: null } });
  assert.ok(!invalid.ok && /needs a stopLossPct/.test(invalid.errors.join(' ')));
});

test('evaluateCondition uses only the history it is given and needs enough of it', () => {
  const up = [10, 10, 10, 10, 11, 12].map((c, i) => bar(`2026-02-0${i + 2}`, c, c + 1, c - 1, c));
  const cases: [Condition, boolean][] = [
    [{ kind: 'close-above-sma', period: 3 }, true], [{ kind: 'close-below-sma', period: 3 }, false],
    [{ kind: 'sma-cross-above', fast: 2, slow: 4 }, false], [{ kind: 'breakout-high', lookback: 2 }, false],
    [{ kind: 'breakdown-low', lookback: 2 }, false], [{ kind: 'rsi-above', period: 3, level: 60 }, true], [{ kind: 'rsi-below', period: 3, level: 60 }, false]
  ];
  for (const [c, expected] of cases) assert.equal(evaluateCondition(c, up), expected, c.kind);
  assert.equal(evaluateCondition({ kind: 'sma-cross-above', fast: 2, slow: 4 }, up.slice(0, 5)), true, 'fast crosses above slow on the 11 close');
  assert.equal(evaluateCondition({ kind: 'breakout-high', lookback: 2 }, [...up.slice(0, 4), bar('2026-02-06', 12, 13, 11, 12)]), true);
  assert.equal(evaluateCondition({ kind: 'close-above-sma', period: 10 }, up), false, 'insufficient history is never a signal');
});

test('wilsonInterval matches known values', () => {
  const [lo, hi] = wilsonInterval(5, 10)!;
  near(lo, 23.659309, 1e-6);
  near(hi, 76.340691, 1e-6);
  assert.deepEqual(wilsonInterval(0, 0), null);
  const [zlo, zhi] = wilsonInterval(0, 20)!;
  assert.equal(zlo, 0);
  assert.ok(zhi > 10 && zhi < 20);
  assert.equal(wilsonInterval(20, 20)![1], 100, 'all wins: upper bound is exactly 100');
});

test('validateBacktestConfig reports every problem', () => {
  assert.ok(validateBacktestConfig(config()).ok);
  const result = validateBacktestConfig({
    initialCapital: 0, strategy: { name: '', entry: [{ kind: 'sma-cross-above', fast: 20, slow: 10 }, { kind: 'magic' }], exit: [{ kind: 'rsi-below', period: 1, level: 120 }], stopLossPct: 100, takeProfitPct: -1, maxHoldingDays: 1.5 },
    sizing: { mode: 'fraction', fraction: 2 }, costs: { perOrder: -1, buyPct: 9, sellPct: 0, slippageBps: 900 }, periods: { trainEnd: '2026-02-01', testEnd: '2026-01-01' }
  });
  assert.ok(!result.ok);
  for (const fragment of ['initialCapital', 'name', 'fast must be shorter', 'unknown condition', 'RSI period', 'RSI level', 'stopLossPct', 'takeProfitPct', 'maxHoldingDays', 'fraction', 'perOrder', 'buyPct', 'slippageBps', 'trainEnd must be before']) {
    assert.ok(result.errors.some((e) => e.includes(fragment)), `missing error about ${fragment}`);
  }
  assert.ok(!validateBacktestConfig({ ...config(), strategy: { ...breakout, entry: [] } }).ok, 'entry rule required');
});

test('runBacktest rejects invalid or unordered candles and empty periods', () => {
  assert.throws(() => runBacktest(config(), [REFERENCE[1], REFERENCE[0], ...REFERENCE.slice(2)]), /increasing date order/);
  assert.throws(() => runBacktest(config(), [{ ...REFERENCE[0], high: 50 }, ...REFERENCE.slice(1)]), /valid/);
  assert.throws(() => runBacktest(config({ periods: { trainEnd: '2026-01-19', testEnd: '2026-01-20' } }), REFERENCE), /test period/);
  assert.throws(() => runBacktest(config({ periods: { trainEnd: '2026-01-14', testEnd: '2026-01-19' } }), REFERENCE), /outOfSample period/);
  assert.throws(() => runBacktest(config({ periods: { trainEnd: '2026-01-05', testEnd: '2026-01-14' } }), REFERENCE), /train period/);
});

// ---------- property-based tests (seeded, no external dependency) ----------

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; };
}
const r2 = (n: number) => Math.round(n * 100) / 100;
function randomCandles(random: () => number, count: number): Candle[] {
  const out: Candle[] = [];
  const d = new Date('2025-01-01T00:00:00.000Z');
  let price = 50 + random() * 500;
  while (out.length < count) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) {
      const open = r2(Math.max(1, price * (1 + (random() - 0.5) * 0.04)));
      const close = r2(Math.max(1, open * (1 + (random() - 0.5) * 0.06)));
      const high = r2(Math.max(open, close) * (1 + random() * 0.02));
      const low = r2(Math.max(0.5, Math.min(open, close) * (1 - random() * 0.02)));
      out.push({ date: d.toISOString().slice(0, 10), open, high: Math.max(high, open, close), low: Math.min(low, open, close), close, volume: Math.floor(random() * 1e5) });
      price = close;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
function randomCondition(random: () => number): Condition {
  const pick = Math.floor(random() * 8);
  const p = 2 + Math.floor(random() * 20);
  return [
    { kind: 'close-above-sma', period: p }, { kind: 'close-below-sma', period: p },
    { kind: 'sma-cross-above', fast: 2 + Math.floor(random() * 5), slow: 8 + Math.floor(random() * 15) },
    { kind: 'sma-cross-below', fast: 2 + Math.floor(random() * 5), slow: 8 + Math.floor(random() * 15) },
    { kind: 'rsi-above', period: Math.min(p, 14), level: 30 + random() * 40 }, { kind: 'rsi-below', period: Math.min(p, 14), level: 30 + random() * 40 },
    { kind: 'breakout-high', lookback: p }, { kind: 'breakdown-low', lookback: p }
  ][pick] as Condition;
}
function randomCase(seed: number, zeroCosts = false) {
  const random = rng(seed);
  const candles = randomCandles(random, 120 + Math.floor(random() * 80));
  const stop = random() < 0.6 ? 1 + random() * 10 : null;
  const cfg: BacktestConfig = {
    initialCapital: 10_000 + random() * 500_000,
    strategy: {
      name: `random-${seed}`,
      entry: Array.from({ length: 1 + Math.floor(random() * 2) }, () => randomCondition(random)),
      exit: Array.from({ length: Math.floor(random() * 2) }, () => randomCondition(random)),
      stopLossPct: stop, takeProfitPct: random() < 0.5 ? 2 + random() * 20 : null, maxHoldingDays: random() < 0.5 ? 1 + Math.floor(random() * 15) : null
    },
    sizing: stop !== null && random() < 0.5 ? { mode: 'risk', riskPct: 0.5 + random() * 3 } : { mode: 'fraction', fraction: 0.2 + random() * 0.8 },
    costs: zeroCosts ? { perOrder: 0, buyPct: 0, sellPct: 0, slippageBps: 0 } : { perOrder: random() * 40, buyPct: random() * 0.3, sellPct: random() * 0.3, slippageBps: random() * 50 },
    periods: { trainEnd: candles[Math.floor(candles.length * 0.5)].date, testEnd: candles[Math.floor(candles.length * 0.75)].date }
  };
  return { candles, cfg };
}
const RUNS = 250;

test('property: cash accounting closes, fills are real prices and trades never overlap', () => {
  let totalTrades = 0;
  for (let seed = 1; seed <= RUNS; seed++) {
    const { candles, cfg } = randomCase(seed);
    const byDate = new Map(candles.map((c) => [c.date, c]));
    const result = runBacktest(cfg, candles);
    for (const period of Object.values(result.periods)) {
      const { trades, metrics, equityCurve } = period;
      totalTrades += trades.length;
      near(metrics.finalEquity, cfg.initialCapital + trades.reduce((a, t) => a + t.netPnl, 0), 1e-9, `seed ${seed} accounting`);
      assert.ok(equityCurve.every((p) => p.equity > 0), `seed ${seed}: equity stays positive without leverage`);
      assert.ok(metrics.maxDrawdownPct >= 0 && metrics.maxDrawdownPct <= 100 && metrics.exposurePct >= 0 && metrics.exposurePct <= 100);
      if (metrics.winRate95) assert.ok(metrics.winRate95[0] <= metrics.winRatePct! && metrics.winRatePct! <= metrics.winRate95[1]);
      trades.forEach((t, i) => {
        const entryBar = byDate.get(t.entryDate)!;
        const exitBar = byDate.get(t.exitDate)!;
        assert.equal(t.entryRawPrice, entryBar.open, `seed ${seed}: entries fill at the open`);
        assert.ok(t.exitRawPrice >= exitBar.low - 1e-9 && t.exitRawPrice <= exitBar.high + 1e-9, `seed ${seed}: exit inside the bar's range`);
        assert.ok(t.entryDate >= metrics.startDate && t.exitDate <= metrics.endDate, 'trade inside its period');
        assert.ok(t.quantity >= 1 && Number.isInteger(t.quantity) && t.fees >= 0 && t.slippage >= -1e-9);
        near(t.netPnl, t.grossPnl - t.fees - t.slippage, 1e-9, `seed ${seed} P&L decomposition`);
        if (i > 0) assert.ok(t.entryDate > trades[i - 1].exitDate, `seed ${seed}: no overlapping positions`);
      });
    }
  }
  assert.ok(totalTrades > 1000, `property runs should exercise many trades (got ${totalTrades})`);
});

test('property: appending future candles never changes earlier decisions (no look-ahead)', () => {
  for (let seed = 1; seed <= RUNS; seed++) {
    const { candles, cfg } = randomCase(seed);
    const cut = Math.floor(candles.length * 0.9);
    const prefix = runBacktest(cfg, candles.slice(0, cut));
    const full = runBacktest(cfg, candles);
    assert.deepEqual(prefix.periods.train, full.periods.train, `seed ${seed}: train unchanged`);
    assert.deepEqual(prefix.periods.test, full.periods.test, `seed ${seed}: test unchanged`);
    const settled = prefix.periods.outOfSample.trades.filter((t) => t.exitReason !== 'end-of-period');
    assert.deepEqual(full.periods.outOfSample.trades.slice(0, settled.length), settled, `seed ${seed}: settled out-of-sample trades unchanged`);
  }
});

test('property: with zero costs, net equals gross and benchmark equals price change', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const { candles, cfg } = randomCase(seed, true);
    const result = runBacktest(cfg, candles);
    for (const period of Object.values(result.periods)) {
      for (const t of period.trades) { assert.equal(t.fees, 0); assert.equal(t.slippage, 0); near(t.netPnl, t.grossPnl); }
      assert.equal(period.metrics.totalFees + period.metrics.totalSlippage, 0);
    }
  }
});

test('reproducibility: identical inputs give byte-identical results; any input change changes the run id', () => {
  const { candles, cfg } = randomCase(42);
  const a = runBacktest(cfg, candles);
  const b = runBacktest(structuredClone(cfg), structuredClone(candles));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.engineVersion, BACKTEST_ENGINE_VERSION);
  assert.match(a.runId, /^[0-9a-f]{14}$/);
  const reordered = { periods: cfg.periods, costs: cfg.costs, sizing: cfg.sizing, strategy: cfg.strategy, initialCapital: cfg.initialCapital };
  assert.equal(runBacktest(reordered, candles).runId, a.runId, 'key order does not matter');
  const changedCandle = candles.map((c, i) => i === 10 ? { ...c, volume: c.volume + 1 } : c);
  assert.notEqual(runBacktest(cfg, changedCandle).runId, a.runId, 'data change');
  assert.notEqual(runBacktest({ ...cfg, costs: { ...cfg.costs, perOrder: cfg.costs.perOrder + 0.01 } }, candles).runId, a.runId, 'config change');
});
