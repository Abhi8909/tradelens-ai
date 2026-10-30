import { isValidCandle } from './chart.ts';
import { rsi, sma } from './indicators.ts';
import type { Candle, Result } from './types.ts';

/**
 * Historical, hypothetical simulation of user-defined rules on past candles. Long-only, one instrument,
 * no leverage. Not a forecast: past results on this data do not predict future returns.
 */
export const BACKTEST_ENGINE_VERSION = 'backtest-1.0.0';

export type Condition =
  | { kind: 'close-above-sma' | 'close-below-sma'; period: number }
  | { kind: 'sma-cross-above' | 'sma-cross-below'; fast: number; slow: number }
  | { kind: 'rsi-above' | 'rsi-below'; period: number; level: number }
  | { kind: 'breakout-high' | 'breakdown-low'; lookback: number };
export type Strategy = {
  name: string;
  /** All must be true at a close to enter at the next open. */
  entry: Condition[];
  /** Any true at a close exits at the next open. */
  exit: Condition[];
  /** Percent below / above the raw entry price (before slippage). */
  stopLossPct: number | null; takeProfitPct: number | null; maxHoldingDays: number | null;
};
export type Sizing = { mode: 'fraction'; fraction: number } | { mode: 'risk'; riskPct: number };
/** Fees per fill = perOrder + notional × pct / 100. Slippage moves every fill against the trader. */
export type Costs = { perOrder: number; buyPct: number; sellPct: number; slippageBps: number };
/** train: date ≤ trainEnd; test: trainEnd < date ≤ testEnd; out-of-sample: date > testEnd. */
export type Periods = { trainEnd: string; testEnd: string };
export type BacktestConfig = { initialCapital: number; strategy: Strategy; sizing: Sizing; costs: Costs; periods: Periods };

export type ExitReason = 'rule' | 'stop' | 'target' | 'max-hold' | 'end-of-period';
export type Trade = {
  entryDate: string; entryRawPrice: number; entryPrice: number;
  exitDate: string; exitRawPrice: number; exitPrice: number; exitReason: ExitReason;
  quantity: number; barsHeld: number;
  grossPnl: number; fees: number; slippage: number; netPnl: number; returnPct: number;
};
export type EquityPoint = { date: string; equity: number; benchmark: number };
export type PeriodMetrics = {
  startDate: string; endDate: string; sessions: number;
  initialEquity: number; finalEquity: number; totalReturnPct: number; maxDrawdownPct: number;
  trades: number; wins: number; winRatePct: number | null; winRate95: [number, number] | null;
  avgWin: number | null; avgLoss: number | null; payoffRatio: number | null; profitFactor: number | null; expectancy: number | null;
  exposurePct: number; turnover: number; totalFees: number; totalSlippage: number; costDragPct: number; skippedEntries: number;
  benchmarkReturnPct: number; benchmarkMaxDrawdownPct: number; excessReturnPct: number; lowSample: boolean;
};
export type PeriodName = 'train' | 'test' | 'outOfSample';
export type PeriodResult = { metrics: PeriodMetrics; trades: Trade[]; equityCurve: EquityPoint[] };
export type BacktestResult = {
  engineVersion: string; runId: string; dataFirstDate: string; dataLastDate: string;
  periods: Record<PeriodName, PeriodResult>; warnings: string[];
};

export const LOW_SAMPLE_TRADES = 30;
const LIMITS = { maxConditions: 5, maxPeriod: 250, maxCapital: 1e12 } as const;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const int = (v: unknown, min: number, max: number): v is number => num(v) && Number.isInteger(v) && v >= min && v <= max;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- validation ----------

