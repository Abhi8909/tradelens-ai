import { createApp } from './app.ts';
const port = Number(process.env.API_PORT ?? 4000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid API_PORT');
createApp().listen(port, '127.0.0.1', () => {
  console.log(`TradeLens demo API at http://127.0.0.1:${port}/api/health`);
});
