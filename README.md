# TradeLens AI

A stock research workspace built with React, Vite, Node.js and TypeScript. Includes a stock screener, technical charts, scenario and portfolio risk calculators, backtesting, a thesis journal, a research assistant and an MTF portfolio tracker.

## Run locally

Requires **Node.js 22.16+** and **npm 10+**.

```bash
npm ci
npm run dev
```

- Web: http://localhost:5173
- API health: http://localhost:4000/api/health

Vite proxies `/api` to the local backend. To run services separately, use `npm run dev:api` and `npm run dev:web` in separate terminals.

## Configuration

See [.env.example](.env.example) for available settings. `npm run dev` does **not** automatically load a root `.env`; export variables in your shell, or start the API explicitly:

```bash
cp .env.example .env
# Edit .env with your private settings, then run:
node --env-file=.env --experimental-strip-types apps/api/src/server.ts
```

Run `npm run dev:web` separately when starting the API this way. Keep credentials and financial data out of Git.

| Setting | Purpose |
| --- | --- |
| `MARKET_DATA_PROVIDER` | `demo` (default), `fixture`, or `http` for a licensed market-data adapter |
| `MTF_QUOTE_PROVIDER` | `nse` (default), `disabled`, or `http` for a licensed quote adapter |
| `DATABASE_URL` | PostgreSQL connection for hosted MTF storage; development defaults to SQLite |
| `MTF_ENCRYPTION_KEY` | Persistent 64-character hex encryption key; required in production |
| `MTF_APP_ORIGIN` | Exact public HTTPS origin; required in production |
| `API_ACCESS_TOKEN` | Private API gateway token; required in production |
| `MTF_ALLOW_REGISTRATION` | Set to `true` to enable hosted self-registration |
| `KITE_API_KEY`, `KITE_API_SECRET`, `KITE_REDIRECT_URL` | Optional server-side Zerodha Kite connection |

## MTF tracking

Open **MTF Tracker** to start immediately; no feature-specific login is required. Add positions manually to track interest, charges, adjusted buy price and P/L. Position details include transactions, statement reconciliation, projections and audit history. Exit dates are optional when editing; closed and converted positions are excluded from open totals.

Portfolios are stored in an encrypted database, with an automatic workspace identified by a persistent browser cookie. Existing signed-in sessions retain their portfolios. Clearing cookies or switching browsers creates a separate workspace; app-wide login/signup will be added later. Local databases and generated keys live in ignored `.data/`; preserve both. Hosted deployments require PostgreSQL, HTTPS and a stable encryption key. Kite snapshots require review before creating lots and never place broker orders. CSV import is not part of the current UI.

## NSE futures rollover

Open **Futures rollover** or **/rollovers**. The API downloads official NSE final UDiFF F&O and cash reports for six completed monthly snapshots, plus one prior month for comparisons. It validates matching dates, exact contract expiries, schema and OI units, then calculates rollover %, futures–spot basis, true next–near spread, MoM changes and historical averages. No demo records are served.

Normalized reports, SHA-256 hashes, source URLs, row diagnostics and monthly results persist in the configured application database. Downloads start when the API starts and retry every six hours; **Refresh NSE reports** runs another backfill. To populate before opening the app:

```bash
npm run rollovers:sync
```

Set `ROLLOVER_AUTO_SYNC=false` to disable background fetching. Use your existing database environment variables for the CLI as well as the server; root .env files require explicit loading. Report access failures remain visible in Source status and never fall back to fabricated data.

These are historical final reports, not live ticks. The approved calendar currently covers 2026 and requires an update for later years. Scrips with ambiguous adjusted expiries or missing contracts remain under review and leave aggregate calculations. Sectors come from NSE's current Nifty 500 constituent list (Industry column), refreshed weekly and applied to every month; scrips outside it are Unclassified. Months already imported from final reports are not re-downloaded unless you press refresh. Spot MoM uses unadjusted cash closes. Check NSE data-use permissions before public redistribution; raw archives are not committed.

## Checks

```bash
npm test                         # Domain and API tests using synthetic data
npm run typecheck
npm run build                    # Web assets in apps/web/dist
npx playwright install chromium  # First browser-test setup
npm run test:e2e
```

Set `MTF_TEST_DATABASE_URL` to a **disposable test database** to include PostgreSQL integration coverage. Tests may display Node's experimental SQLite/TypeScript warnings.

## Project layout

- `apps/web/` — React dashboard
- `apps/api/` — HTTP API, market-data adapters, authentication and persistence
- `packages/core/` — Shared calculations and domain models
- `tests/e2e/` — Browser tests
- `docs/` — Architecture, specifications, roadmap and data policy
- `Dockerfile`, `compose.yaml`, `deploy/` — Hosted deployment configuration

## Data and limitations

Research market data defaults to synthetic demo data. The free NSE MTF quote adapter is informational/non-commercial and may return delayed or end-of-day prices; it is not a guaranteed real-time feed. Commercial use requires appropriate data licensing.

Manual inputs and estimated charges remain unverified until reconciled with supporting records. Scenarios and backtests are hypothetical. The thesis journal stays in browser storage; MTF portfolios use server storage. TradeLens does not execute broker orders or provide investment advice.
