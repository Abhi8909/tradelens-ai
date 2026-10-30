import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzePortfolio, compareScenarios, evaluateRiskLimits, simulatePortfolioScenario,
  validatePortfolio, validateRiskLimits, validateScenario
} from '../src/portfolio.ts';
import { simulatePosition } from '../src/scenario.ts';
import type { Portfolio, PortfolioScenario, RiskLimits } from '../src/types.ts';

const close = (actual: number, expected: number, message?: string) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ''} expected ${expected}, got ${actual}`);
const position = (symbol: string, sector: string, quantity: number, entryPrice: number, extra: Partial<Portfolio['positions'][number]> = {}) =>
  ({ symbol, sector, quantity, entryPrice, stopPrice: null, borrowedAmount: 0, estimatedFees: 0, ...extra });
const portfolio: Portfolio = {
  capital: 100000,
  positions: [
    position('DEMO-ALPHA', 'Industrials', 100, 200, { stopPrice: 180, borrowedAmount: 10000, estimatedFees: 40 }), // 20,000
    position('DEMO-BETA', 'Financial Services', 50, 400, { stopPrice: 380, estimatedFees: 30 }),                  // 20,000
    position('DEMO-GAMMA', 'Technology', 40, 250, { stopPrice: 225 })                                             // 10,000
  ]
};
const scenario = (overrides: Partial<PortfolioScenario> = {}): PortfolioScenario =>
  ({ name: 'Base', marketMovePct: 0, sectorMovesPct: {}, symbolMovesPct: {}, holdingDays: 30, annualInterestPct: 12, ...overrides });
const noLimits: RiskLimits = { maxPositionPct: null, maxSectorPct: null, maxLeverage: null, maxRiskPerPositionPct: null, maxTotalRiskPct: null, maxScenarioLossPct: null, requireStops: false };

test('validatePortfolio accepts a valid synthetic portfolio and defaults a missing stop to null', () => {
  const { stopPrice: _omit, ...withoutStop } = portfolio.positions[2];
  const result = validatePortfolio({ ...portfolio, positions: [portfolio.positions[0], withoutStop] });
  assert.ok(result.ok);
  assert.equal(result.value.positions[1].stopPrice, null);
});

test('validatePortfolio rejects zero prices, bad quantities, stops above entry and duplicate symbols', () => {
  const cases: [unknown, RegExp][] = [
    [{ ...portfolio, capital: 0 }, /capital/],
    [{ ...portfolio, positions: [] }, /1-50/],
    [{ ...portfolio, positions: Array(51).fill(portfolio.positions[0]) }, /1-50/],
    [{ ...portfolio, positions: [position('DEMO-ALPHA', 'X', 10, 0)] }, /entryPrice must be greater than 0/],
    [{ ...portfolio, positions: [position('DEMO-ALPHA', 'X', 1.5, 10)] }, /quantity/],
    [{ ...portfolio, positions: [position('DEMO-ALPHA', 'X', 0, 10)] }, /quantity/],
    [{ ...portfolio, positions: [position('DEMO-ALPHA', 'X', 10, 10, { stopPrice: 10 })] }, /below entryPrice/],
    [{ ...portfolio, positions: [position('DEMO-ALPHA', 'X', 10, 10, { stopPrice: 0 })] }, /stopPrice must be greater than 0/],
    [{ ...portfolio, positions: [position('DEMO-ALPHA', 'X', 10, 10, { borrowedAmount: 101 })] }, /cannot exceed the position value/],
    [{ ...portfolio, positions: [position('DEMO-ALPHA', 'X', 10, 10, { estimatedFees: -1 })] }, /estimatedFees/],
    [{ ...portfolio, positions: [position('demo alpha', 'X', 10, 10)] }, /symbol/],
    [{ ...portfolio, positions: [position('DEMO-ALPHA', ' ', 10, 10)] }, /sector/],
    [{ ...portfolio, positions: [portfolio.positions[0], portfolio.positions[0]] }, /more than once/],
    [{ capital: 1000, positions: [position('DEMO-ALPHA', 'X', 10, 200)] }, /own funds/],
    [null, /object/]
  ];
  for (const [input, expected] of cases) {
    const result = validatePortfolio(input);
    assert.ok(!result.ok && expected.test(result.errors.join(' ')), `expected ${expected}, got ${JSON.stringify(result)}`);
  }
});

test('borrowing lets own funds stay within capital', () => {
  assert.ok(validatePortfolio({ capital: 1000, positions: [position('DEMO-ALPHA', 'X', 10, 200, { borrowedAmount: 1000 })] }).ok);
});

test('analyzePortfolio computes exposure, cash, leverage and sector weights', () => {
  const a = analyzePortfolio(portfolio);
  assert.equal(a.grossExposure, 50000);
  assert.equal(a.borrowedTotal, 10000);
  assert.equal(a.ownFundsUsed, 40000);
  assert.equal(a.cashRemaining, 60000);
  close(a.leverage, 0.5);
  assert.deepEqual(a.positions.map((p) => p.weightPct), [40, 40, 20]);
  assert.deepEqual(a.positions.map((p) => p.capitalPct), [20, 20, 10]);
  assert.deepEqual(a.sectors.map((s) => s.sector), ['Financial Services', 'Industrials', 'Technology'], 'ties sorted by name');
  assert.deepEqual(a.largestPosition, { symbol: 'DEMO-ALPHA', capitalPct: 20, weightPct: 40 });
  close(a.herfindahl, 0.4 ** 2 + 0.4 ** 2 + 0.2 ** 2);
  close(a.effectivePositions, 1 / 0.36);
});

test('risk to stop includes fees and becomes unknown when any stop is missing', () => {
  const a = analyzePortfolio(portfolio);
  assert.deepEqual(a.positions.map((p) => p.riskToStop), [2040, 1030, 1000]);
  assert.equal(a.totalRiskToStop, 4070);
  close(a.totalRiskToStopPct!, 4.07);
  const partial = analyzePortfolio({ ...portfolio, positions: [portfolio.positions[0], { ...portfolio.positions[1], stopPrice: null }] });
  assert.equal(partial.totalRiskToStop, null);
  assert.deepEqual(partial.positionsWithoutStop, ['DEMO-BETA']);
});

test('a single-position portfolio is maximally concentrated', () => {
  const a = analyzePortfolio({ capital: 50000, positions: [position('DEMO-ZETA', 'Healthcare', 100, 300)] });
  assert.equal(a.herfindahl, 1);
  assert.equal(a.effectivePositions, 1);
  assert.equal(a.sectors[0].weightPct, 100);
  assert.equal(a.largestPosition.capitalPct, 60);
});

test('equal weights give an effective position count equal to the number of positions', () => {
  const symbols = ['DEMO-A', 'DEMO-B', 'DEMO-C', 'DEMO-D', 'DEMO-E'];
  const a = analyzePortfolio({ capital: 100000, positions: symbols.map((s) => position(s, 'Same', 10, 100)) });
  close(a.effectivePositions, 5);
  assert.equal(a.sectors.length, 1);
});

test('portfolio financing matches the single-trade simple-interest convention', () => {
  const single: Portfolio = { capital: 10000, positions: [position('DEMO-ALPHA', 'X', 100, 100, { borrowedAmount: 4000, estimatedFees: 30 })] };
  const result = simulatePortfolioScenario(single, scenario({ marketMovePct: -10, holdingDays: 60, annualInterestPct: 14 }));
  const reference = simulatePosition({ budget: 10000, entryPrice: 100, movePct: -10, holdingDays: 60, borrowedAmount: 4000, annualInterestPct: 14, estimatedFees: 30 });
  close(result.financingCost, reference.financingCost, 'financing');
  close(result.netPnl, reference.netPnl, 'net P&L');
  close(result.financingCost, 4000 * 0.14 * 60 / 365);
  assert.equal(simulatePortfolioScenario(single, scenario({ holdingDays: 0 })).financingCost, 0);
  assert.equal(simulatePortfolioScenario({ ...single, positions: [{ ...single.positions[0], borrowedAmount: 0 }] }, scenario({ holdingDays: 365 })).financingCost, 0);
});

test('ending cash equals capital plus net P&L across scenarios', () => {
  for (const s of [scenario(), scenario({ marketMovePct: -25 }), scenario({ marketMovePct: 40, holdingDays: 200 }), scenario({ marketMovePct: -100 })]) {
    const r = simulatePortfolioScenario(portfolio, s);
    close(r.endingCash, portfolio.capital + r.netPnl, s.name);
    close(r.netPnl, r.grossPnl - r.financingCost - r.estimatedFees);
  }
  const flat = simulatePortfolioScenario(portfolio, scenario({ holdingDays: 0 }));
  assert.equal(flat.netPnl, -70, 'only fees when price and time are unchanged');
});

test('a move to zero price loses the whole position and records a loan shortfall', () => {
  const r = simulatePortfolioScenario(portfolio, scenario({ symbolMovesPct: { 'DEMO-ALPHA': -100 } }));
  const alpha = r.positions[0];
  assert.equal(alpha.exitPrice, 0);
  assert.equal(alpha.grossPnl, -20000);
  close(alpha.loanShortfall, 10000 + alpha.financingCost);
  assert.equal(r.positions[1].loanShortfall, 0);
  assert.equal(r.worstPosition, 'DEMO-ALPHA');
});

test('highly leveraged losses beyond capital are flagged', () => {
  const leveraged: Portfolio = { capital: 10000, positions: [position('DEMO-DELTA', 'Energy', 500, 100, { borrowedAmount: 40000 })] };
  assert.ok(validatePortfolio(leveraged).ok);
  close(analyzePortfolio(leveraged).leverage, 5);
  const crash = simulatePortfolioScenario(leveraged, scenario({ marketMovePct: -30 }));
  assert.ok(crash.lossExceedsCapital);
  assert.ok(crash.endingCash < 0);
  assert.ok(crash.returnOnCapitalPct < -100);
  assert.equal(simulatePortfolioScenario(leveraged, scenario({ marketMovePct: -10, holdingDays: 0 })).lossExceedsCapital, false);
});

test('price moves resolve symbol before sector before market', () => {
  const r = simulatePortfolioScenario(portfolio, scenario({ marketMovePct: -5, sectorMovesPct: { Industrials: -20, Technology: 10 }, symbolMovesPct: { 'DEMO-GAMMA': 3 } }));
  assert.deepEqual(r.positions.map((p) => [p.symbol, p.movePct, p.moveSource]), [
    ['DEMO-ALPHA', -20, 'sector'], ['DEMO-BETA', -5, 'market'], ['DEMO-GAMMA', 3, 'symbol']
  ]);
});

test('validateScenario rejects out-of-range values and names not in the portfolio', () => {
  assert.ok(validateScenario(scenario(), portfolio).ok);
  const cases: [unknown, RegExp][] = [
    [{ ...scenario(), marketMovePct: -101 }, /marketMovePct/],
    [{ ...scenario(), holdingDays: 1.5 }, /holdingDays/],
    [{ ...scenario(), annualInterestPct: 101 }, /annualInterestPct/],
    [{ ...scenario(), name: '' }, /name/],
    [{ ...scenario(), sectorMovesPct: { Utilities: -5 } }, /Utilities is not in the portfolio/],
    [{ ...scenario(), symbolMovesPct: { 'DEMO-ALPHA': 'x' } }, /move must be/],
    [{ ...scenario(), symbolMovesPct: [] }, /must be an object/]
  ];
  for (const [input, expected] of cases) {
    const result = validateScenario(input, portfolio);
    assert.ok(!result.ok && expected.test(result.errors.join(' ')), String(expected));
  }
});

test('compareScenarios identifies the worst scenario', () => {
  const { results, worst } = compareScenarios(portfolio, [scenario({ name: 'Flat' }), scenario({ name: 'Crash', marketMovePct: -20 }), scenario({ name: 'Rally', marketMovePct: 15 })]);
  assert.deepEqual(results.map((r) => r.name), ['Flat', 'Crash', 'Rally']);
  assert.equal(worst, 'Crash');
  assert.deepEqual(compareScenarios(portfolio, []), { results: [], worst: null });
});

test('validateRiskLimits accepts nulls and rejects out-of-range limits', () => {
  assert.deepEqual(validateRiskLimits({}), { ok: true, value: noLimits });
  for (const bad of [{ maxPositionPct: 0 }, { maxLeverage: 21 }, { maxTotalRiskPct: '5' }, { requireStops: 'yes' }]) {
    assert.equal(validateRiskLimits(bad).ok, false, JSON.stringify(bad));
  }
});

test('evaluateRiskLimits explains passes and breaches with the positions involved', () => {
  const analysis = analyzePortfolio(portfolio);
  const crash = simulatePortfolioScenario(portfolio, scenario({ name: 'Crash', marketMovePct: -20 }));
  const checks = evaluateRiskLimits(analysis, {
    maxPositionPct: 15, maxSectorPct: 25, maxLeverage: 0.4, maxRiskPerPositionPct: 2, maxTotalRiskPct: 5, maxScenarioLossPct: 5, requireStops: true
  }, [crash]);
  const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
  assert.equal(checks.length, 7);
  assert.equal(byId.maxPositionPct.status, 'breach');
  assert.deepEqual(byId.maxPositionPct.subjects, ['DEMO-ALPHA', 'DEMO-BETA']);
  assert.match(byId.maxPositionPct.message, /DEMO-ALPHA is 20\.00%.*15\.00%/);
  assert.equal(byId.maxSectorPct.status, 'pass');
  assert.equal(byId.maxLeverage.status, 'breach');
  assert.deepEqual(byId.maxLeverage.subjects, ['DEMO-ALPHA'], 'borrowing positions named');
  assert.equal(byId.maxRiskPerPositionPct.status, 'breach');
  assert.deepEqual(byId.maxRiskPerPositionPct.subjects, ['DEMO-ALPHA']);
  assert.equal(byId.maxTotalRiskPct.status, 'pass');
  assert.match(byId.maxTotalRiskPct.message, /Gaps through a stop can lose more/);
  assert.equal(byId.maxScenarioLossPct.status, 'breach');
  close(byId.maxScenarioLossPct.actual as number, -crash.returnOnCapitalPct);
  assert.equal(byId.requireStops.status, 'pass');
});

test('evaluateRiskLimits reports limits it cannot check instead of passing them', () => {
  const noStops = analyzePortfolio({ ...portfolio, positions: portfolio.positions.map((p, i) => i === 0 ? p : { ...p, stopPrice: null }) });
  const checks = evaluateRiskLimits(noStops, { ...noLimits, maxRiskPerPositionPct: 5, maxTotalRiskPct: 5, maxScenarioLossPct: 10, requireStops: true });
  const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
  assert.equal(byId.maxRiskPerPositionPct.status, 'not-evaluable');
  assert.match(byId.maxRiskPerPositionPct.message, /No stop set for DEMO-BETA, DEMO-GAMMA/);
  assert.equal(byId.maxTotalRiskPct.status, 'not-evaluable');
  assert.equal(byId.maxTotalRiskPct.actual, null);
  assert.equal(byId.maxScenarioLossPct.status, 'not-evaluable');
  assert.equal(byId.requireStops.status, 'breach');
  assert.deepEqual(evaluateRiskLimits(noStops, noLimits), [], 'unset limits are skipped');
});