function validateCondition(raw: unknown, label: string, errors: string[]): Condition | null {
  if (!isRecord(raw)) { errors.push(`${label} must be an object`); return null; }
  const before = errors.length;
  switch (raw.kind) {
    case 'close-above-sma': case 'close-below-sma':
      if (!int(raw.period, 2, LIMITS.maxPeriod)) errors.push(`${label}: period must be a whole number from 2 to ${LIMITS.maxPeriod}`);
      return errors.length > before ? null : { kind: raw.kind, period: raw.period as number };
    case 'sma-cross-above': case 'sma-cross-below':
      if (!int(raw.fast, 2, LIMITS.maxPeriod) || !int(raw.slow, 2, LIMITS.maxPeriod)) errors.push(`${label}: fast and slow must be whole numbers from 2 to ${LIMITS.maxPeriod}`);
      else if ((raw.fast as number) >= (raw.slow as number)) errors.push(`${label}: fast must be shorter than slow`);
      return errors.length > before ? null : { kind: raw.kind, fast: raw.fast as number, slow: raw.slow as number };
    case 'rsi-above': case 'rsi-below':
      if (!int(raw.period, 2, 100)) errors.push(`${label}: RSI period must be a whole number from 2 to 100`);
      if (!num(raw.level) || raw.level < 0 || raw.level > 100) errors.push(`${label}: RSI level must be from 0 to 100`);
      return errors.length > before ? null : { kind: raw.kind, period: raw.period as number, level: raw.level as number };
    case 'breakout-high': case 'breakdown-low':
      if (!int(raw.lookback, 1, LIMITS.maxPeriod)) errors.push(`${label}: lookback must be a whole number from 1 to ${LIMITS.maxPeriod}`);
      return errors.length > before ? null : { kind: raw.kind, lookback: raw.lookback as number };
    default:
      errors.push(`${label}: unknown condition kind ${JSON.stringify(raw.kind)}`);
      return null;
  }
}

function conditions(raw: unknown, label: string, min: number, errors: string[]): Condition[] {
  if (!Array.isArray(raw) || raw.length < min || raw.length > LIMITS.maxConditions) {
    errors.push(`${label} must be a list of ${min}-${LIMITS.maxConditions} conditions`);
    return [];
  }
  return raw.map((c, i) => validateCondition(c, `${label} ${i + 1}`, errors)).filter((c): c is Condition => c !== null);
}

const nullableNumber = (raw: unknown, label: string, ok: (v: number) => boolean, rule: string, errors: string[]): number | null => {
  if (raw === null || raw === undefined) return null;
  if (!num(raw) || !ok(raw)) { errors.push(`${label} ${rule}, or null`); return null; }
  return raw;
};

