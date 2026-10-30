import type { PositionScenarioInput, PositionScenarioResult } from './types.ts';

/** Hypothetical scenario only. Not a forecast, not an executable order, not tax advice. */
export function simulatePosition(input: PositionScenarioInput): PositionScenarioResult {
  const { budget, entryPrice, movePct, holdingDays, borrowedAmount, annualInterestPct, estimatedFees } = input;
  const all = Object.values(input);
  if (!all.every((value) => typeof value === 'number' && Number.isFinite(value))) throw new RangeError('all inputs must be finite numbers');
  if (budget <= 0 || entryPrice <= 0 || holdingDays < 0 || borrowedAmount < 0 || annualInterestPct < 0 || estimatedFees < 0) throw new RangeError('invalid nonnegative parameters');
  if (movePct < -100 || movePct > 1000 || annualInterestPct > 100 || holdingDays > 3650) throw new RangeError('input outside supported range');
  if (borrowedAmount > budget) throw new RangeError('borrowedAmount cannot exceed total budget');
  const quantity = Math.floor(budget / entryPrice);
  if (quantity === 0) throw new RangeError('budget must cover at least one share');
  const invested = quantity * entryPrice;
  if (borrowedAmount > invested) throw new RangeError('borrowedAmount cannot exceed invested capital');
  const projectedExitPrice = entryPrice * (1 + movePct / 100);
  const grossPnl = quantity * (projectedExitPrice - entryPrice);
  const financingCost = borrowedAmount * (annualInterestPct / 100) * (holdingDays / 365);
  const netPnl = grossPnl - financingCost - estimatedFees;
  return {
    quantity, invested, cashRemaining: budget - invested, projectedExitPrice,
    grossPnl, financingCost, estimatedFees, netPnl, netReturnPct: (netPnl / invested) * 100
  };
}
