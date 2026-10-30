import { createApp } from './app.ts';
import { createProviderFromEnv } from './providers/config.ts';
import { ProviderError } from './providers/types.ts';
import { researchProviderFromEnv } from './research.ts';
import { securityFromEnv } from './security.ts';

const port = Number(process.env.API_PORT ?? 4000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid API_PORT');
let provider;
try { provider = createProviderFromEnv(process.env); } catch (error) {
  console.error(error instanceof ProviderError ? error.message : 'Could not configure market data provider');
  process.exit(1);
}
const server = createApp(provider, { ...securityFromEnv(process.env), research: researchProviderFromEnv(process.env) });
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
});
server.listen(port, '127.0.0.1', () => {
  console.log(`TradeLens API (${provider.info.kind} data: ${provider.info.name}) at http://127.0.0.1:${port}/api/health`);
});