export function validateBacktestConfig(input: unknown): Result<BacktestConfig> {
  if (!isRecord(input)) return { ok: false, errors: ['backtest config must be an object'] };
  const errors: string[] = [];
  const { initialCapital, strategy: s, sizing: z, costs: c, periods: p } = input;
  if (!num(initialCapital) || initialCapital <= 0 || initialCapital > LIMITS.maxCapital) errors.push('initialCapital must be greater than 0');
  let strategy: Strategy | null = null;
  if (!isRecord(s)) errors.push('strategy must be an object');
  else {
    const name = typeof s.name === 'string' ? s.name.trim() : '';
    if (!name || name.length > 60) errors.push('strategy name must be 1-60 characters');
    strategy = {
      name,
      entry: conditions(s.entry, 'entry condition', 1, errors),
      exit: conditions(s.exit ?? [], 'exit condition', 0, errors),
      stopLossPct: nullableNumber(s.stopLossPct, 'stopLossPct', (v) => v > 0 && v < 100, 'must be between 0 and 100', errors),
      takeProfitPct: nullableNumber(s.takeProfitPct, 'takeProfitPct', (v) => v > 0 && v <= 1000, 'must be greater than 0 and at most 1000', errors),
      maxHoldingDays: nullableNumber(s.maxHoldingDays, 'maxHoldingDays', (v) => Number.isInteger(v) && v >= 1 && v <= 1000, 'must be a whole number from 1 to 1000', errors)
    };
  }
  let sizing: Sizing | null = null;
  if (isRecord(z) && z.mode === 'fraction') {
    if (!num(z.fraction) || z.fraction <= 0 || z.fraction > 1) errors.push('sizing fraction must be greater than 0 and at most 1');
    else sizing = { mode: 'fraction', fraction: z.fraction };
  } else if (isRecord(z) && z.mode === 'risk') {
    if (!num(z.riskPct) || z.riskPct <= 0 || z.riskPct > 100) errors.push('sizing riskPct must be greater than 0 and at most 100');
    else sizing = { mode: 'risk', riskPct: z.riskPct };
    if (strategy && strategy.stopLossPct === null) errors.push('risk-based sizing needs a stopLossPct to measure risk per share');
  } else errors.push('sizing mode must be "fraction" or "risk"');
  let costs: Costs | null = null;
  if (!isRecord(c)) errors.push('costs must be an object');
  else {
    const bad = (key: string, max: number) => !num(c[key]) || (c[key] as number) < 0 || (c[key] as number) > max;
    if (bad('perOrder', 10_000)) errors.push('costs.perOrder must be from 0 to 10000');
    if (bad('buyPct', 5) || bad('sellPct', 5)) errors.push('costs.buyPct and costs.sellPct must be from 0 to 5 (%)');
    if (bad('slippageBps', 500)) errors.push('costs.slippageBps must be from 0 to 500');
    costs = { perOrder: c.perOrder as number, buyPct: c.buyPct as number, sellPct: c.sellPct as number, slippageBps: c.slippageBps as number };
  }
  let periods: Periods | null = null;
  if (!isRecord(p) || typeof p.trainEnd !== 'string' || typeof p.testEnd !== 'string' || !DATE.test(p.trainEnd) || !DATE.test(p.testEnd)) {
    errors.push('periods need trainEnd and testEnd as YYYY-MM-DD');
  } else if (p.trainEnd >= p.testEnd) errors.push('periods.trainEnd must be before periods.testEnd');
  else periods = { trainEnd: p.trainEnd, testEnd: p.testEnd };
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { initialCapital: initialCapital as number, strategy: strategy!, sizing: sizing!, costs: costs!, periods: periods! } };
}

// ---------- signals (history only) ----------

/** Sessions of history a condition needs before it can be true. */
export function conditionLookback(c: Condition): number {
  switch (c.kind) {
    case 'close-above-sma': case 'close-below-sma': return c.period;
    case 'sma-cross-above': case 'sma-cross-below': return c.slow + 1;
    case 'rsi-above': case 'rsi-below': return c.period + 1;
    case 'breakout-high': case 'breakdown-low': return c.lookback + 1;
  }
}

/**
 * Evaluate a condition at the last bar of `history`. Callers pass only candles up to and including the
 * decision bar, so future data cannot influence a signal. Insufficient history is never a signal.
 */
export function evaluateCondition(c: Condition, history: readonly Candle[]): boolean {
  const n = history.length;
  if (n < conditionLookback(c)) return false;
  const closes = history.map((x) => x.close);
  const close = closes[n - 1];
  switch (c.kind) {
    case 'close-above-sma': return close > (sma(closes, c.period) as number);
    case 'close-below-sma': return close < (sma(closes, c.period) as number);
    case 'sma-cross-above': case 'sma-cross-below': {
      const prev = closes.slice(0, -1);
      const [fNow, sNow, fPrev, sPrev] = [sma(closes, c.fast), sma(closes, c.slow), sma(prev, c.fast), sma(prev, c.slow)] as number[];
      return c.kind === 'sma-cross-above' ? fPrev <= sPrev && fNow > sNow : fPrev >= sPrev && fNow < sNow;
    }
    case 'rsi-above': return (rsi(closes, c.period) as number) > c.level;
    case 'rsi-below': return (rsi(closes, c.period) as number) < c.level;
    case 'breakout-high': return close > Math.max(...history.slice(n - 1 - c.lookback, n - 1).map((x) => x.high));
    case 'breakdown-low': return close < Math.min(...history.slice(n - 1 - c.lookback, n - 1).map((x) => x.low));
  }
}

// ---------- engine ----------

type Position = { quantity: number; entryIndex: number; entryRaw: number; entryPrice: number; entryFee: number; stop: number | null; target: number | null };

