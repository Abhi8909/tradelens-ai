import { Decimal } from 'decimal.js';
import type { MtfIssueCode, MtfRounding } from './types.ts';

// Isolated context: unrelated callers cannot change ledger precision or rounding.
export const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_UP });
export class MtfDomainError extends Error {
  readonly code: MtfIssueCode;
  constructor(code: MtfIssueCode) { super(code); this.code = code; }
}
export function requireMtf(condition: unknown, code: MtfIssueCode = 'INVALID_INPUT'): asserts condition {
  if (!condition) throw new MtfDomainError(code);
}
export function amount(value: string, signed = false): Decimal {
  requireMtf(typeof value === 'string' && (signed ? /^-?(0|[1-9]\d{0,14})(\.\d{1,8})?$/ : /^(0|[1-9]\d{0,14})(\.\d{1,8})?$/).test(value));
  return new D(value);
}
export function quantity(value: number) {
  requireMtf(Number.isSafeInteger(value) && value > 0 && value <= 1_000_000_000, 'INVALID_QUANTITY');
  return value;
}
export function rounding(mode: MtfRounding['mode']) {
  requireMtf(['HALF_UP', 'HALF_EVEN', 'DOWN'].includes(mode));
  return { HALF_UP: D.ROUND_HALF_UP, HALF_EVEN: D.ROUND_HALF_EVEN, DOWN: D.ROUND_DOWN }[mode];
}
export const money = (value: Decimal): string => value.toFixed(2, D.ROUND_HALF_UP);
export function calendarDate(value: string): string {
  requireMtf(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value));
  const time = Date.parse(`${value}T00:00:00Z`);
  requireMtf(Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value);
  return value;
}
export function instant(value: string): number {
  requireMtf(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2})$/.test(value));
  calendarDate(value.slice(0, 10));
  requireMtf(Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60 && Number(value.slice(17, 19)) < 60);
  const time = Date.parse(value); requireMtf(Number.isFinite(time)); return time;
}
export const istDay = (value: string): string => new Date(instant(value) + 19_800_000).toISOString().slice(0, 10);
export const dayNumber = (day: string): number => Date.parse(`${calendarDate(day)}T00:00:00Z`) / 86_400_000;
export const addDays = (day: string, count: number): string => new Date((dayNumber(day) + count) * 86_400_000).toISOString().slice(0, 10);
