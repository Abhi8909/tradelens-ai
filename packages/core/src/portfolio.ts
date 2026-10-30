import type {
  Portfolio, PortfolioAnalysis, PortfolioPosition, PortfolioScenario, PortfolioScenarioResult,
  PositionExposure, PositionScenarioOutcome, Result, RiskCheck, RiskLimits, SectorExposure
} from './types.ts';

/** Hypothetical planning maths only. Not a forecast, margin requirement, order or recommendation. */
export const PORTFOLIO_LIMITS = { maxPositions: 50, maxScenarios: 6, maxNameLength: 40 } as const;
const SYMBOL = /^[A-Z0-9][A-Z0-9-]{0,19}$/;

const fail = <T>(errors: string[]): Result<T> => ({ ok: false, errors });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const pct = (n: number) => `${n.toFixed(2)}%`;

function shortText(value: unknown, field: string, errors: string[]): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > PORTFOLIO_LIMITS.maxNameLength) errors.push(`${field} must be 1-${PORTFOLIO_LIMITS.maxNameLength} characters`);
  return text;
}

function validatePosition(raw: unknown, label: string, errors: string[]): PortfolioPosition | null {
  if (!isRecord(raw)) { errors.push(`${label} must be an object`); return null; }
  const before = errors.length;
  const symbol = typeof raw.symbol === 'string' ? raw.symbol.trim() : '';
  if (!SYMBOL.test(symbol)) errors.push(`${label}: symbol must look like DEMO-ALPHA`);
  const sector = shortText(raw.sector, `${label}: sector`, errors);
  const { quantity, entryPrice, borrowedAmount, estimatedFees } = raw;
  const stopPrice = raw.stopPrice ?? null;
  if (!isNumber(quantity) || !Number.isInteger(quantity) || quantity < 1) errors.push(`${label}: quantity must be a whole number of at least 1`);
  if (!isNumber(entryPrice) || entryPrice <= 0) errors.push(`${label}: entryPrice must be greater than 0`);
  if (!isNumber(borrowedAmount) || borrowedAmount < 0) errors.push(`${label}: borrowedAmount must be 0 or more`);
  if (!isNumber(estimatedFees) || estimatedFees < 0) errors.push(`${label}: estimatedFees must be 0 or more`);
  if (stopPrice !== null && (!isNumber(stopPrice) || stopPrice <= 0)) errors.push(`${label}: stopPrice must be greater than 0 or null`);
  if (errors.length > before) return null;
  const position = { symbol, sector, quantity, entryPrice, stopPrice, borrowedAmount, estimatedFees } as PortfolioPosition;
  if (position.stopPrice !== null && position.stopPrice >= position.entryPrice) errors.push(`${label}: stopPrice must be below entryPrice for a long position`);
  if (position.borrowedAmount > position.quantity * position.entryPrice) errors.push(`${label}: borrowedAmount cannot exceed the position value`);
  return errors.length > before ? null : position;
}

export function validatePortfolio(input: unknown): Result<Portfolio> {
  if (!isRecord(input)) return fail(['portfolio must be an object']);
  const errors: string[] = [];
  const { capital, positions } = input;
  if (!isNumber(capital) || capital <= 0) errors.push('capital must be greater than 0');
  if (!Array.isArray(positions) || positions.length === 0 || positions.length > PORTFOLIO_LIMITS.maxPositions) {
    errors.push(`positions must be a list of 1-${PORTFOLIO_LIMITS.maxPositions} holdings`);
    return fail(errors);
  }
  const valid = positions.map((p, i) => validatePosition(p, `position ${i + 1}`, errors));
  const symbols = valid.flatMap((p) => p ? [p.symbol] : []);
  const duplicate = symbols.find((s, i) => symbols.indexOf(s) !== i);
  if (duplicate) errors.push(`${duplicate} appears more than once; combine it into one position`);
  if (errors.length) return fail(errors);
  const portfolio = { capital: capital as number, positions: valid as PortfolioPosition[] };
  const ownFunds = portfolio.positions.reduce((sum, p) => sum + p.quantity * p.entryPrice - p.borrowedAmount, 0);
  if (ownFunds > portfolio.capital) return fail([`positions need ₹${ownFunds.toFixed(2)} of own funds but capital is ₹${portfolio.capital.toFixed(2)}`]);
  return { ok: true, value: portfolio };
}

function moveMap(raw: unknown, field: string, allowed: Set<string>, errors: string[]): Record<string, number> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) { errors.push(`${field} must be an object of name → move %`); return {}; }
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.has(key)) errors.push(`${field}: ${key} is not in the portfolio`);
    else if (!isNumber(value) || value < -100 || value > 1000) errors.push(`${field}: ${key} move must be from -100 to 1000`);
    else out[key] = value;
  }
  return out;
}

