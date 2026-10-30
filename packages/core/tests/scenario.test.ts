import test from 'node:test';
import assert from 'node:assert/strict';
import { simulatePosition } from '../src/scenario.ts';

const base = { budget: 10000, entryPrice: 120, movePct: 10, holdingDays: 30, borrowedAmount: 0, annualInterestPct: 0, estimatedFees: 0 };

test('scenario buys whole shares and computes hypothetical profit', () => {
  const result = simulatePosition(base);
  assert.equal(result.quantity, 83);
  assert.equal(result.invested, 9960);
  assert.equal(result.cashRemaining, 40);
  assert.ok(Math.abs(result.grossPnl - 996) < 1e-8);
});
test('MTF financing and fees reduce net return', () => {
  const result = simulatePosition({ ...base, borrowedAmount: 5000, annualInterestPct: 12, estimatedFees: 45 });
  assert.ok(Math.abs(result.financingCost - (5000 * 0.12 * 30 / 365)) < 1e-8);
  assert.ok(result.netPnl < result.grossPnl);
});
test('validates nonsensical inputs', () => {
  assert.throws(() => simulatePosition({ ...base, entryPrice: -1 }), RangeError);
  assert.throws(() => simulatePosition({ ...base, movePct: -101 }), RangeError);
  assert.throws(() => simulatePosition({ ...base, borrowedAmount: 11000 }), RangeError);
  assert.throws(() => simulatePosition({ ...base, budget: 10 }), RangeError);
  assert.throws(() => simulatePosition({ ...base, borrowedAmount: 9999 }), RangeError);
});
