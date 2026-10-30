import { calendarDate } from './decimal.ts';
import type { MtfInterestPolicy } from './types.ts';

/** Optional interest-only template. Caller must provide its approved effective date and rounding.
 * Observed publication date is not proof that these terms applied to earlier transactions. */
export function zerodhaMtfInterestTemplate(effectiveFrom: string, rounding: MtfInterestPolicy['rounding']): MtfInterestPolicy {
  calendarDate(effectiveFrom);
  return {
    id: `zerodha-interest-observed-2026-10-30-from-${effectiveFrom}`, startOffsetDays: 1, includeExitDay: true, rounding,
    rates: [{ id: `zerodha-daily-0004-from-${effectiveFrom}`, effectiveFrom, effectiveTo: null, dailyFraction: '0.0004',
      source: { kind: 'VERIFIED', reference: 'https://zerodha.com/charges/#mtf; observed 2026-10-30; effective date supplied by caller' } }],
  };
}