export function validateScenario(input: unknown, portfolio: Portfolio, label = 'scenario'): Result<PortfolioScenario> {
  if (!isRecord(input)) return fail([`${label} must be an object`]);
  const errors: string[] = [];
  const name = shortText(input.name, `${label}: name`, errors);
  const { marketMovePct, holdingDays, annualInterestPct } = input;
  if (!isNumber(marketMovePct) || marketMovePct < -100 || marketMovePct > 1000) errors.push(`${label}: marketMovePct must be from -100 to 1000`);
  if (!isNumber(holdingDays) || !Number.isInteger(holdingDays) || holdingDays < 0 || holdingDays > 3650) errors.push(`${label}: holdingDays must be a whole number from 0 to 3650`);
  if (!isNumber(annualInterestPct) || annualInterestPct < 0 || annualInterestPct > 100) errors.push(`${label}: annualInterestPct must be from 0 to 100`);
  const sectorMovesPct = moveMap(input.sectorMovesPct, `${label}: sectorMovesPct`, new Set(portfolio.positions.map((p) => p.sector)), errors);
  const symbolMovesPct = moveMap(input.symbolMovesPct, `${label}: symbolMovesPct`, new Set(portfolio.positions.map((p) => p.symbol)), errors);
  if (errors.length) return fail(errors);
  return { ok: true, value: { name, marketMovePct: marketMovePct as number, sectorMovesPct, symbolMovesPct, holdingDays: holdingDays as number, annualInterestPct: annualInterestPct as number } };
}

export function validateRiskLimits(input: unknown): Result<RiskLimits> {
  if (!isRecord(input)) return fail(['limits must be an object']);
  const errors: string[] = [];
  const bounded = (key: keyof RiskLimits, max: number) => {
    const value = input[key] ?? null;
    if (value === null) return null;
    if (!isNumber(value) || value <= 0 || value > max) { errors.push(`${key} must be greater than 0 and at most ${max}, or null`); return null; }
    return value;
  };
  const limits: RiskLimits = {
    maxPositionPct: bounded('maxPositionPct', 1000), maxSectorPct: bounded('maxSectorPct', 1000), maxLeverage: bounded('maxLeverage', 20),
    maxRiskPerPositionPct: bounded('maxRiskPerPositionPct', 100), maxTotalRiskPct: bounded('maxTotalRiskPct', 100),
    maxScenarioLossPct: bounded('maxScenarioLossPct', 1000), requireStops: input.requireStops ?? false
  } as RiskLimits;
  if (typeof limits.requireStops !== 'boolean') errors.push('requireStops must be true or false');
  return errors.length ? fail(errors) : { ok: true, value: limits };
}

export function analyzePortfolio(portfolio: Portfolio): PortfolioAnalysis {
  const { capital } = portfolio;
  const values = portfolio.positions.map((p) => p.quantity * p.entryPrice);
  const grossExposure = values.reduce((a, b) => a + b, 0);
  const borrowedTotal = portfolio.positions.reduce((sum, p) => sum + p.borrowedAmount, 0);
  const positions: PositionExposure[] = portfolio.positions.map((p, i) => {
    const riskToStop = p.stopPrice === null ? null : p.quantity * (p.entryPrice - p.stopPrice) + p.estimatedFees;
    return {
      symbol: p.symbol, sector: p.sector, marketValue: values[i],
      weightPct: (values[i] / grossExposure) * 100, capitalPct: (values[i] / capital) * 100,
      ownFunds: values[i] - p.borrowedAmount, borrowedAmount: p.borrowedAmount,
      riskToStop, riskToStopPct: riskToStop === null ? null : (riskToStop / capital) * 100
    };
  });
  const bySector = new Map<string, SectorExposure>();
  for (const p of positions) {
    const s = bySector.get(p.sector) ?? { sector: p.sector, marketValue: 0, weightPct: 0, capitalPct: 0, symbols: [] };
    s.marketValue += p.marketValue; s.symbols.push(p.symbol);
    bySector.set(p.sector, s);
  }
  const sectors = [...bySector.values()]
    .map((s) => ({ ...s, weightPct: (s.marketValue / grossExposure) * 100, capitalPct: (s.marketValue / capital) * 100 }))
    .sort((a, b) => b.marketValue - a.marketValue || a.sector.localeCompare(b.sector));
  const largest = positions.reduce((best, p) => p.marketValue > best.marketValue ? p : best);
  const herfindahl = positions.reduce((sum, p) => sum + (p.weightPct / 100) ** 2, 0);
  const withoutStop = positions.filter((p) => p.riskToStop === null).map((p) => p.symbol);
  const totalRiskToStop = withoutStop.length ? null : positions.reduce((sum, p) => sum + (p.riskToStop as number), 0);
  return {
    capital, grossExposure, borrowedTotal, ownFundsUsed: grossExposure - borrowedTotal,
    cashRemaining: capital - (grossExposure - borrowedTotal), leverage: grossExposure / capital,
    positions, sectors,
    largestPosition: { symbol: largest.symbol, capitalPct: largest.capitalPct, weightPct: largest.weightPct },
    herfindahl, effectivePositions: 1 / herfindahl,
    totalRiskToStop, totalRiskToStopPct: totalRiskToStop === null ? null : (totalRiskToStop / capital) * 100,
    positionsWithoutStop: withoutStop
  };
}

