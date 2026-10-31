import { storeFromEnv } from './mtf/store.ts';
import { MtfService } from './mtf/service.ts';
import { kiteFromEnv } from './mtf/kite.ts';
import { createApp } from './app.ts';
import { createProviderFromEnv } from './providers/config.ts';
import { ProviderError } from './providers/types.ts';
import { researchProviderFromEnv } from './research.ts';
import { mtfQuoteFeedFromEnv } from './mtfQuotes.ts';
import { securityFromEnv } from './security.ts';

const port = Number(process.env.API_PORT ?? 4000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid API_PORT');
let provider;
try { provider = createProviderFromEnv(process.env); } catch (error) {
  console.error(error instanceof ProviderError ? error.message : 'Could not configure market data provider');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production' && !process.env.MTF_APP_ORIGIN?.startsWith('https://')) throw new Error('Production requires HTTPS MTF_APP_ORIGIN');
const store = await storeFromEnv(process.env);
const quotes = mtfQuoteFeedFromEnv(process.env);
const mtf = new MtfService({ store, origin: process.env.MTF_APP_ORIGIN, production: process.env.NODE_ENV === 'production', allowRegistration: process.env.MTF_ALLOW_REGISTRATION === 'true' || process.env.NODE_ENV !== 'production', kite: kiteFromEnv(process.env), quotes });
const stopSnapshots = mtf.startSnapshots();
const server = createApp(provider, { ...securityFromEnv(process.env), research: researchProviderFromEnv(process.env), mtfQuoteFeed: quotes, mtf });
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
  stopSnapshots(); server.close(() => { void mtf.calculations.close().then(() => store.close()).finally(() => process.exit(0)); });
  setTimeout(() => process.exit(1), 10_000).unref();
});
server.listen(port, process.env.API_HOST ?? '127.0.0.1', () => {
  console.log(`TradeLens API (${provider.info.kind} data: ${provider.info.name}) at http://127.0.0.1:${port}/api/health`);
});
