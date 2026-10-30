export type Candle = { date: string; open: number; high: number; low: number; close: number; volume: number };
export type Company = { symbol: string; name: string; sector: string; description: string };
export type Trend = 'above-sma' | 'below-sma' | 'insufficient-data';
export type StockSummary = Company & {
  lastClose: number; previousClose: number; changePct: number;
  sma20: number | null; rsi14: number | null; trend: Trend;
  sparkline: number[];
};
export type PositionScenarioInput = {
  budget: number;
  entryPrice: number;
  movePct: number;
  holdingDays: number;
  borrowedAmount: number;
  annualInterestPct: number;
  estimatedFees: number;
};
export type PositionScenarioResult = {
  quantity: number; invested: number; cashRemaining: number;
  projectedExitPrice: number; grossPnl: number;
  financingCost: number; estimatedFees: number;
  netPnl: number; netReturnPct: number;
};
