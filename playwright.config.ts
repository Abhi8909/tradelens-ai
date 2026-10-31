import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  use: { baseURL: 'http://127.0.0.1:5197' },
  webServer: { command: 'npm run dev', url: 'http://127.0.0.1:5197', reuseExistingServer: false, env: { WEB_PORT: '5197', API_PORT: '4097', MTF_QUOTE_PROVIDER: 'disabled', DATABASE_URL: '', NODE_ENV: 'test', API_ACCESS_TOKEN: '', MTF_ALLOW_REGISTRATION: 'true', MTF_DB_PATH: `/tmp/tradelens-e2e-${process.pid}.sqlite`, MTF_ENCRYPTION_KEY: '1'.repeat(64), MTF_APP_ORIGIN: '' } },
});
