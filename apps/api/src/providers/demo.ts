import { assessCandles, makeProvenance, type ProviderInfo } from '../../../../packages/core/src/marketData.ts';
import { COMPANIES, getCandles } from '../market.ts';
import { ProviderError, type MarketDataProvider } from './types.ts';

export const DEMO_PROVIDER_INFO: ProviderInfo = {
  id: 'demo', name: 'TradeLens synthetic demo', kind: 'demo', exchange: 'DEMO', currency: 'INR',
  license: 'Synthetic data generated locally from fixed seeds; not market data', timezone: 'Asia/Kolkata'
};

/** Wraps the deterministic generator in market.ts. Its calendar is generated, so freshness does not apply. */
export function createDemoProvider(now: () => Date = () => new Date()): MarketDataProvider {
  const ingestedAt = now().toISOString();
  return {
    info: DEMO_PROVIDER_INFO,
    async listInstruments() {
      return COMPANIES.map((c) => ({ ...c, exchange: DEMO_PROVIDER_INFO.exchange, currency: DEMO_PROVIDER_INFO.currency }));
    },
    async getCandles(symbol) {
      const candles = getCandles(symbol);
      if (!candles) throw new ProviderError('not-found', `Unknown symbol ${symbol}`);
      const assessed = assessCandles(candles, { now: now(), realCalendar: false });
      return { candles: assessed.candles, provenance: makeProvenance(DEMO_PROVIDER_INFO, assessed, ingestedAt) };
    }
  };
}
