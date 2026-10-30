import type { DataProvenance, Instrument, ProviderInfo } from '../../../../packages/core/src/marketData.ts';
import type { Candle } from '../../../../packages/core/src/types.ts';

export type CandleResult = { candles: Candle[]; provenance: DataProvenance };

/** Every source of market data goes through this interface; routes never know which one is active. */
export interface MarketDataProvider {
  readonly info: ProviderInfo;
  listInstruments(): Promise<Instrument[]>;
  /** Throws ProviderError('not-found') for an unknown symbol. */
  getCandles(symbol: string): Promise<CandleResult>;
}

export type ProviderErrorCode = 'not-found' | 'auth' | 'rate-limited' | 'unavailable' | 'invalid-response' | 'config';

/** Messages are written by us and never include credentials or raw upstream bodies. */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  attempts = 1;
  constructor(code: ProviderErrorCode, message: string, options: { retryable?: boolean; retryAfterMs?: number | null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}