const fee = (costs: Costs, notional: number, side: 'buy' | 'sell') => costs.perOrder + notional * (side === 'buy' ? costs.buyPct : costs.sellPct) / 100;
const buyFill = (raw: number, costs: Costs) => raw * (1 + costs.slippageBps / 10_000);
const sellFill = (raw: number, costs: Costs) => raw * (1 - costs.slippageBps / 10_000);

function maxDrawdownPct(values: number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    if (peak > 0) worst = Math.max(worst, (peak - v) / peak);
  }
  return worst * 100;
}

/** 95% Wilson score interval for a proportion, in percent. */
export function wilsonInterval(successes: number, trials: number, z = 1.959963984540054): [number, number] | null {
  if (trials === 0) return null;
  const p = successes / trials;
  const denom = 1 + z * z / trials;
  const centre = (p + z * z / (2 * trials)) / denom;
  const half = (z * Math.sqrt(p * (1 - p) / trials + z * z / (4 * trials * trials))) / denom;
  // At p = 0 or p = 1 the bound is exactly 0 or 1; set it so rounding cannot exclude the point estimate.
  return [successes === 0 ? 0 : Math.max(0, centre - half) * 100, successes === trials ? 100 : Math.min(1, centre + half) * 100];
}

/** Buy at the period's first open with all capital, sell at its last close, same costs. */
function benchmarkCurve(candles: Candle[], start: number, end: number, capital: number, costs: Costs): number[] {
  const entry = buyFill(candles[start].open, costs);
  const quantity = Math.max(0, Math.floor((capital - costs.perOrder) / (entry * (1 + costs.buyPct / 100))));
  if (quantity === 0) return candles.slice(start, end + 1).map(() => capital);
  const cash = capital - quantity * entry - fee(costs, quantity * entry, 'buy');
  return candles.slice(start, end + 1).map((c, i) => {
    if (start + i < end) return cash + quantity * c.close;
    const exit = sellFill(c.close, costs);
    return cash + quantity * exit - fee(costs, quantity * exit, 'sell');
  });
}

