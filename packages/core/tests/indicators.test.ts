import test from 'node:test';
import assert from 'node:assert/strict';
import { percentChange, rsi, sma } from '../src/indicators.ts';

test('SMA only considers the latest period', () => {
  assert.equal(sma([10, 20, 30, 40], 2), 35);
  assert.equal(sma([1, 2], 3), null);
  assert.throws(() => sma([1], 0), RangeError);
});
test('RSI handles insufficient data, flat prices, gains and losses', () => {
  assert.equal(rsi([1, 2, 3], 14), null);
  assert.equal(rsi(Array(16).fill(5)), 50);
  assert.equal(rsi(Array.from({ length: 16 }, (_, i) => i + 1)), 100);
  assert.equal(rsi(Array.from({ length: 16 }, (_, i) => 16 - i)), 0);
  assert.throws(() => rsi(Array(20).fill(1), 0), RangeError);
});
test('percent change uses previous value as denominator', () => {
  assert.equal(percentChange(100, 90), -10);
  assert.equal(percentChange(80, 100), 25);
  assert.throws(() => percentChange(0, 10), RangeError);
});
