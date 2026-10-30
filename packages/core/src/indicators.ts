/** Deterministic calculations only. AI text must never be used as a source of numerical truth. */
export function sma(values: number[], period: number): number | null {
  if (!Number.isInteger(period) || period < 1) throw new RangeError('period must be a positive integer');
  if (values.length < period) return null;
  const sample = values.slice(-period);
  if (!sample.every(Number.isFinite)) throw new RangeError('values must be finite');
  return sample.reduce((sum, value) => sum + value, 0) / period;
}

/** Wilder RSI (0-100); no movement => 50, no losses => 100. */
export function rsi(values: number[], period = 14): number | null {
  if (!Number.isInteger(period) || period < 1) throw new RangeError('period must be a positive integer');
  if (values.length <= period) return null;
  if (!values.every(Number.isFinite)) throw new RangeError('values must be finite');
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const delta = values[i] - values[i - 1];
    gains += Math.max(delta, 0);
    losses += Math.max(-delta, 0);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(delta, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-delta, 0)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export function percentChange(previous: number, current: number): number {
  if (!Number.isFinite(previous) || !Number.isFinite(current) || previous <= 0) throw new RangeError('invalid price');
  return ((current - previous) / previous) * 100;
}