function simulatePeriod(candles: Candle[], start: number, end: number, config: BacktestConfig): PeriodResult {
  const { strategy, sizing, costs, initialCapital } = config;
  let cash = initialCapital;
  let position: Position | null = null;
  let pending: 'buy' | 'sell' | null = null;
  let pendingReason: ExitReason = 'rule';
  let skippedEntries = 0;
  let barsInMarket = 0;
  let tradedNotional = 0;
  const trades: Trade[] = [];
  const equity: number[] = [];

  const close = (index: number, raw: number, reason: ExitReason) => {
    const p = position!;
    const price = sellFill(raw, costs);
    const exitFee = fee(costs, p.quantity * price, 'sell');
    cash += p.quantity * price - exitFee;
    tradedNotional += p.quantity * price;
    const fees = p.entryFee + exitFee;
    const netPnl = p.quantity * (price - p.entryPrice) - fees;
    trades.push({
      entryDate: candles[p.entryIndex].date, entryRawPrice: p.entryRaw, entryPrice: p.entryPrice,
      exitDate: candles[index].date, exitRawPrice: raw, exitPrice: price, exitReason: reason,
      quantity: p.quantity, barsHeld: index - p.entryIndex + 1,
      grossPnl: p.quantity * (raw - p.entryRaw), fees,
      slippage: p.quantity * (p.entryPrice - p.entryRaw) + p.quantity * (raw - price),
      netPnl, returnPct: (netPnl / (p.quantity * p.entryPrice + p.entryFee)) * 100
    });
    position = null;
  };

  for (let t = start; t <= end; t++) {
    const bar = candles[t];
    // 1. Orders decided at the previous close execute at this open.
    if (pending === 'buy' && position === null) {
      const raw = bar.open;
      const price = buyFill(raw, costs);
      // Levels are set from the raw entry price, so a triggered level always lies inside a real bar's range.
      const stop = strategy.stopLossPct === null ? null : raw * (1 - strategy.stopLossPct / 100);
      const budget = sizing.mode === 'fraction' ? cash * sizing.fraction : cash;
      let quantity = Math.floor((budget - costs.perOrder) / (price * (1 + costs.buyPct / 100)));
      if (sizing.mode === 'risk' && stop !== null) quantity = Math.min(quantity, Math.floor((cash * sizing.riskPct / 100) / (price - stop)));
      if (quantity >= 1) {
        const entryFee = fee(costs, quantity * price, 'buy');
        cash -= quantity * price + entryFee;
        tradedNotional += quantity * price;
        position = { quantity, entryIndex: t, entryRaw: raw, entryPrice: price, entryFee, stop, target: strategy.takeProfitPct === null ? null : raw * (1 + strategy.takeProfitPct / 100) };
      } else skippedEntries++;
    } else if (pending === 'sell' && position !== null) {
      close(t, bar.open, pendingReason);
    }
    pending = null;
    // 2. Protective stop and target on this bar. On the entry bar the open is the fill, so only the range counts.
    if (position !== null) {
      const p: Position = position;
      const gapCheck = p.entryIndex !== t;
      const stopHit = p.stop !== null && bar.low <= p.stop;
      const targetHit = p.target !== null && bar.high >= p.target;
      if (gapCheck && p.stop !== null && bar.open <= p.stop) close(t, bar.open, 'stop');
      else if (gapCheck && p.target !== null && bar.open >= p.target) close(t, bar.open, 'target');
      else if (stopHit) close(t, p.stop as number, 'stop'); // worst case when both are inside one bar
      else if (targetHit) close(t, p.target as number, 'target');
    }
    // 3. Decide at this close using history up to this bar only. Nothing is decided on the period's last bar.
    if (t < end) {
      const history = candles.slice(0, t + 1);
      if (position !== null) {
        const held = t - position.entryIndex + 1;
        if (strategy.maxHoldingDays !== null && held >= strategy.maxHoldingDays) { pending = 'sell'; pendingReason = 'max-hold'; }
        else if (strategy.exit.some((c) => evaluateCondition(c, history))) { pending = 'sell'; pendingReason = 'rule'; }
      } else if (strategy.entry.every((c) => evaluateCondition(c, history))) pending = 'buy';
    }
    if (position !== null) barsInMarket++;
    equity.push(cash + (position !== null ? position.quantity * bar.close : 0));
  }
  if (position !== null) {
    close(end, candles[end].close, 'end-of-period');
    equity[equity.length - 1] = cash;
  }

  const benchmark = benchmarkCurve(candles, start, end, initialCapital, costs);
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl <= 0);
  const sum = (xs: Trade[]) => xs.reduce((a, t) => a + t.netPnl, 0);
  const avgWin = wins.length ? sum(wins) / wins.length : null;
  const avgLoss = losses.length ? sum(losses) / losses.length : null;
  const finalEquity = equity[equity.length - 1];
  const totalFees = trades.reduce((a, t) => a + t.fees, 0);
  const totalSlippage = trades.reduce((a, t) => a + t.slippage, 0);
  const averageEquity = equity.reduce((a, b) => a + b, 0) / equity.length;
  const totalReturnPct = (finalEquity / initialCapital - 1) * 100;
  const benchmarkReturnPct = (benchmark[benchmark.length - 1] / initialCapital - 1) * 100;
  return {
    trades,
    equityCurve: candles.slice(start, end + 1).map((c, i) => ({ date: c.date, equity: equity[i], benchmark: benchmark[i] })),
    metrics: {
      startDate: candles[start].date, endDate: candles[end].date, sessions: end - start + 1,
      initialEquity: initialCapital, finalEquity, totalReturnPct, maxDrawdownPct: maxDrawdownPct([initialCapital, ...equity]),
      trades: trades.length, wins: wins.length,
      winRatePct: trades.length ? (wins.length / trades.length) * 100 : null, winRate95: wilsonInterval(wins.length, trades.length),
      avgWin, avgLoss,
      payoffRatio: avgWin !== null && avgLoss !== null && avgLoss < 0 ? avgWin / -avgLoss : null,
      profitFactor: wins.length && losses.length && sum(losses) < 0 ? sum(wins) / -sum(losses) : null,
      expectancy: trades.length ? sum(trades) / trades.length : null,
      exposurePct: (barsInMarket / (end - start + 1)) * 100,
      turnover: tradedNotional / averageEquity,
      totalFees, totalSlippage, costDragPct: ((totalFees + totalSlippage) / initialCapital) * 100, skippedEntries,
      benchmarkReturnPct, benchmarkMaxDrawdownPct: maxDrawdownPct([initialCapital, ...benchmark]),
      excessReturnPct: totalReturnPct - benchmarkReturnPct,
      lowSample: trades.length < LOW_SAMPLE_TRADES
    }
  };
}