/** Close every position at the scenario price; borrowed amounts plus simple interest are repaid from proceeds. */
export function simulatePortfolioScenario(portfolio: Portfolio, scenario: PortfolioScenario): PortfolioScenarioResult {
  const positions: PositionScenarioOutcome[] = portfolio.positions.map((p) => {
    const [movePct, moveSource]: [number, PositionScenarioOutcome['moveSource']] =
      p.symbol in scenario.symbolMovesPct ? [scenario.symbolMovesPct[p.symbol], 'symbol']
      : p.sector in scenario.sectorMovesPct ? [scenario.sectorMovesPct[p.sector], 'sector']
      : [scenario.marketMovePct, 'market'];
    const exitPrice = p.entryPrice * (1 + movePct / 100);
    const grossPnl = p.quantity * (exitPrice - p.entryPrice);
    const financingCost = p.borrowedAmount * (scenario.annualInterestPct / 100) * (scenario.holdingDays / 365);
    return {
      symbol: p.symbol, movePct, moveSource, exitPrice, grossPnl, financingCost, estimatedFees: p.estimatedFees,
      netPnl: grossPnl - financingCost - p.estimatedFees,
      loanShortfall: Math.max(0, p.borrowedAmount + financingCost - p.quantity * exitPrice)
    };
  });
  const sum = (key: 'grossPnl' | 'financingCost' | 'estimatedFees' | 'netPnl') => positions.reduce((total, p) => total + p[key], 0);
  const netPnl = sum('netPnl');
  const ownFunds = portfolio.positions.reduce((total, p) => total + p.quantity * p.entryPrice - p.borrowedAmount, 0);
  const endingCash = portfolio.capital - ownFunds + positions.reduce((total, o, i) =>
    total + portfolio.positions[i].quantity * o.exitPrice - portfolio.positions[i].borrowedAmount - o.financingCost - o.estimatedFees, 0);
  return {
    name: scenario.name, positions,
    grossPnl: sum('grossPnl'), financingCost: sum('financingCost'), estimatedFees: sum('estimatedFees'), netPnl,
    returnOnCapitalPct: (netPnl / portfolio.capital) * 100, endingCash,
    lossExceedsCapital: endingCash < 0,
    worstPosition: positions.reduce((worst, p) => p.netPnl < worst.netPnl ? p : worst).symbol
  };
}

export function compareScenarios(portfolio: Portfolio, scenarios: PortfolioScenario[]): { results: PortfolioScenarioResult[]; worst: string | null } {
  const results = scenarios.map((s) => simulatePortfolioScenario(portfolio, s));
  const worst = results.length ? results.reduce((w, r) => r.netPnl < w.netPnl ? r : w).name : null;
  return { results, worst };
}

