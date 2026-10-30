import test from 'node:test';
import assert from 'node:assert/strict';
import { candleGeometry, isValidCandle, latestCandles, parseCandleLimit, summarizeCandles } from '../src/chart.ts';
import type { Candle } from '../src/types.ts';

const candle = (date: string, open: number, high: number, low: number, close: number): Candle => ({ date, open, high, low, close, volume: 1000 });
const series: Candle[] = [
  candle('2026-06-01', 100, 105, 98, 104),
  candle('2026-06-02', 104, 106, 90, 92),
  candle('2026-06-03', 92, 110, 91, 92)
];

test('latestCandles keeps the most recent window in date order', () => {
  assert.deepEqual(latestCandles(series, 2).map((c) => c.date), ['2026-06-02', '2026-06-03']);
  assert.equal(latestCandles(series, 60).length, 3, 'sparse history returns what exists');
  assert.deepEqual(latestCandles([], 20), []);
  assert.throws(() => latestCandles(series, 0), RangeError);
  assert.throws(() => latestCandles(series, 1.5), RangeError);
});

test('parseCandleLimit accepts only plain integers within range', () => {
  assert.equal(parseCandleLimit(null), 90);
  assert.equal(parseCandleLimit('20'), 20);
  assert.equal(parseCandleLimit('90'), 90);
  for (const raw of ['', ' 20', '0', '-5', '91', '1.5', '20abc', '1e1', '0x10', '020', 'Infinity', '99999']) {
    assert.equal(parseCandleLimit(raw), null, `should reject ${JSON.stringify(raw)}`);
  }
  assert.equal(parseCandleLimit('30', 25), null);
});

test('isValidCandle rejects inconsistent OHLC values', () => {
  assert.ok(isValidCandle(series[0]));
  assert.equal(isValidCandle(candle('2026-06-01', 100, 99, 98, 99.5)), false, 'high below open');
  assert.equal(isValidCandle(candle('2026-06-01', 100, 105, 101, 104)), false, 'low above open');
  assert.equal(isValidCandle(candle('2026-06-01', 0, 1, 0, 1)), false, 'non-positive price');
  assert.equal(isValidCandle(candle('2026-06-01', NaN, 1, 1, 1)), false, 'non-finite price');
  assert.equal(isValidCandle(candle('June 1', 1, 1, 1, 1)), false, 'bad date');
});

test('candleGeometry scales high to the top and low to the bottom', () => {
  const shapes = candleGeometry(series, 300, 120, 10);
  assert.equal(shapes.length, 3);
  assert.equal(shapes[2].wickTop, 10, 'highest high touches top padding');
  assert.equal(shapes[1].wickBottom, 110, 'lowest low touches bottom padding');
  assert.deepEqual(shapes.map((s) => s.x), [50, 150, 250]);
  assert.deepEqual(shapes.map((s) => s.direction), ['up', 'down', 'flat']);
  assert.equal(shapes[2].bodyHeight, 1, 'flat candles stay visible');
  for (const s of shapes) {
    assert.ok(s.wickTop <= s.bodyTop && s.bodyTop + s.bodyHeight <= s.wickBottom + 1);
  }
});

test('candleGeometry handles empty, single and flat series and rejects bad input', () => {
  assert.deepEqual(candleGeometry([], 300, 120), []);
  const [single] = candleGeometry([candle('2026-06-01', 5, 5, 5, 5)], 300, 120);
  assert.ok(Number.isFinite(single.wickTop) && Number.isFinite(single.bodyTop));
  assert.equal(single.x, 150);
  assert.throws(() => candleGeometry(series, 0, 120), RangeError);
  assert.throws(() => candleGeometry(series, 300, 8, 4), RangeError);
  assert.throws(() => candleGeometry([candle('2026-06-01', 100, 90, 80, 85)], 300, 120), /2026-06-01/);
});

test('summarizeCandles describes only the selected window', () => {
  assert.equal(summarizeCandles([]), null);
  const summary = summarizeCandles(series)!;
  assert.equal(summary.sessions, 3);
  assert.equal(summary.firstDate, '2026-06-01');
  assert.equal(summary.lastDate, '2026-06-03');
  assert.equal(summary.changePct, -8);
  assert.deepEqual([summary.high, summary.highDate, summary.low, summary.lowDate], [110, '2026-06-03', 90, '2026-06-02']);
  assert.deepEqual([summary.upSessions, summary.downSessions], [1, 1]);
  assert.equal(summarizeCandles(series.slice(0, 1))!.changePct, 4);
});