// ---------- reproducibility ----------

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
/** cyrb53: small, deterministic, browser-safe 53-bit string hash. An identifier, not a security control. */
function hash53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}
export const backtestRunId = (config: BacktestConfig, candles: Candle[]) => hash53(canonical({ engine: BACKTEST_ENGINE_VERSION, config, candles }));

// ---------- entry point ----------

function lastIndexOnOrBefore(candles: Candle[], date: string): number {
  let index = -1;
  for (let i = 0; i < candles.length && candles[i].date <= date; i++) index = i;
  return index;
}

export function runBacktest(config: BacktestConfig, candles: Candle[]): BacktestResult {
  if (candles.some((c, i) => !isValidCandle(c) || (i > 0 && c.date <= candles[i - 1].date))) {
    throw new RangeError('candles must be valid and in strictly increasing date order');
  }
  const { trainEnd, testEnd } = config.periods;
  const bounds: Record<PeriodName, [number, number]> = {
    train: [0, lastIndexOnOrBefore(candles, trainEnd)],
    test: [candles.findIndex((c) => c.date > trainEnd), lastIndexOnOrBefore(candles, testEnd)],
    outOfSample: [candles.findIndex((c) => c.date > testEnd), candles.length - 1]
  };
  for (const [name, [s, e]] of Object.entries(bounds)) {
    if (s < 0 || e < s || e - s + 1 < 2) throw new RangeError(`${name} period needs at least 2 sessions of data`);
  }
  const periods = Object.fromEntries(Object.entries(bounds).map(([name, [s, e]]) => [name, simulatePeriod(candles, s, e, config)])) as Record<PeriodName, PeriodResult>;
  const warnings: string[] = [];
  const lookback = Math.max(...[...config.strategy.entry, ...config.strategy.exit].map(conditionLookback));
  if (lookback > bounds.train[1] + 1) warnings.push(`Rules need ${lookback} sessions of history but the training period has ${bounds.train[1] + 1}; it cannot produce signals.`);
  else if (lookback > 1) warnings.push(`The first ${lookback - 1} sessions of the training period are indicator warm-up and cannot signal.`);
  for (const name of ['train', 'test', 'outOfSample'] as const) {
    const m = periods[name].metrics;
    if (m.trades === 0) warnings.push(`No trades in the ${name === 'outOfSample' ? 'out-of-sample' : name} period.`);
    else if (m.lowSample) warnings.push(`Only ${m.trades} trade${m.trades === 1 ? '' : 's'} in the ${name === 'outOfSample' ? 'out-of-sample' : name} period: too few to judge (fewer than ${LOW_SAMPLE_TRADES}).`);
  }
  if (config.strategy.exit.length === 0 && config.strategy.stopLossPct === null && config.strategy.takeProfitPct === null && config.strategy.maxHoldingDays === null) {
    warnings.push('No exit rule: positions only close at the end of each period.');
  }
  return {
    engineVersion: BACKTEST_ENGINE_VERSION, runId: backtestRunId(config, candles),
    dataFirstDate: candles[0].date, dataLastDate: candles[candles.length - 1].date, periods, warnings
  };
}