/** Explain each user-defined limit in plain language. Unset limits are skipped. */
export function evaluateRiskLimits(analysis: PortfolioAnalysis, limits: RiskLimits, scenarios: PortfolioScenarioResult[] = []): RiskCheck[] {
  const checks: RiskCheck[] = [];
  const over = <T>(items: T[], value: (t: T) => number, limit: number) => items.filter((t) => value(t) > limit);

  if (limits.maxPositionPct !== null) {
    const breached = over(analysis.positions, (p) => p.capitalPct, limits.maxPositionPct);
    checks.push({
      id: 'maxPositionPct', limit: limits.maxPositionPct, actual: analysis.largestPosition.capitalPct, subjects: breached.map((p) => p.symbol),
      status: breached.length ? 'breach' : 'pass',
      message: breached.length
        ? `${breached.map((p) => `${p.symbol} is ${pct(p.capitalPct)}`).join(', ')} of capital; your limit is ${pct(limits.maxPositionPct)} per position.`
        : `Largest position ${analysis.largestPosition.symbol} is ${pct(analysis.largestPosition.capitalPct)} of capital, within your ${pct(limits.maxPositionPct)} limit.`
    });
  }
  if (limits.maxSectorPct !== null) {
    const breached = over(analysis.sectors, (s) => s.capitalPct, limits.maxSectorPct);
    checks.push({
      id: 'maxSectorPct', limit: limits.maxSectorPct, actual: analysis.sectors[0].capitalPct, subjects: breached.map((s) => s.sector),
      status: breached.length ? 'breach' : 'pass',
      message: breached.length
        ? `${breached.map((s) => `${s.sector} is ${pct(s.capitalPct)} (${s.symbols.join(', ')})`).join('; ')} of capital; your sector limit is ${pct(limits.maxSectorPct)}.`
        : `Largest sector ${analysis.sectors[0].sector} is ${pct(analysis.sectors[0].capitalPct)} of capital, within your ${pct(limits.maxSectorPct)} limit.`
    });
  }
  if (limits.maxLeverage !== null) {
    const breach = analysis.leverage > limits.maxLeverage;
    checks.push({
      id: 'maxLeverage', limit: limits.maxLeverage, actual: analysis.leverage, subjects: breach ? analysis.positions.filter((p) => p.borrowedAmount > 0).map((p) => p.symbol) : [],
      status: breach ? 'breach' : 'pass',
      message: `Gross exposure is ${analysis.leverage.toFixed(2)}× capital; your limit is ${limits.maxLeverage.toFixed(2)}×.`
    });
  }
  if (limits.maxRiskPerPositionPct !== null) {
    const limit = limits.maxRiskPerPositionPct;
    const breached = analysis.positions.filter((p) => p.riskToStopPct !== null && p.riskToStopPct > limit);
    const known = analysis.positions.filter((p) => p.riskToStopPct !== null).map((p) => p.riskToStopPct as number);
    const missing = analysis.positionsWithoutStop;
    checks.push({
      id: 'maxRiskPerPositionPct', limit, actual: known.length ? Math.max(...known) : null,
      subjects: breached.length ? breached.map((p) => p.symbol) : missing,
      status: breached.length ? 'breach' : missing.length ? 'not-evaluable' : 'pass',
      message: [
        breached.length ? `Risk to stop (incl. fees) is ${breached.map((p) => `${p.symbol} ${pct(p.riskToStopPct as number)}`).join(', ')} of capital; your limit is ${pct(limit)}.` : '',
        missing.length ? `No stop set for ${missing.join(', ')}, so risk there is unknown.` : '',
        !breached.length && !missing.length ? `Every position risks at most ${pct(Math.max(...known))} of capital to its stop, within ${pct(limit)}.` : ''
      ].filter(Boolean).join(' ')
    });
  }
  if (limits.maxTotalRiskPct !== null) {
    const actual = analysis.totalRiskToStopPct;
    checks.push({
      id: 'maxTotalRiskPct', limit: limits.maxTotalRiskPct, actual, subjects: actual === null ? analysis.positionsWithoutStop : [],
      status: actual === null ? 'not-evaluable' : actual > limits.maxTotalRiskPct ? 'breach' : 'pass',
      message: actual === null
        ? `Total risk can't be measured: no stop for ${analysis.positionsWithoutStop.join(', ')}.`
        : `If every stop is hit at its price, the loss is ${pct(actual)} of capital (incl. fees); your limit is ${pct(limits.maxTotalRiskPct)}. Gaps through a stop can lose more.`
    });
  }
  if (limits.maxScenarioLossPct !== null) {
    const worst = scenarios.length ? scenarios.reduce((w, r) => r.netPnl < w.netPnl ? r : w) : null;
    const lossPct = worst ? Math.max(0, -worst.returnOnCapitalPct) : null;
    checks.push({
      id: 'maxScenarioLossPct', limit: limits.maxScenarioLossPct, actual: lossPct, subjects: worst && lossPct! > limits.maxScenarioLossPct ? [worst.name] : [],
      status: lossPct === null ? 'not-evaluable' : lossPct > limits.maxScenarioLossPct ? 'breach' : 'pass',
      message: worst === null ? 'Add at least one scenario to check this limit.'
        : `Worst scenario "${worst.name}" loses ${pct(lossPct as number)} of capital; your limit is ${pct(limits.maxScenarioLossPct)}.`
    });
  }
  if (limits.requireStops) {
    const missing = analysis.positionsWithoutStop;
    checks.push({
      id: 'requireStops', limit: true, actual: null, subjects: missing, status: missing.length ? 'breach' : 'pass',
      message: missing.length ? `No stop price set for ${missing.join(', ')}.` : 'Every position has a stop price.'
    });
  }
  return checks;
}
